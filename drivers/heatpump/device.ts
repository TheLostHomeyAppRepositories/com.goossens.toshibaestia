import Homey from 'homey';
import type ToshibaEstiaApp from '../../app';
import type { ModbusEndpoint } from '../../modbus/types';
import {
  REGISTERS,
  NO_SENSOR_VALUE,
  decodeAlarmCode,
  decodeAlarmDetail,
  decodeAlarmUnit,
  decodeBaudRate,
  decodeHydroUnitType,
} from '../../modbus/registers';
import {
  HISTORY_HOURS,
  averageOutdoor,
  hoursMeasured,
  nextSeason,
  validSeasonConfig,
  type HourlyTemp,
  type Season,
  type SeasonConfig,
} from './season';
import {
  PowerEstimator,
  RefrigerantSensorCheck,
  compressorCm3FromCurrent,
  compressionTempsC,
  energyKwh,
  type LearntState,
  type PowerConfig,
  type PowerSample,
  type RefrigerantCheckState,
} from './power-model';
import { ExternalMeterLink, isMeterGone } from './external-meter';

type TempScaling = 'x1' | 'x10';
type ThermostatMode = 'off' | 'heat' | 'cool';

interface FaultEvent {
  /** ISO-8601 UTC timestamp captured at the rising edge of the alarm. */
  timestamp: string;
  /** Decoded hex string of the raw alarm-code register, e.g. "0x0003". */
  code: string;
  /** Decoded hydro-unit label from the alarm-unit register. */
  unit: string;
  /** Human-readable alarm description (e.g. "A03 — Temperature increase error (hot water)"). */
  description: string;
}

interface DeviceSettings {
  host: string;
  port: number;
  unitId: number;
  pollInterval: number;
  requestTimeout: number;
  tempScaling: TempScaling;
  enableZone2: boolean;
  enableDhw: boolean;
  // Energy estimation (see power-model.ts). Cylinder immersion is auto-detected
  // from register 40039 (delta-hours): Toshiba only ships the 2.75 kW HWS-CSHM3-E
  // cylinder immersion, and only on split installs where the installer wires it.
  modelKey?: string;
  backupHeaterKW?: string;     // dropdown: "0" | "3" | "6" | "9"
  tankLitres?: number;         // hot water tank volume, used to learn the water flow
  flowLpm?: number;            // water flow set by the user; 0 = learn it
  ctCurrentA?: number;         // calibration: CT current read on the remote during a run
  sgHeaterAllowed?: boolean;   // DN 6CE = 0: backup heater allowed in SG Ready "System Forced ON"
  lastCalibration?: string;    // read-only: the latest calibration and its operating point
  powerStatus?: string;
  externalMeter?: string;       // read-only: the linked meter (repair / app settings page)        // read-only: flow in use + how the compressor is detected
  detectedSeries?: string;
  detectedSlaveAddress?: string;
  detectedBaudRate?: string;
  lastSeen?: string;
  // Season detection (see season.ts). Optional: devices paired before 1.1.0
  // may not have them yet, so seasonConfig() falls back to the defaults.
  seasonAuto?: boolean;
  seasonDays?: number;
  summerStart?: number;
  summerEnd?: number;
  winterStart?: number;
  winterEnd?: number;
  seasonHours?: string;
}

const SEASON_SETTINGS = ['seasonAuto', 'seasonDays', 'summerStart', 'summerEnd', 'winterStart', 'winterEnd'];

const seasonConfig = (s: DeviceSettings): SeasonConfig => ({
  days: Number(s.seasonDays ?? 3),
  summerStart: Number(s.summerStart ?? 24),
  summerEnd: Number(s.summerEnd ?? 22),
  winterStart: Number(s.winterStart ?? 14),
  winterEnd: Number(s.winterEnd ?? 16),
});

/**
 * Toshiba Estia models: rated heating capacity and electrical input (kW) at A7/W35
 * from Toshiba's datasheets (R32 S1/S2, R410A S4, S5, Hi Power), and the outdoor
 * unit code of the R32 Engineering Data Book tables in data/r32-tables.json. Models
 * with tables get the part-load model; the others their rated COP, shaped over
 * outdoor and water temperature (power-model.ts).
 *
 * compressorCm3: the frequency model's constant = compressor displacement ÷ overall
 * efficiency. Displacements from the service manual's parts list (Toshiba's model number
 * is the displacement in 0.1 cm³): DX150 (401/601) 15.0, NX220 (801/1101 1-phase) 22.0,
 * DX380 / RX380 (1401, and the 3-phase H8W units) 38.0 cm³. Efficiency 0.77, measured
 * on an 1101 HW with a power meter (Shelly Pro EM-50, 2026-10-13: hot water at 28–80 Hz
 * and floor heating, ±4 % per steady poll) with the condensing temperature of
 * compressionTempsC() and the aux draw below counted apart (AGENTS.md § 7). Before
 * 2026-10-14: 0.75 against TC alone, which read 20–30 % low in floor heating. R410A units
 * only get it by calibration (ctCurrentA).
 *
 * aux: the unit's own draw, from the ErP tables (installation manual 2F30151001_05
 * p. 37–39): standbyW = P_SB, runAuxW = P_TO − P_SB (water pump and outdoor fan), preheatW =
 * compressor-winding preheat in frost (service manual AE0-2101W p. 104: 40 W single-phase,
 * 50 W three-phase). Measured on an 1101 HW (Shelly Pro EM-50, 2026-10-12…14) with the
 * Modbus interface, a Modbus gateway and an SG relay on the same breaker: ~12 W idle (P_SB
 * 7 W + those), but ~83 % of the time ~26.5 W — a 14.5 W load that switches for hours with
 * no register changing, cause unknown, so not counted (AGENTS.md § 7). ~47 W with only the
 * pump running. R410A units: no ErP data at hand, so the R32 11 kW values (DEFAULT_AUX).
 *
 * NOTE: backup heater wattage is NOT here — it's an installation choice
 * (3/6/9 kW typically) and lives in its own settings dropdown.
 */
interface Aux { standbyW: number; runAuxW: number; preheatW: number }
const aux = (pSbW: number, pToW: number, preheatW: number): Aux => ({ standbyW: pSbW, runAuxW: pToW - pSbW, preheatW });
const AUX_401_601 = aux(8, 40, 40);
const AUX_801_1101 = aux(7, 49, 40);
const AUX_1401 = aux(11, 52, 40);
const AUX_3PH = aux(11, 52, 50);
const DEFAULT_AUX = AUX_801_1101;
const MODEL_PRESETS: Record<string, { capacityKw: number; heatInputKw: number; tables?: string; compressorCm3?: number; aux?: Aux }> = {
  // R32 1 Series (F21 indoor) and 2 Series (S21 indoor) share the same outdoor
  // units (HWT-_HW-E codes) and the same compressor → identical input ratings.
  // One entry per kW class; covers both generations.
  'r32-s1-401':   { capacityKw: 4,   heatInputKw: 0.77, tables: '401', compressorCm3: 19.5, aux: AUX_401_601 },  // outdoor HWT-401HW-E, DX150
  'r32-s1-601':   { capacityKw: 6,   heatInputKw: 1.25, tables: '601', compressorCm3: 19.5, aux: AUX_401_601 },  // outdoor HWT-601HW-E, DX150
  'r32-s1-801':   { capacityKw: 8,   heatInputKw: 1.54, tables: '801', compressorCm3: 28.6, aux: AUX_801_1101 },  // outdoor HWT-801HW-E, NX220
  'r32-s1-1101':  { capacityKw: 11,  heatInputKw: 2.39, tables: '1101', compressorCm3: 28.6, aux: AUX_801_1101 }, // outdoor HWT-1101HW-E (e.g. F21SM3 / S21SM3), NX220
  'r32-s1-801-3ph':  { capacityKw: 8,  heatInputKw: 1.54, tables: '801', compressorCm3: 49.4, aux: AUX_3PH },  // outdoor HWT-801H8W-E, RX380
  'r32-s1-1101-3ph': { capacityKw: 11, heatInputKw: 2.39, tables: '1101', compressorCm3: 49.4, aux: AUX_3PH }, // outdoor HWT-1101H8W-E, RX380
  'r32-s1-1401':  { capacityKw: 14,  heatInputKw: 3.04, compressorCm3: 49.4, aux: AUX_1401 }, // outdoor HWT-1401H(8)W-E, DX380 / RX380 (not in the Data Book tables); preheat 40 W (H8W: 50 W)
  // R410A Series 5 (2017-2021)
  'r410a-s5-455': { capacityKw: 4.5, heatInputKw: 0.92 },
  'r410a-s5-805': { capacityKw: 8,   heatInputKw: 1.79 },
  'r410a-s5-1105':{ capacityKw: 11,  heatInputKw: 2.30 },
  'r410a-s5-1405':{ capacityKw: 14,  heatInputKw: 3.11 },
  'r410a-s5-1605':{ capacityKw: 16,  heatInputKw: 3.78 },
  // R410A Hi Power (high-temperature flow)
  'r410a-hp-805': { capacityKw: 8,   heatInputKw: 1.71 },
  'r410a-hp-1105':{ capacityKw: 11,  heatInputKw: 2.30 },
  'r410a-hp-1405':{ capacityKw: 14,  heatInputKw: 3.16 },
  // R410A Series 4 (legacy, 2014-2017)
  'r410a-s4-803': { capacityKw: 8,   heatInputKw: 1.90 },
  'r410a-s4-1103':{ capacityKw: 11,  heatInputKw: 2.69 },
  'r410a-s4-1403':{ capacityKw: 14,  heatInputKw: 3.40 },
  'r410a-s4-1603':{ capacityKw: 16,  heatInputKw: 3.95 },
};
const DEFAULT_MODEL = 'r32-s1-1101';
/** Toshiba's only cylinder immersion: the HWS-CSHM3-E element. */
const IMMERSION_KW = 2.75;
/** Toshiba backup heaters come in 3 kW stages (3 / 6 / 9 kW). */
const BACKUP_STEP_KW = 3;
/** Rated flow: the rated capacity at the rating's 5 K water ΔT. */
const RATED_DELTA_T_K = 5;
/** Settings that change the power estimate. */
const POWER_SETTINGS = ['modelKey', 'backupHeaterKW', 'tankLitres', 'flowLpm', 'enableDhw'];
/** Undocumented R32 registers read on their own: TC (40021) … compressor Hz (40032). */
const UNDOCUMENTED_REGISTERS = Array.from({ length: 12 }, (_, i) => REGISTERS.condensingTemp.number + i);

/**
 * Feature-gated capabilities. NEVER list these in driver.compose.json.
 * See AGENTS.md — "Feature-gated capabilities — the one rule that's easy to get wrong".
 */
/**
 * Zone 2 capabilities stay feature-gated (dynamically added/removed) because
 * many installs are single-zone and we want to avoid Insights orphans.
 *
 * DHW capabilities moved to the manifest `capabilities` array — Homey only
 * honours `capabilitiesOptions.title` overrides (including "Ingestelde
 * warmwatertemperatuur" vs the Zone 1 "Ingestelde temperatuur") for caps
 * declared at pair time. A tiny trade-off: turning DHW off in settings after
 * pairing removes the caps and orphans their Insights. Re-pair cleans up.
 */
const OPTIONAL_CAPABILITIES = {
  zone2: [
    'measure_temperature.zone2',
    'target_temperature.zone2',
  ] as const,
  dhw: [
    // NOTE: these are declared in the manifest `capabilities` array so titles
    // render correctly at pair time. This array stays here so that flipping
    // enableDhw=off in device settings still strips them from the UI.
    'measure_temperature.tank_water',
    'measure_temperature.water_heater_outlet',
    'onoff.hotwater',
    'target_temperature.tank_water',
    'boost_hotwater',
    'antibacteria',
  ] as const,
};

/**
 * Capabilities that were part of earlier versions but have been replaced.
 * Removed from every device on onInit so they don't linger and clash with the
 * new ones. Insights history may remain — clean manually if desired.
 */
const DEPRECATED_CAPABILITIES: string[] = [
  'dhw_setpoint',   // reverted to target_temperature.tank_water
  'zone2_setpoint', // reverted to target_temperature.zone2
  // Per-mode kWh sub-meters dropped in favour of one total + live measure_power
  'meter_power.heating',
  'meter_power.cooling',
  'meter_power.dhw',
  'meter_power.backup',
  'meter_power.immersion',
];

/**
 * Titles applied on every onInit for standard capabilities already declared
 * in driver.compose.json. Homey only applies manifest options at device
 * creation; existing devices need this reapply to pick up label changes.
 */
const MANIFEST_CAPABILITY_OPTIONS: Record<string, Record<string, unknown>> = {
  'measure_temperature':           { title: { en: 'Zone 1 temperature',  nl: 'Zone 1 temperatuur' } },
  'measure_temperature.outdoor':   { title: { en: 'Outdoor temperature', nl: 'Buitentemperatuur' } },
  'measure_temperature.water_inlet':  { title: { en: 'Water inlet (TWI)',  nl: 'Retourtemperatuur (TWI)' } },
  'measure_temperature.water_outlet': { title: { en: 'Water outlet (TWO)', nl: 'Aanvoertemperatuur (TWO)' } },
  'alarm_generic':                 { title: { en: 'Heat pump alarm',     nl: 'Warmtepomp alarm' } },
};

/** Power capability titles: measured by a linked meter, or estimated by the power model. */
const MEASURED_TITLES = {
  power: { en: "Measured power", nl: "Gemeten vermogen", da: "Målt effekt", de: "Gemessene Leistung", es: "Potencia medida", fr: "Puissance mesurée", it: "Potenza misurata", no: "Målt effekt", sv: "Uppmätt effekt", pl: "Zmierzona moc", ru: "Измеренная мощность", ko: "측정된 전력", ar: "القدرة المقيسة" },
  energy: { en: "Measured total energy", nl: "Gemeten totale energie", da: "Målt samlet energi", de: "Gemessene Gesamtenergie", es: "Energía total medida", fr: "Énergie totale mesurée", it: "Energia totale misurata", no: "Målt total energi", sv: "Uppmätt total energi", pl: "Zmierzona całkowita energia", ru: "Измеренная общая энергия", ko: "측정된 총 에너지", ar: "إجمالي الطاقة المقيسة" },
};
const ESTIMATED_TITLES = {
  power: { en: "Estimated power", nl: "Geschat vermogen", da: "Anslået strømforbrug", de: "Geschätzte Leistung", es: "Potencia estimada", fr: "Puissance estimée", it: "Potenza stimata", no: "Estimert strømforbruk", sv: "Uppskattad effekt", pl: "Szacowana moc", ru: "Оценочная мощность", ko: "예상 전력", ar: "الطاقة المقدرة" },
  energy: { en: "Estimated total energy", nl: "Geschatte totale energie", da: "Anslået samlet energi", de: "Geschätzter Gesamtenergieverbrauch", es: "Energía total estimada", fr: "Énergie totale estimée", it: "Energia totale stimata", no: "Estimert total energi", sv: "Uppskattad total energi", pl: "Szacowana całkowita energia", ru: "Оценочная общая энергия", ko: "예상 총 에너지", ar: "إجمالي الطاقة المقدرة" },
};

/** Titles and metadata applied on every onInit for each dynamic capability.
 *  Always supply nl + en; Homey falls back to its built-in localized title for
 *  standard capabilities (target_temperature etc.) if nl isn't provided. */
const OPTIONAL_CAPABILITY_OPTIONS: Record<string, Record<string, unknown>> = {
  'measure_temperature.zone2':               { title: { en: 'Zone 2 temperature', nl: 'Zone 2 temperatuur' } },
  'target_temperature.zone2':                { title: { en: 'Zone 2 target',      nl: 'Zone 2 instelpunt' }, min: 5,  max: 60, step: 0.5 },
  'measure_temperature.tank_water':          { title: { en: 'Hot water tank',     nl: 'Warmwatertank' } },
  'measure_temperature.water_heater_outlet': { title: { en: 'Heater outlet',      nl: 'Verwarmingsuitgang' } },
  'onoff.hotwater':                          { title: { en: 'Hot water',          nl: 'Warm water' } },
  'target_temperature.tank_water':           { title: { en: 'Hot water target',   nl: 'Warmwater instelpunt' }, min: 30, max: 75, step: 0.5 },
  'boost_hotwater':                          { title: { en: 'Hot water boost',    nl: 'Warm water boost' } },
  'antibacteria':                            { title: { en: 'Anti-bacteria cycle',nl: 'Anti-legionella' } },
};

/**
 * Always-on capabilities added to the manifest over time. Listed here so that
 * devices paired before a given capability existed pick it up on onInit.
 * Used only to ADD; never to remove.
 */
const ALWAYS_ON_CAPABILITIES: Array<[string, Record<string, unknown>?]> = [
  ['onoff',            { title: { en: 'Heat pump',      nl: 'Warmtepomp' } }],
  ['thermostat_mode',  { title: { en: 'Mode',           nl: 'Modus' }, values: [
    { id: 'off',  title: { en: 'Off',  nl: 'Uit' } },
    { id: 'heat', title: { en: 'Heat', nl: 'Verwarmen' } },
    { id: 'cool', title: { en: 'Cool', nl: 'Koelen' } },
  ] }],
  ['target_temperature',{ title: { en: 'Zone 1 target', nl: 'Zone 1 instelpunt' }, min: 5, max: 60, step: 0.5 }],
  ['fault_code',       { title: { en: 'Fault code',     nl: 'Foutcode' } }],
  ['last_fault',       { title: { en: 'Last fault',     nl: 'Laatste fout' } }],
  ['frost_protection', { title: { en: 'Frost protection', nl: 'Vorstbeveiliging' } }],
  ['night_setback',    { title: { en: 'Night setback',    nl: 'Nachtverlaging' } }],
  ['auto_temp',        { title: { en: 'Auto temperature', nl: 'Auto-temperatuur' } }],
  // Energy estimation
  // isApproximated: Homey's flag for "the device has no power meter, the driver calculates it".
  ['measure_power',         { title: { en: 'Estimated power',         nl: 'Geschat vermogen' }, isApproximated: true }],
  ['meter_power',           { title: { en: 'Estimated total energy',  nl: 'Geschatte totale energie' }, isApproximated: true }],
  // Season detection (1.1.0)
  ['measure_temperature.outdoor_avg', { title: {
    en: 'Average outdoor temperature', nl: 'Gemiddelde buitentemperatuur', da: 'Gennemsnitlig udetemperatur',
    de: 'Durchschnittliche Außentemperatur', es: 'Temperatura exterior media', fr: 'Température extérieure moyenne',
    it: 'Temperatura esterna media', no: 'Gjennomsnittlig utetemperatur', sv: 'Genomsnittlig utomhustemperatur',
    pl: 'Średnia temperatura zewnętrzna', ru: 'Средняя температура на улице', ko: '평균 실외 온도',
    ar: 'متوسط درجة الحرارة الخارجية',
  } }],
  ['season'],
  // External meter (1.2.0): maintenance action, options from the manifest
  ['button.test_meter'],
];

/** Registers always polled, independent of optional features. */
const ALWAYS_ON_REGISTERS = [
  REGISTERS.zone1OnOff.number,
  REGISTERS.operationMode.number,
  REGISTERS.zone1SetpointTemp.number,
  REGISTERS.zone1ControlTemp.number,
  REGISTERS.outdoorTemp.number,
  REGISTERS.waterInletTemp.number,
  REGISTERS.waterOutletTemp.number,
  REGISTERS.heaterOutletTemp.number,
  REGISTERS.alarmStatus.number,
  REGISTERS.alarmCode.number,
  REGISTERS.alarmUnit.number,
  REGISTERS.autoTempOnOff.number,
  REGISTERS.nightSetbackOnOff.number,
  REGISTERS.frostProtectionOnOff.number,
  // Cylinder immersion hours: ticking proves an immersion is wired (power estimate)
  REGISTERS.immersionHeaterHours.number,
  // Backup heater hours: the power estimate books heater time it missed (reconcileHeaterHours)
  REGISTERS.backupHeaterHours.number,
] as const;

/** Registers polled only when Zone 2 is installed. */
const ZONE2_REGISTERS = [
  REGISTERS.zone2ControlTemp.number,
  REGISTERS.zone2SetpointTemp.number,
] as const;

/** Registers polled only when DHW is installed. */
const DHW_REGISTERS = [
  REGISTERS.dhwTankTemp.number,
  REGISTERS.hotWaterOnOff.number,
  REGISTERS.dhwSetpointTemp.number,
  REGISTERS.hotWaterBoostOnOff.number,
  REGISTERS.antibacteriaOnOff.number,
  REGISTERS.hotWaterBoostSetpoint.number,
] as const;

export default class HeatpumpDevice extends Homey.Device {
  private pollTimer: NodeJS.Timeout | null = null;
  private probeOnNextPoll = true;
  private limitsApplied = false;
  private dhwBoostOffTimer: NodeJS.Timeout | null = null;
  private lastAlarmActive = false;
  private lastImmersionHours: number | null = null;
  // Power estimate (power-model.ts); created in onInit from the settings and store.
  private power!: PowerEstimator;
  private refrigerantCheck!: RefrigerantSensorCheck;
  private lastPower: { watts: number; timeMs: number } | null = null;
  /** Meter linked on the app settings page; while usable it replaces the estimate. */
  private meterLink: ExternalMeterLink | null = null;
  /** True while the linked meter device no longer exists; shown as device warning. */
  private meterMissing = false;
  private meterOpenedMs = 0;
  private lastPowerSample: PowerSample | null = null;
  // Heater-hours reconciliation: the heater time counted since the counter last ticked, and
  // how much of that period the app was actually polling (gaps over 5 min don't count).
  private heaterHours: { value: number; sinceMs: number; countedS: number; coveredS: number } | null = null;
  private meterKwh = 0;
  // Consecutive failed reads of the undocumented registers; after three they're left alone until an app restart.
  private undocumentedFailures = 0;
  private refrigerantCheckSavedMs = 0;
  // Outdoor samples of the current hour; stored as one hourly average when the hour ends.
  private outdoorHour: { hour: number; sum: number; count: number } | null = null;

  private get app(): ToshibaEstiaApp {
    return this.homey.app as ToshibaEstiaApp;
  }

  private getDeviceSettings(): DeviceSettings {
    return this.getSettings() as DeviceSettings;
  }

  private endpointFromSettings(s: DeviceSettings): ModbusEndpoint {
    return {
      host: s.host,
      port: Number(s.port),
      unitId: Number(s.unitId),
      timeoutMs: Number(s.requestTimeout),
    };
  }

  async onInit(): Promise<void> {
    const settings = this.getDeviceSettings();
    this.log(`Init ${this.getName()} @ ${settings.host}:${settings.port}#${settings.unitId}, poll=${settings.pollInterval}s`);

    await this.syncOptionalCapabilities(settings);
    this.registerCapabilityListeners();
    this.initPower(settings);
    this.applyExternalMeter().catch((err) => this.error('applyExternalMeter', err));
    await this.updateSeason(settings).catch((err) => this.error('updateSeason', err));

    // Restore the last-fault display from persistent store so users see the
    // most recent alarm even after Homey or the app restarts. Re-decode the
    // raw hex on every restore so historical entries pick up improvements to
    // decodeAlarmCode (e.g. the bit-mask handling added in 1.0.24).
    if (this.hasCapability('last_fault')) {
      try {
        const history = this.getStoreValue('faultHistory') as FaultEvent[] | null;
        if (history && history.length > 0) {
          const latest = history[0];
          const rawCode = parseInt(latest.code.replace(/^0x/i, ''), 16);
          const description = Number.isFinite(rawCode)
            ? decodeAlarmCode(rawCode)
            : latest.description;
          const detail = Number.isFinite(rawCode) ? decodeAlarmDetail(rawCode) : null;
          const headline = `${latest.timestamp.slice(0, 16).replace('T', ' ')} · ${description}`;
          const display = detail ? `${headline}\n\n${detail}` : headline;
          await this.setCapabilityValue('last_fault', display).catch(() => undefined);
        } else {
          await this.setCapabilityValue('last_fault', 'No faults recorded yet').catch(() => undefined);
        }
      } catch (err) { this.error('restore last_fault', err); }
    }

    this.schedulePolling(settings.pollInterval);
    // First poll immediately
    this.homey.setTimeout(() => this.pollOnce(), 250);
  }

  async onUninit(): Promise<void> {
    this.clearPolling();
    this.closeExternalMeter();
    if (this.dhwBoostOffTimer) {
      this.homey.clearTimeout(this.dhwBoostOffTimer);
      this.dhwBoostOffTimer = null;
    }
  }

  async onDeleted(): Promise<void> {
    this.clearPolling();
    this.closeExternalMeter();
  }

  /** The meter linked on the app settings page, or null for the estimate. */
  public getExternalMeterId(): string | null {
    return (this.getStoreValue('externalMeterId') as string | null) ?? null;
  }

  /** State of the linked meter for the app settings page. */
  public getExternalMeterState(): { name: string | null; missing: boolean; watts: number | null } {
    const link = this.meterLink;
    return { name: link?.name ?? null, missing: this.meterMissing, watts: link?.usable ? link.watts : null };
  }

  /** Links a meter (any Homey device with measure_power) or unlinks it with null. */
  public async setExternalMeter(meterId: string | null): Promise<void> {
    await this.setStoreValue('externalMeterId', meterId);
    await this.applyExternalMeter();
  }

  private closeExternalMeter(): void {
    this.meterLink = null;
  }

  /**
   * Re-reads the linked meter through the Web API (once per poll). A meter that could not be
   * opened is retried every 5 minutes; the estimate is used meanwhile.
   */
  private async refreshExternalMeter(): Promise<void> {
    const link = this.meterLink;
    if (!link) {
      if (this.getExternalMeterId() && Date.now() - this.meterOpenedMs >= 5 * 60_000) await this.applyExternalMeter();
      return;
    }
    try {
      const api = await this.app.getHomeyApi();
      link.update(await api.devices.getDevice({ id: link.meterId }));
      await this.setMeterMissing(false);
    } catch (err) {
      if (link.available) this.error(`External meter ${link.name} could not be read`, err);
      link.markUnavailable();
      await this.setMeterMissing(isMeterGone(err));
    }
  }

  /** Device warning while the linked meter no longer exists (removed or paired again). */
  private async setMeterMissing(missing: boolean): Promise<void> {
    if (missing === this.meterMissing) return;
    this.meterMissing = missing;
    await (missing ? this.setWarning(this.homey.__('power.meter_missing')) : this.unsetWarning())
      .catch((err) => this.error('meter warning', err));
    if (missing) await this.setSettings({ externalMeter: this.homey.__('settings.meter_missing_option') }).catch(() => undefined);
  }

  /** Maintenance action: reads the meter now and shows the result, or throws why it fails. */
  private async testExternalMeter(): Promise<void> {
    if (!this.getExternalMeterId()) throw new Error(this.homey.__('power.test_no_meter'));
    if (this.meterLink) await this.refreshExternalMeter();
    else await this.applyExternalMeter();
    if (this.meterMissing) throw new Error(this.homey.__('power.meter_missing'));
    const link = this.meterLink;
    if (!link?.usable) throw new Error(this.homey.__('power.test_unavailable', { name: link?.name ?? '?' }));
    const time = new Date().toLocaleTimeString(this.homey.i18n.getLanguage(), {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    });
    const values = [`${Math.round(link.watts as number)} W`];
    if (link.kwh !== null) values.push(`${link.kwh.toFixed(2)} kWh`);
    await this.setSettings({ externalMeter: `${link.name} · ${values.join(', ')} (${this.homey.__('power.tested', { time })})` });
  }

  /** Opens the linked meter through Homey's Web API and marks power as measured or estimated. */
  private async applyExternalMeter(): Promise<void> {
    this.closeExternalMeter();
    this.meterOpenedMs = Date.now();
    const meterId = this.getExternalMeterId();
    let missing = false;
    if (meterId) {
      try {
        const api = await this.app.getHomeyApi();
        this.meterLink = new ExternalMeterLink(meterId, await api.devices.getDevice({ id: meterId }));
        this.log(`External meter linked: ${this.meterLink.name} (${this.meterLink.energyCapability ?? 'power only'})`);
      } catch (err) {
        this.error('External meter could not be opened', err);
        missing = isMeterGone(err);
      }
    }
    await this.applyPowerCapabilityOptions(this.meterLink !== null);
    let externalMeter = this.homey.__('settings.meter_none');
    if (missing) externalMeter = this.homey.__('settings.meter_missing_option');
    else if (meterId) externalMeter = this.meterLink?.name ?? this.homey.__('power.meter_unavailable', { name: '?' });
    await this.setSettings({ externalMeter }).catch((err) => this.error('setSettings externalMeter', err));
    // Re-evaluated on every open, so unlinking or relinking clears the warning.
    this.meterMissing = !missing;
    await this.setMeterMissing(missing);
  }

  /** Titles and Homey's isApproximated flag follow whether power is measured or estimated. */
  private async applyPowerCapabilityOptions(measured: boolean): Promise<void> {
    const options: Array<[string, Record<string, string>]> = measured
      ? [['measure_power', MEASURED_TITLES.power], ['meter_power', MEASURED_TITLES.energy]]
      : [['measure_power', ESTIMATED_TITLES.power], ['meter_power', ESTIMATED_TITLES.energy]];
    for (const [capability, title] of options) {
      if (!this.hasCapability(capability)) continue;
      await this.setCapabilityOptions(capability, { title, isApproximated: !measured })
        .catch((err) => this.error(`setCapabilityOptions ${capability}`, err));
    }
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<string | void> {
    const s = newSettings as unknown as DeviceSettings;
    this.log('Settings changed:', changedKeys.join(', '));

    if (changedKeys.some((key) => SEASON_SETTINGS.includes(key))) {
      if (!validSeasonConfig(seasonConfig(s))) throw new Error(this.homey.__('error.season_order'));
      // After the new settings are saved: updateSeason() writes a setting itself.
      this.homey.setTimeout(() => {
        this.updateSeason(this.getDeviceSettings()).catch((err) => this.error('updateSeason', err));
      }, 500);
    }

    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      const old = this.getDeviceSettings();
      await this.app.modbus.disconnect(old.host, Number(old.port));
      this.probeOnNextPoll = true;
      this.limitsApplied = false;
    }

    if (changedKeys.includes('enableZone2') || changedKeys.includes('enableDhw')) {
      await this.syncOptionalCapabilities(s);
      this.registerCapabilityListeners();
      this.limitsApplied = false;
    }

    if (changedKeys.includes('pollInterval')) {
      this.schedulePolling(Number(s.pollInterval));
    }

    if (changedKeys.includes('modelKey')) {
      // A calibration belongs to the compressor it was made on.
      await this.unsetStoreValue('compressorCm3');
    }
    if (changedKeys.includes('ctCurrentA') && Number(s.ctCurrentA) > 0) {
      await this.calibrateFromCurrent(Number(s.ctCurrentA), s);
      this.homey.setTimeout(() => {
        this.setSettings({ ctCurrentA: 0 }).catch((err) => this.error('setSettings ctCurrentA', err));
      }, 500);
    }

    if (changedKeys.includes('tankLitres')) {
      // Learnt flows scale with the tank volume they were learnt with: start over.
      await this.setStoreValue('powerLearnt', null);
      this.power = new PowerEstimator(this.powerConfig(s));
    } else if (changedKeys.some((key) => POWER_SETTINGS.includes(key))) {
      this.power.setConfig(this.powerConfig(s));
    }

    this.homey.setTimeout(() => this.pollOnce(), 250);
  }

  /** Ensure presence / absence of every feature-gated capability and apply their options. */
  private async syncOptionalCapabilities(s: DeviceSettings): Promise<void> {
    // Strip deprecated caps first so they can't clash with successors.
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (err) { this.error(`removeCapability ${cap} (deprecated)`, err); }
      }
    }

    /*
     * One-time migration: target_temperature.tank_water / .zone2 gained
     * uiComponent: "slider" in the manifest to break the thermostat pair.
     * setCapabilityOptions cannot change uiComponent at runtime, so the only
     * way to apply it to already-paired devices is to remove + re-add so
     * Homey rebuilds the capability from the current manifest.
     */
    /*
     * 1.1.0 test builds had `season` as a setable picker, sharing Homey's
     * picker component with thermostat_mode — opening the device page then
     * set the season. It's read-only now; re-add it so existing devices pick
     * up the new uiComponent, keeping its value.
     */
    if (!this.getStoreValue('_seasonReadOnly_v1')) {
      if (this.hasCapability('season')) {
        const season = this.getCapabilityValue('season');
        try {
          await this.removeCapability('season');
          await this.addCapability('season');
          if (season) await this.setCapabilityValue('season', season);
        } catch (err) { this.error('migration: re-add season', err); }
      }
      try { await this.setStoreValue('_seasonReadOnly_v1', true); } catch (err) { this.error('migration flag set', err); }
    }

    const migrationFlag = '_noShadowMigration_v3';
    if (!this.getStoreValue(migrationFlag)) {
      // Remove + re-add so caps pick up the current manifest capabilitiesOptions
      // (including per-sub-cap title overrides). setCapabilityOptions alone
      // doesn't refresh inherited parent-capability settings reliably.
      for (const cap of ['target_temperature', 'target_temperature.tank_water', 'target_temperature.zone2']) {
        if (this.hasCapability(cap)) {
          try {
            await this.removeCapability(cap);
            this.log(`migration: removed ${cap} for manifest-title refresh`);
          } catch (err) {
            this.error(`migration: remove ${cap}`, err);
          }
        }
      }
      try { await this.setStoreValue(migrationFlag, true); } catch (err) { this.error('migration flag set', err); }
    }

    const ensure = async (enabled: boolean, caps: readonly string[]) => {
      for (const cap of caps) {
        const has = this.hasCapability(cap);
        if (enabled && !has) {
          try { await this.addCapability(cap); } catch (err) { this.error(`addCapability ${cap}`, err); }
        } else if (!enabled && has) {
          try { await this.removeCapability(cap); } catch (err) { this.error(`removeCapability ${cap}`, err); }
        }
      }
    };
    await ensure(s.enableZone2, OPTIONAL_CAPABILITIES.zone2);
    await ensure(s.enableDhw, OPTIONAL_CAPABILITIES.dhw);

    // Always-on caps may be missing for devices paired before a given cap was added.
    for (const [cap] of ALWAYS_ON_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); } catch (err) { this.error(`addCapability ${cap}`, err); }
      }
    }

    // Apply titles + min/max on EVERY onInit so devices paired before a given
    // option was added pick up the new labels. Idempotent: setCapabilityOptions
    // is a no-op when the options already match.
    for (const [cap, opts] of ALWAYS_ON_CAPABILITIES) {
      if (opts && this.hasCapability(cap)) {
        try { await this.setCapabilityOptions(cap, opts); } catch (err) { this.error(`setCapabilityOptions ${cap}`, err); }
      }
    }
    for (const cap of [...OPTIONAL_CAPABILITIES.zone2, ...OPTIONAL_CAPABILITIES.dhw]) {
      const opts = OPTIONAL_CAPABILITY_OPTIONS[cap];
      if (opts && this.hasCapability(cap)) {
        try { await this.setCapabilityOptions(cap, opts); } catch (err) { this.error(`setCapabilityOptions ${cap}`, err); }
      }
    }
    // Standard Homey sub-capabilities from the manifest also need runtime reapply
    // for devices paired before a title was added.
    for (const [cap, opts] of Object.entries(MANIFEST_CAPABILITY_OPTIONS)) {
      if (this.hasCapability(cap)) {
        try { await this.setCapabilityOptions(cap, opts); } catch (err) { this.error(`setCapabilityOptions ${cap}`, err); }
      }
    }
  }

  /** Wire every writable capability to its Modbus action. */
  private registerCapabilityListeners(): void {
    const endpoint = () => this.endpointFromSettings(this.getDeviceSettings());

    // onoff (Zone 1/2) — register 40001
    this.safeRegisterListener('onoff', async (value) => {
      await this.app.modbus.writeRegister(endpoint(), REGISTERS.zone1OnOff.number, value ? 1 : 0);
    });

    // thermostat_mode — composite of 40001 + 40003
    this.safeRegisterListener('thermostat_mode', async (value) => {
      const mode = value as ThermostatMode;
      if (mode === 'off') {
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.zone1OnOff.number, 0);
        await this.setCapabilityValue('onoff', false).catch(() => undefined);
      } else {
        const modeCode = mode === 'cool' ? 2 : 1;
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.operationMode.number, modeCode);
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.zone1OnOff.number, 1);
        await this.setCapabilityValue('onoff', true).catch(() => undefined);
      }
    });

    // target_temperature (Zone 1) — register 40004
    this.safeRegisterListener('target_temperature', async (value) => {
      await this.writeTemperature(REGISTERS.zone1SetpointTemp.number, Number(value));
    });

    // Feature modes
    this.safeRegisterListener('frost_protection', async (value) => {
      await this.app.modbus.writeRegister(endpoint(), REGISTERS.frostProtectionOnOff.number, value ? 1 : 0);
    });
    this.safeRegisterListener('night_setback', async (value) => {
      await this.app.modbus.writeRegister(endpoint(), REGISTERS.nightSetbackOnOff.number, value ? 1 : 0);
    });
    this.safeRegisterListener('auto_temp', async (value) => {
      await this.app.modbus.writeRegister(endpoint(), REGISTERS.autoTempOnOff.number, value ? 1 : 0);
    });

    // Optional Zone 2
    if (this.hasCapability('target_temperature.zone2')) {
      this.safeRegisterListener('target_temperature.zone2', async (value) => {
        await this.writeTemperature(REGISTERS.zone2SetpointTemp.number, Number(value));
      });
    }

    // Optional DHW
    if (this.hasCapability('onoff.hotwater')) {
      this.safeRegisterListener('onoff.hotwater', async (value) => {
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.hotWaterOnOff.number, value ? 1 : 0);
      });
    }
    if (this.hasCapability('target_temperature.tank_water')) {
      this.safeRegisterListener('target_temperature.tank_water', async (value) => {
        await this.writeTemperature(REGISTERS.dhwSetpointTemp.number, Number(value));
      });
    }
    if (this.hasCapability('boost_hotwater')) {
      this.safeRegisterListener('boost_hotwater', async (value) => {
        if (this.dhwBoostOffTimer) {
          this.homey.clearTimeout(this.dhwBoostOffTimer);
          this.dhwBoostOffTimer = null;
        }
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.hotWaterBoostOnOff.number, value ? 1 : 0);
      });
    }
    if (this.hasCapability('antibacteria')) {
      this.safeRegisterListener('antibacteria', async (value) => {
        await this.app.modbus.writeRegister(endpoint(), REGISTERS.antibacteriaOnOff.number, value ? 1 : 0);
      });
    }

    // Maintenance action: test the external meter
    this.safeRegisterListener('button.test_meter', async () => this.testExternalMeter());
  }

  /** Helper: idempotent capability listener registration. */
  private safeRegisterListener(id: string, fn: (value: unknown) => Promise<void>): void {
    try { this.registerCapabilityListener(id, fn); } catch (err) { this.error(`registerCapabilityListener ${id}`, err); }
  }

  /** Convert a user-facing temperature back to the raw register value, respecting x1/x10 scaling. */
  private async writeTemperature(regNumber: number, celsius: number): Promise<void> {
    const settings = this.getDeviceSettings();
    const endpoint = this.endpointFromSettings(settings);
    const raw = settings.tempScaling === 'x10' ? Math.round(celsius * 10) : Math.round(celsius);
    // Modbus expects 16-bit unsigned on the wire; convert two's-complement for negatives.
    const wire = raw < 0 ? raw + 0x10000 : raw;
    await this.app.modbus.writeRegister(endpoint, regNumber, wire);
  }

  /**
   * Trigger a DHW boost that automatically ends after `minutes`.
   * Called by the `dhw_boost_for` flow action.
   */
  public async startDhwBoostFor(minutes: number): Promise<void> {
    if (!this.hasCapability('boost_hotwater')) {
      throw new Error('DHW is disabled for this device (settings → Hot water tank installed).');
    }
    const endpoint = this.endpointFromSettings(this.getDeviceSettings());
    await this.app.modbus.writeRegister(endpoint, REGISTERS.hotWaterBoostOnOff.number, 1);
    await this.setCapabilityValue('boost_hotwater', true).catch(() => undefined);

    if (this.dhwBoostOffTimer) this.homey.clearTimeout(this.dhwBoostOffTimer);
    this.dhwBoostOffTimer = this.homey.setTimeout(async () => {
      try {
        await this.app.modbus.writeRegister(endpoint, REGISTERS.hotWaterBoostOnOff.number, 0);
        await this.setCapabilityValue('boost_hotwater', false).catch(() => undefined);
      } catch (err) {
        this.error('Auto turn-off DHW boost failed', err);
      } finally {
        this.dhwBoostOffTimer = null;
      }
    }, Math.max(1, minutes) * 60 * 1000);
  }

  /** Feed one outdoor reading; at each full hour, store that hour's average and re-check the season. */
  private async recordOutdoor(celsius: number | null): Promise<void> {
    if (celsius == null) return;
    const hour = Math.floor(Date.now() / 3600e3);
    const done = this.outdoorHour;
    if (done && done.hour !== hour) {
      this.outdoorHour = null;
      const history = ((this.getStoreValue('outdoorHourly') as HourlyTemp[] | null) ?? [])
        .filter(([h]) => h > hour - HISTORY_HOURS);
      history.push([done.hour, Math.round((done.sum / done.count) * 10) / 10]);
      await this.setStoreValue('outdoorHourly', history);
      await this.updateSeason(this.getDeviceSettings());
    }
    if (!this.outdoorHour) this.outdoorHour = { hour, sum: 0, count: 0 };
    this.outdoorHour.sum += celsius;
    this.outdoorHour.count += 1;
  }

  /** Show the outdoor average and, with automatic detection on, move the season along. */
  private async updateSeason(s: DeviceSettings): Promise<void> {
    const config = seasonConfig(s);
    const history = (this.getStoreValue('outdoorHourly') as HourlyTemp[] | null) ?? [];
    const nowHour = Math.floor(Date.now() / 3600e3);
    const avg = averageOutdoor(history, nowHour, config.days);
    const seasonHours = `${hoursMeasured(history, nowHour, config.days)} / ${config.days * 24}`;
    if (s.seasonHours !== seasonHours) await this.setSettings({ seasonHours }).catch((err) => this.error('setSettings seasonHours', err));
    if (this.hasCapability('measure_temperature.outdoor_avg')) {
      await this.setCapabilityValue('measure_temperature.outdoor_avg', avg == null ? null : Math.round(avg * 10) / 10);
    }
    if (avg == null || s.seasonAuto === false || !validSeasonConfig(config)) return;
    const current = (this.getCapabilityValue('season') as Season | null) ?? null;
    const season = nextSeason(current, avg, config);
    if (season !== current) {
      this.log(`Season ${current ?? '—'} → ${season} (${config.days}-day outdoor average ${avg.toFixed(1)} °C)`);
      await this.setSeason(season);
    }
  }

  /** Set the season and fire the season_changed trigger. */
  public async setSeason(season: Season): Promise<void> {
    if (!this.hasCapability('season') || this.getCapabilityValue('season') === season) return;
    await this.setCapabilityValue('season', season);
    await this.homey.flow.getDeviceTriggerCard('season_changed')
      .trigger(this, { season: this.homey.__(`season.${season}`) }, {})
      .catch((err) => this.error('season_changed trigger failed', err));
  }

  /** Power-model inputs from the device settings. */
  private powerConfig(s: DeviceSettings): PowerConfig {
    const preset = MODEL_PRESETS[s.modelKey ?? DEFAULT_MODEL] ?? MODEL_PRESETS[DEFAULT_MODEL];
    const tankLitres = Number(s.tankLitres ?? 210);
    const flowLpm = Number(s.flowLpm ?? 0);
    return {
      tableModel: preset.tables ?? null,
      ratedHeatKw: preset.capacityKw,
      ratedCop: preset.capacityKw / preset.heatInputKw,
      ratedFlowLpm: (preset.capacityKw / (4.186 * RATED_DELTA_T_K)) * 60,
      fixedFlowLpm: flowLpm > 0 ? flowLpm : null,
      backupHeaterKw: parseFloat(s.backupHeaterKW ?? '3') || 0,
      backupStepKw: BACKUP_STEP_KW,
      immersionKw: this.getStoreValue('immersionSeen') ? IMMERSION_KW : 0,
      tankLitres: s.enableDhw && tankLitres > 0 ? tankLitres : null,
      compressorCm3: (s.modelKey ?? DEFAULT_MODEL).startsWith('r32')
        ? (this.getStoreValue('compressorCm3') as number | null) ?? preset.compressorCm3 ?? null
        : null,
      ...(preset.aux ?? DEFAULT_AUX),
    };
  }

  /**
   * Frequency-model constant from the CT current the user read on the remote controller
   * during a run, with the frequency, TE and TC of the latest poll.
   */
  private async calibrateFromCurrent(currentA: number, s: DeviceSettings): Promise<void> {
    if (!(s.modelKey ?? DEFAULT_MODEL).startsWith('r32')) throw new Error(this.homey.__('error.ct_r32_only'));
    const x = this.lastPowerSample;
    if (!x || Date.now() - x.timeMs > 3 * 60_000 || !x.compressorHz || x.evaporatorC == null || x.condensingC == null) {
      throw new Error(this.homey.__('error.ct_not_running'));
    }
    const [evaporating, condensing] = compressionTempsC(x.evaporatorC, x.condensingC, x.twoC);
    const cm3 = compressorCm3FromCurrent(currentA, x.compressorHz, evaporating, condensing);
    if (cm3 == null || cm3 < 5 || cm3 > 100) throw new Error(this.homey.__('error.ct_implausible'));
    this.log(`Calibrated from CT ${currentA} A at ${x.compressorHz} Hz, TE ${x.evaporatorC}, TC ${x.condensingC}: ${cm3.toFixed(1)} cm³`);
    // Keep every calibration with its operating point: comparing them (summer hot water,
    // winter heating) shows whether one constant fits all conditions.
    const history = ((this.getStoreValue('ctCalibrations') as unknown[] | null) ?? []).slice(-19);
    history.push({
      time: new Date(x.timeMs).toISOString(), currentA, hz: x.compressorHz, te: x.evaporatorC, tc: x.condensingC,
      twi: x.twiC, two: x.twoC, outdoor: x.outdoorC, zoneOn: x.zoneOn, dhwOn: x.dhwOn, cm3: Math.round(cm3 * 10) / 10,
    });
    await this.setStoreValue('ctCalibrations', history);
    await this.setStoreValue('compressorCm3', cm3);
    const lastCalibration = `${new Date(x.timeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${currentA} A, ${x.compressorHz} Hz, `
      + `TE ${x.evaporatorC} °C, TC ${x.condensingC} °C, TO ${x.outdoorC} °C → ${cm3.toFixed(1)} cm³`;
    // Settings can't be written from within onSettings; do it right after.
    this.homey.setTimeout(() => {
      this.setSettings({ lastCalibration }).catch((err) => this.error('setSettings lastCalibration', err));
    }, 1000);
    this.power.setConfig(this.powerConfig(s));
  }

  private initPower(s: DeviceSettings): void {
    const learnt = this.getStoreValue('powerLearnt') as LearntState | null;
    // 'sensorCheck' also judges TC and the compressor frequency; the 1.2.0 test builds'
    // TE-only 'refrigerantCheck' doesn't carry over.
    if (this.getStoreValue('refrigerantCheck') != null) this.unsetStoreValue('refrigerantCheck').catch(() => undefined);
    const check = this.getStoreValue('sensorCheck') as RefrigerantCheckState | null;
    this.power = new PowerEstimator(this.powerConfig(s), learnt ?? undefined);
    this.refrigerantCheck = new RefrigerantSensorCheck(check ?? undefined);
    // meter_power keeps counting from where it is (also the hours-based totals of
    // versions before 1.2.0), so Homey Energy never sees the meter go backwards.
    this.meterKwh = Number(this.getCapabilityValue('meter_power')) || 0;
  }

  /**
   * Registers 40021–40032 (TC, TE, compressor Hz, …) aren't in Toshiba's list: read them
   * on their own so a unit that rejects them can't break the main poll, and stop asking
   * after three refusals in a row.
   */
  private async readUndocumented(endpoint: ModbusEndpoint): Promise<Record<number, number> | undefined> {
    if (this.undocumentedFailures >= 3) return undefined;
    try {
      const snap = await this.app.modbus.readRegisters(endpoint, UNDOCUMENTED_REGISTERS);
      this.undocumentedFailures = 0;
      return snap;
    } catch (err) {
      this.undocumentedFailures += 1;
      if (this.undocumentedFailures >= 3) {
        this.log('Registers 40021–40032 not readable, power estimate uses water temperatures only:', err instanceof Error ? err.message : err);
      }
      return undefined;
    }
  }

  /**
   * The unit counts backup heater time in whole hours (register 40040). Whenever it ticks,
   * compare with the heater time the model counted over the same period and book the minutes
   * it missed (heater detection from temperatures can miss a heater at high water flow).
   * Only when the app polled at least 90 % of the period; missed time at one heater step
   * (3 kW), so multi-stage heaters are not over-booked. Returns the kWh to add.
   */
  private reconcileHeaterHours(hours: number | undefined, heaterW: number, nowMs: number, s: DeviceSettings): number {
    if (hours === undefined || hours === NO_SENSOR_VALUE) return 0;
    const prev = this.heaterHours;
    if (!prev || hours < prev.value) {
      this.heaterHours = { value: hours, sinceMs: nowMs, countedS: 0, coveredS: 0 };
      return 0;
    }
    const dtS = this.lastPower ? Math.min(300, Math.max(0, (nowMs - this.lastPower.timeMs) / 1000)) : 0;
    prev.coveredS += dtS;
    if (heaterW > 0) prev.countedS += dtS;
    if (hours === prev.value) return 0;
    const periodS = (nowMs - prev.sinceMs) / 1000;
    const missingS = (hours - prev.value) * 3600 - prev.countedS;
    this.heaterHours = { value: hours, sinceMs: nowMs, countedS: 0, coveredS: 0 };
    if (prev.coveredS < 0.9 * periodS || missingS < 300) return 0;
    const stepKw = Math.min(BACKUP_STEP_KW, parseFloat(s.backupHeaterKW ?? '3') || 0);
    this.log(`Backup heater hours ${prev.value} → ${hours}: counted ${Math.round(prev.countedS / 60)} min, booking ${Math.round(missingS / 60)} min more`);
    return (stepKw * missingS) / 3600;
  }

  /** Records whether SG Ready "System Forced ON" is active (Flow card sg_forced_on_set). */
  public async setSgForcedOn(on: boolean): Promise<void> {
    await this.setStoreValue('sgForcedOn', on);
  }

  /**
   * Live power (W) and energy (kWh) from the power model: electrical input derived
   * from the heat the water carries (flow × ΔT) and Toshiba's performance tables,
   * integrated over time. See power-model.ts and AGENTS.md § 7.
   */
  private async updatePower(snapshot: Record<number, number>, s: DeviceSettings, extra?: Record<number, number>): Promise<void> {
    const temp = (reg: number): number | null => {
      const raw = snapshot[reg];
      return raw === undefined ? null : this.scale(raw, s);
    };

    // An immersion heater is only counted once its hour counter has ticked.
    const hImm = snapshot[REGISTERS.immersionHeaterHours.number];
    if (hImm !== undefined) {
      if (this.lastImmersionHours != null && hImm > this.lastImmersionHours && !this.getStoreValue('immersionSeen')) {
        await this.setStoreValue('immersionSeen', true);
        this.power.setConfig(this.powerConfig(s));
      }
      this.lastImmersionHours = hImm;
    }

    const sample: PowerSample = {
      timeMs: Date.now(),
      zoneOn: snapshot[REGISTERS.zone1OnOff.number] === 1,
      dhwOn: s.enableDhw && snapshot[REGISTERS.hotWaterOnOff.number] === 1,
      coolMode: snapshot[REGISTERS.operationMode.number] === 2,
      outdoorC: temp(REGISTERS.outdoorTemp.number),
      twiC: temp(REGISTERS.waterInletTemp.number),
      twoC: temp(REGISTERS.waterOutletTemp.number),
      thoC: temp(REGISTERS.heaterOutletTemp.number),
      tankC: s.enableDhw ? temp(REGISTERS.dhwTankTemp.number) : null,
      evaporatorC: extra?.[REGISTERS.evaporatorTemp.number] === undefined ? null : this.scale(extra[REGISTERS.evaporatorTemp.number], s),
      condensingC: extra?.[REGISTERS.condensingTemp.number] === undefined ? null : this.scale(extra[REGISTERS.condensingTemp.number], s),
      compressorHz: extra?.[REGISTERS.compressorFrequency.number] ?? null,
      // A boost switches the backup heater on: the Modbus/remote boost (40009), or SG Ready
      // "System Forced ON" when a Flow reported it (card sg_forced_on_set) and DN 6CE = 0.
      boostActive: s.enableDhw && (snapshot[REGISTERS.hotWaterBoostOnOff.number] === 1
        || (this.getStoreValue('sgForcedOn') === true && s.sgHeaterAllowed !== false)),
      boostSetpointC: temp(REGISTERS.hotWaterBoostSetpoint.number),
    };
    // The undocumented registers only count once they've proven themselves on this unit.
    const trusted = this.refrigerantCheck.trusted;
    const reading = this.power.update({
      ...sample,
      evaporatorC: trusted ? sample.evaporatorC : null,
      condensingC: trusted ? sample.condensingC : null,
      compressorHz: trusted ? sample.compressorHz : null,
    });
    this.refrigerantCheck.update(sample, reading.waterSaysOn);
    this.lastPowerSample = sample;

    // The heater-hours bookkeeping always runs, so it stays consistent across meter on/off.
    const heaterBackfillKwh = this.reconcileHeaterHours(snapshot[REGISTERS.backupHeaterHours.number], reading.heaterW, sample.timeMs, s);
    await this.refreshExternalMeter();
    const meter = this.meterLink?.usable ? this.meterLink : null;
    const intervalMs = this.lastPower ? sample.timeMs - this.lastPower.timeMs : 0;
    let watts: number;
    if (meter) {
      // Measured: power and energy come from the linked meter; the estimate only runs alongside.
      watts = meter.watts as number;
      const counted = meter.energySinceLast();
      if (counted !== null) this.meterKwh += counted;
      else if (this.lastPower) this.meterKwh += energyKwh(this.lastPower.watts, watts, intervalMs);
    } else {
      this.meterLink?.resetEnergy();
      watts = reading.watts;
      if (this.lastPower) this.meterKwh += energyKwh(this.lastPower.watts, reading.watts, intervalMs);
      this.meterKwh += reading.backfillKwh;
      this.meterKwh += heaterBackfillKwh;
    }
    this.lastPower = { watts, timeMs: sample.timeMs };
    if (this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', watts).catch(() => undefined);
    }
    if (this.hasCapability('meter_power')) {
      await this.setCapabilityValue('meter_power', Math.round(this.meterKwh * 1000) / 1000).catch(() => undefined);
    }

    // Persist what was learnt, and show it in the settings.
    const learnt = this.power.learnt;
    if (JSON.stringify(learnt) !== JSON.stringify(this.getStoreValue('powerLearnt'))) await this.setStoreValue('powerLearnt', learnt);
    // The check's counters move every poll: save when its verdict changes, else every 30 min.
    const saved = this.getStoreValue('sensorCheck') as RefrigerantCheckState | null;
    const verdictChanged = new RefrigerantSensorCheck(saved ?? undefined).trusted !== this.refrigerantCheck.trusted;
    if (verdictChanged || sample.timeMs - this.refrigerantCheckSavedMs > 30 * 60_000) {
      await this.setStoreValue('sensorCheck', this.refrigerantCheck.snapshot);
      this.refrigerantCheckSavedMs = sample.timeMs;
    }
    let powerStatus: string;
    const cm3 = this.powerConfig(s).compressorCm3;
    if (reading.detection === 'frequency' && cm3) {
      const source = this.homey.__(this.getStoreValue('compressorCm3') != null ? 'power.calibrated' : 'power.from_databook');
      powerStatus = `${this.homey.__('power.detect_frequency')} · ${cm3.toFixed(1)} cm³, ${source}`;
    } else {
      let flowSource = this.homey.__('power.flow_rated');
      if (Number(s.flowLpm) > 0) flowSource = this.homey.__('power.flow_set');
      else if (this.power.flowIsLearnt) flowSource = `${this.homey.__('power.flow_learnt')} (${learnt.flowSamplesLpm.length})`;
      const detection = this.homey.__(reading.detection === 'refrigerant' ? 'power.detect_refrigerant' : 'power.detect_water');
      powerStatus = `${this.power.flowLpm.toFixed(1)} l/min, ${flowSource} · ${detection}`;
    }
    if (this.getExternalMeterId()) {
      powerStatus = meter
        ? `${this.homey.__('power.measured_by', { name: meter.name })} · ${this.homey.__('power.estimate_now', { watts: Math.round(reading.watts) })} (${powerStatus})`
        : `${this.homey.__('power.meter_unavailable', { name: this.meterLink?.name ?? '?' })} · ${powerStatus}`;
    }
    if (s.powerStatus !== powerStatus) await this.setSettings({ powerStatus }).catch((err) => this.error('setSettings powerStatus', err));
  }

  private schedulePolling(intervalSeconds: number): void {
    this.clearPolling();
    const ms = Math.max(5, intervalSeconds) * 1000;
    this.pollTimer = this.homey.setInterval(() => this.pollOnce(), ms);
  }

  private clearPolling(): void {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const settings = this.getDeviceSettings();
    const endpoint = this.endpointFromSettings(settings);
    const registers = this.buildRegisterList(settings);
    try {
      const snapshot = await this.app.modbus.readRegisters(endpoint, registers);
      const extra = await this.readUndocumented(endpoint);
      await this.applySnapshot(snapshot, settings, extra);
      await this.setAvailable();
      await this.setSettings({ lastSeen: new Date().toISOString() }).catch(() => undefined);

      if (this.probeOnNextPoll) {
        await this.refreshDetectedInfo(endpoint).catch((err) => this.error('refreshDetectedInfo', err));
        this.probeOnNextPoll = false;
      }

      if (!this.limitsApplied) {
        await this.applySetpointLimits(endpoint, settings).catch((err) => this.error('applySetpointLimits', err));
        this.limitsApplied = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Poll failed: ${message}`);
      const prefix = this.homey.__('error.poll_failed') || 'Modbus poll failed';
      await this.setUnavailable(`${prefix}: ${message}`).catch(() => undefined);
    }
  }

  private buildRegisterList(s: DeviceSettings): number[] {
    const regs: number[] = [...ALWAYS_ON_REGISTERS];
    if (s.enableZone2) regs.push(...ZONE2_REGISTERS);
    if (s.enableDhw) regs.push(...DHW_REGISTERS);
    return regs;
  }

  /** Convert a raw 16-bit register value to a scaled °C, or null for "no sensor". */
  private scale(raw: number, s: DeviceSettings): number | null {
    if (raw === NO_SENSOR_VALUE) return null;
    const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
    return s.tempScaling === 'x10' ? signed / 10 : signed;
  }

  private async applySnapshot(snapshot: Record<number, number>, s: DeviceSettings, extra?: Record<number, number>): Promise<void> {
    const setTemp = async (cap: string, regNumber: number) => {
      if (!this.hasCapability(cap)) return;
      const raw = snapshot[regNumber];
      if (raw === undefined) return;
      await this.setCapabilityValue(cap, this.scale(raw, s)).catch((err) => this.error(`set ${cap}`, err));
    };
    const setBool = async (cap: string, regNumber: number) => {
      if (!this.hasCapability(cap)) return;
      const raw = snapshot[regNumber];
      if (raw === undefined) return;
      await this.setCapabilityValue(cap, raw === 1).catch((err) => this.error(`set ${cap}`, err));
    };

    // Read-only sensors
    await setTemp('measure_temperature',                       REGISTERS.zone1ControlTemp.number);
    await setTemp('measure_temperature.outdoor',               REGISTERS.outdoorTemp.number);
    const outdoorRaw = snapshot[REGISTERS.outdoorTemp.number];
    if (outdoorRaw !== undefined) {
      await this.recordOutdoor(this.scale(outdoorRaw, s)).catch((err) => this.error('recordOutdoor', err));
    }
    await setTemp('measure_temperature.water_inlet',           REGISTERS.waterInletTemp.number);
    await setTemp('measure_temperature.water_outlet',          REGISTERS.waterOutletTemp.number);
    if (s.enableZone2) await setTemp('measure_temperature.zone2', REGISTERS.zone2ControlTemp.number);
    if (s.enableDhw) {
      await setTemp('measure_temperature.tank_water',          REGISTERS.dhwTankTemp.number);
      await setTemp('measure_temperature.water_heater_outlet', REGISTERS.heaterOutletTemp.number);
    }

    // On/off + mode
    const zone1On = snapshot[REGISTERS.zone1OnOff.number];
    const opMode = snapshot[REGISTERS.operationMode.number];
    if (zone1On !== undefined && this.hasCapability('onoff')) {
      await this.setCapabilityValue('onoff', zone1On === 1).catch(() => undefined);
    }
    if (this.hasCapability('thermostat_mode') && zone1On !== undefined) {
      let mode: ThermostatMode = 'off';
      if (zone1On === 1) mode = opMode === 2 ? 'cool' : 'heat';
      await this.setCapabilityValue('thermostat_mode', mode).catch(() => undefined);
    }

    // Setpoints (writable caps: still set their displayed value from the unit)
    await setTemp('target_temperature',               REGISTERS.zone1SetpointTemp.number);
    if (s.enableZone2) await setTemp('target_temperature.zone2',     REGISTERS.zone2SetpointTemp.number);
    if (s.enableDhw)   await setTemp('target_temperature.tank_water', REGISTERS.dhwSetpointTemp.number);

    // DHW on/off + boost + anti-bacteria
    if (s.enableDhw) {
      await setBool('onoff.hotwater',   REGISTERS.hotWaterOnOff.number);
      await setBool('boost_hotwater',   REGISTERS.hotWaterBoostOnOff.number);
      await setBool('antibacteria',     REGISTERS.antibacteriaOnOff.number);
    }

    // Energy-saving toggles
    await setBool('frost_protection', REGISTERS.frostProtectionOnOff.number);
    await setBool('night_setback',    REGISTERS.nightSetbackOnOff.number);
    await setBool('auto_temp',        REGISTERS.autoTempOnOff.number);

    // ── Energy estimation ────────────────────────────────────────────────
    await this.updatePower(snapshot, s, extra).catch((err) => this.error('updatePower', err));

    // Alarm flag + rich trigger on transition
    const alarmRaw = snapshot[REGISTERS.alarmStatus.number];
    const alarmActive = alarmRaw === 1;
    if (this.hasCapability('alarm_generic')) {
      await this.setCapabilityValue('alarm_generic', alarmActive).catch(() => undefined);
    }

    const codeRaw = snapshot[REGISTERS.alarmCode.number];
    const unitRaw = snapshot[REGISTERS.alarmUnit.number];
    // Active display: just the decoded code+description (no unit suffix — the
    // suffix added ~20 chars and pushed the visible part past Homey's
    // sensor-tile truncation, hiding the "A01" prefix from users).
    if (this.hasCapability('fault_code')) {
      const codeStr = codeRaw === undefined
        ? '—'
        : alarmActive
          ? decodeAlarmCode(codeRaw)
          : 'No fault';
      await this.setCapabilityValue('fault_code', codeStr).catch(() => undefined);
    }

    // Fire flow trigger on rising edge (inactive → active), record the event
    // in the persistent last-fault history, and populate the last_fault cap
    // so users can see what happened even after the alarm self-clears.
    if (alarmActive && !this.lastAlarmActive) {
      const code = codeRaw ?? 0;
      const description = decodeAlarmCode(code);
      const unit = decodeAlarmUnit(unitRaw ?? 0);
      const detail = decodeAlarmDetail(code);
      const codeHex = `0x${(code & 0xFFFF).toString(16).padStart(4, '0').toUpperCase()}`;
      const timestamp = new Date().toISOString();
      // Headline = timestamp + decoded label. Append the longer explanation
      // (sourced from the service manual) on a second line so users can read
      // it directly from the Homey device card without having to dig into
      // the timeline notification.
      const headline = `${timestamp.slice(0, 16).replace('T', ' ')} · ${description}`;
      const display = detail ? `${headline}\n\n${detail}` : headline;

      // Update the persistent last-fault capability + store the event in a
      // rolling history of the last 10 faults (for future Flow-tag exposure).
      if (this.hasCapability('last_fault')) {
        await this.setCapabilityValue('last_fault', display).catch(() => undefined);
      }
      try {
        const history = (this.getStoreValue('faultHistory') as FaultEvent[] | null) ?? [];
        history.unshift({ timestamp, code: codeHex, unit, description });
        await this.setStoreValue('faultHistory', history.slice(0, 10));
      } catch (err) {
        this.error('faultHistory store failed', err);
      }

      try {
        await this.homey.flow.getDeviceTriggerCard('fault_triggered')
          .trigger(this, { code: codeHex, unit, description, timestamp }, {})
          .catch((err) => this.error('fault_triggered trigger failed', err));
      } catch (err) {
        this.error('fault_triggered dispatch', err);
      }

      // Push a rich notification to the Homey timeline. Homey's built-in
      // alarm-capability transition message ("Alarm ging af") doesn't
      // include the code, so users see no specifics in their history.
      // This call adds a second timeline entry with the decoded details
      // *and* the plain-language explanation of what the fault is about.
      try {
        const name = this.getName();
        const detail = decodeAlarmDetail(code);
        const head = `**${name}** — ${description} (${unit})`;
        const excerpt = detail ? `${head}\n${detail}` : head;
        await this.homey.notifications.createNotification({ excerpt })
          .catch((err: unknown) => this.error('notification create failed', err));
      } catch (err) {
        this.error('notification dispatch', err);
      }
    }
    this.lastAlarmActive = alarmActive;
  }

  /** Read setpoint limits once and apply them as capability options. */
  private async applySetpointLimits(endpoint: ModbusEndpoint, s: DeviceSettings): Promise<void> {
    const regs: number[] = [
      REGISTERS.zoneCoolMax.number,
      REGISTERS.zoneCoolMin.number,
      REGISTERS.zone1HeatMax.number,
      REGISTERS.zone1HeatMin.number,
    ];
    if (s.enableZone2) regs.push(REGISTERS.zone2HeatMax.number, REGISTERS.zone2HeatMin.number);
    if (s.enableDhw)   regs.push(REGISTERS.dhwMax.number,       REGISTERS.dhwMin.number);

    const snap = await this.app.modbus.readRegisters(endpoint, regs);
    const sc = (raw?: number) => (raw == null ? null : this.scale(raw, s));

    const coolMax  = sc(snap[REGISTERS.zoneCoolMax.number]);
    const coolMin  = sc(snap[REGISTERS.zoneCoolMin.number]);
    const z1HeatMax = sc(snap[REGISTERS.zone1HeatMax.number]);
    const z1HeatMin = sc(snap[REGISTERS.zone1HeatMin.number]);

    // Zone 1 setpoint range = union of cool + heat ranges
    const z1Min = this.minOrNull(coolMin, z1HeatMin);
    const z1Max = this.maxOrNull(coolMax, z1HeatMax);
    if (z1Min != null && z1Max != null && this.hasCapability('target_temperature')) {
      await this.setCapabilityOptions('target_temperature', { min: z1Min, max: z1Max, step: 0.5 }).catch(() => undefined);
    }

    if (s.enableZone2) {
      const z2HeatMax = sc(snap[REGISTERS.zone2HeatMax.number]);
      const z2HeatMin = sc(snap[REGISTERS.zone2HeatMin.number]);
      const z2Min = this.minOrNull(coolMin, z2HeatMin);
      const z2Max = this.maxOrNull(coolMax, z2HeatMax);
      if (z2Min != null && z2Max != null && this.hasCapability('target_temperature.zone2')) {
        await this.setCapabilityOptions('target_temperature.zone2', { min: z2Min, max: z2Max, step: 0.5 }).catch(() => undefined);
      }
    }

    if (s.enableDhw) {
      const dhwMax = sc(snap[REGISTERS.dhwMax.number]);
      const dhwMin = sc(snap[REGISTERS.dhwMin.number]);
      if (dhwMin != null && dhwMax != null && this.hasCapability('target_temperature.tank_water')) {
        await this.setCapabilityOptions('target_temperature.tank_water', { min: dhwMin, max: dhwMax, step: 0.5 }).catch(() => undefined);
      }
    }
  }

  private minOrNull(a: number | null, b: number | null): number | null {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  private maxOrNull(a: number | null, b: number | null): number | null {
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
  }

  private async refreshDetectedInfo(endpoint: ModbusEndpoint): Promise<void> {
    const snapshot = await this.app.modbus.readRegisters(endpoint, [
      REGISTERS.hydroUnitType.number,
      REGISTERS.slaveAddress.number,
      REGISTERS.baudRateCode.number,
    ]);
    const series = decodeHydroUnitType(snapshot[REGISTERS.hydroUnitType.number]);
    const slave = String(snapshot[REGISTERS.slaveAddress.number] ?? '—');
    const baud = decodeBaudRate(snapshot[REGISTERS.baudRateCode.number]);
    await this.setSettings({
      detectedSeries: series,
      detectedSlaveAddress: slave,
      detectedBaudRate: baud != null ? `${baud} bps` : '—',
    }).catch((err) => this.error('setSettings detected*', err));
  }
}

module.exports = HeatpumpDevice;
