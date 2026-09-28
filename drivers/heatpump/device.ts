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
  // Energy estimation: model preset + backup heater wattage dropdown.
  // Cylinder immersion is auto-detected from register 40039 (delta-hours);
  // see STANDARD_IMMERSION_KW in device.ts. No user setting needed because
  // Toshiba only ships the 2.75 kW HWS-CSHM3-E cylinder immersion, and only
  // on split installs where it's wired in by the installer.
  modelKey?: string;
  backupHeaterKW?: string;     // dropdown: "0" | "3" | "6" | "9"
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
 * Comprehensive Toshiba Estia model preset table — nominal electrical input
 * power per mode (kW), drawn from official datasheets (R32 S1/S2, R410A S4,
 * S5, Hi Power). Heating @ A7/W35, cooling @ A35/W7, DHW derived at A7/W55.
 * The user picks one entry from the dropdown; the energy estimator multiplies
 * lifetime hours by these values.
 *
 * NOTE: backup heater wattage is NOT here — it's an installation choice
 * (3/6/9 kW typically) and lives in its own settings dropdown.
 */
const MODEL_PRESETS: Record<string, { heat: number; cool: number; dhw: number }> = {
  // R32 1 Series (F21 indoor) and 2 Series (S21 indoor) share the same outdoor
  // units (HWT-_HW-E codes) and the same compressor → identical input ratings.
  // One entry per kW class; covers both generations.
  'r32-s1-401':   { heat: 0.77, cool: 1.16, dhw: 1.4 },  // 4 kW  — outdoor HWT-401HW-E
  'r32-s1-601':   { heat: 1.25, cool: 1.52, dhw: 1.9 },  // 6 kW  — outdoor HWT-601HW-E
  'r32-s1-801':   { heat: 1.54, cool: 1.88, dhw: 2.5 },  // 8 kW  — outdoor HWT-801HW-E
  'r32-s1-1101':  { heat: 2.39, cool: 2.86, dhw: 3.6 },  // 11 kW — outdoor HWT-1101HW-E (e.g. F21SM3 / S21SM3)
  'r32-s1-1401':  { heat: 3.04, cool: 4.08, dhw: 4.7 },  // 14 kW — outdoor HWT-1401H8W-E
  // R410A Series 5 (2017-2021)
  'r410a-s5-455': { heat: 0.92, cool: 1.46, dhw: 1.5 },  // 4.5 kW
  'r410a-s5-805': { heat: 1.79, cool: 2.00, dhw: 2.6 },  // 8 kW
  'r410a-s5-1105':{ heat: 2.30, cool: 3.07, dhw: 3.5 },  // 11 kW
  'r410a-s5-1405':{ heat: 3.11, cool: 3.81, dhw: 4.7 },  // 14 kW
  'r410a-s5-1605':{ heat: 3.78, cool: 4.10, dhw: 5.0 },  // 16 kW
  // R410A Hi Power (high-temperature flow)
  'r410a-hp-805': { heat: 1.71, cool: 2.00, dhw: 2.6 },  // 8 kW
  'r410a-hp-1105':{ heat: 2.30, cool: 3.30, dhw: 3.5 },  // 11 kW
  'r410a-hp-1405':{ heat: 3.16, cool: 3.81, dhw: 4.7 },  // 14 kW
  // R410A Series 4 (legacy, 2014-2017)
  'r410a-s4-803': { heat: 1.90, cool: 2.07, dhw: 2.6 },  // 8 kW
  'r410a-s4-1103':{ heat: 2.69, cool: 3.45, dhw: 3.5 },  // 11 kW
  'r410a-s4-1403':{ heat: 3.40, cool: 3.85, dhw: 4.7 },  // 14 kW
  'r410a-s4-1603':{ heat: 3.95, cool: 3.95, dhw: 5.0 },  // 16 kW
};

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
  'measure_temperature.water_inlet':  { title: { en: 'Water inlet (TWI)',  nl: 'Aanvoertemperatuur' } },
  'measure_temperature.water_outlet': { title: { en: 'Water outlet (TWO)', nl: 'Retourtemperatuur' } },
  'alarm_generic':                 { title: { en: 'Heat pump alarm',     nl: 'Warmtepomp alarm' } },
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
  ['measure_power',         { title: { en: 'Estimated power',         nl: 'Geschat vermogen' } }],
  ['meter_power',           { title: { en: 'Estimated total energy',  nl: 'Geschatte totale energie' } }],
  // Season detection (1.1.0)
  ['measure_temperature.outdoor_avg', { title: {
    en: 'Average outdoor temperature', nl: 'Gemiddelde buitentemperatuur', da: 'Gennemsnitlig udetemperatur',
    de: 'Durchschnittliche Außentemperatur', es: 'Temperatura exterior media', fr: 'Température extérieure moyenne',
    it: 'Temperatura esterna media', no: 'Gjennomsnittlig utetemperatur', sv: 'Genomsnittlig utomhustemperatur',
    pl: 'Średnia temperatura zewnętrzna', ru: 'Средняя температура на улице', ko: '평균 실외 온도',
    ar: 'متوسط درجة الحرارة الخارجية',
  } }],
  ['season'],
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
  // Runtime hour counters — used by the energy estimator
  REGISTERS.dhwCompressorHours.number,
  REGISTERS.heatingCompressorHours.number,
  REGISTERS.coolingCompressorHours.number,
  REGISTERS.waterPumpHours.number,
  REGISTERS.immersionHeaterHours.number,
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
] as const;

export default class HeatpumpDevice extends Homey.Device {
  private pollTimer: NodeJS.Timeout | null = null;
  private probeOnNextPoll = true;
  private limitsApplied = false;
  private dhwBoostOffTimer: NodeJS.Timeout | null = null;
  private lastAlarmActive = false;
  private lastBackupHours: number | null = null;
  private lastImmersionHours: number | null = null;
  // Live-power detection state — last sample's TWO + timestamp for rate calc.
  private lastTwoC: number | null = null;
  private lastSampleMs: number | null = null;
  // Demand-transition state machine: tracks on→off / off→on edges so we can
  // suppress watts during compressor start (hysteresis) and after cycle end
  // (post-cycle lock — water side keeps showing delta-T as it equalises).
  private lastDemandOn = false;
  private demandTransitionMs: number | null = null;
  // Lifetime kWh monotonicity guard — a bad register read shouldn't roll the total back.
  private lastMeterPowerKwh: number | null = null;
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
    if (this.dhwBoostOffTimer) {
      this.homey.clearTimeout(this.dhwBoostOffTimer);
      this.dhwBoostOffTimer = null;
    }
  }

  async onDeleted(): Promise<void> {
    this.clearPolling();
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
      await this.applySnapshot(snapshot, settings);
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

  private async applySnapshot(snapshot: Record<number, number>, s: DeviceSettings): Promise<void> {
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
    // The BMS-IFMB0UEW-E doesn't expose power or kWh registers, so we infer
    // "what's running right now" from physical signals (water-side delta-T)
    // and multiply by per-model rated input power. Lifetime totals come from
    // the unit's own hour counters × the same rated values.
    const preset      = MODEL_PRESETS[s.modelKey ?? 'r32-s1-1101'] ?? MODEL_PRESETS['r32-s1-1101'];
    const ratedHeat   = preset.heat;
    const ratedCool   = preset.cool;
    const ratedDhw    = preset.dhw;
    const ratedBackup = parseFloat(s.backupHeaterKW   ?? '3') || 0;
    // Toshiba's only cylinder-immersion product is the 2.75 kW element fitted
    // to the HWS-CSHM3-E external cylinder. Detection is delta-hours-based:
    // ratedImm only applies once register 40039 actually starts ticking,
    // which proves an immersion is physically wired and engaging on this unit.
    const ratedImm    = 2.75;

    // Lifetime hour counters drive the running kWh total.
    const hHeat   = snapshot[REGISTERS.heatingCompressorHours.number] ?? 0;
    const hCool   = snapshot[REGISTERS.coolingCompressorHours.number] ?? 0;
    const hDhw    = snapshot[REGISTERS.dhwCompressorHours.number]     ?? 0;
    const hBackup = snapshot[REGISTERS.backupHeaterHours.number]      ?? 0;
    const hImm    = snapshot[REGISTERS.immersionHeaterHours.number]   ?? 0;
    const kwhTotal =
      hHeat * ratedHeat +
      hCool * ratedCool +
      hDhw  * ratedDhw  +
      hBackup * ratedBackup +
      hImm * ratedImm;
    // Monotonicity guard: a single bad register read can produce a kWh value
    // lower than the previous one. Lifetime totals are non-decreasing — drop
    // the new value and keep the last known good one if it tries to roll back.
    const kwhPlausible =
      this.lastMeterPowerKwh == null || kwhTotal >= this.lastMeterPowerKwh - 0.5;
    if (kwhPlausible && this.hasCapability('meter_power')) {
      await this.setCapabilityValue('meter_power', Math.round(kwhTotal)).catch(() => undefined);
      this.lastMeterPowerKwh = kwhTotal;
    } else if (!kwhPlausible) {
      this.error(`kWh monotonicity guard: ${this.lastMeterPowerKwh} → ${kwhTotal}, skipping`);
    }

    // ── Live power: gate on physical signals ─────────────────────────────
    // Compressor runs ⇔ |TWO − TWI| > ~1.5 °C (heat exchange is happening).
    // BUH runs ⇔ THO − TWO > ~1.0 °C (heater adds heat downstream of TWO).
    // Immersion runs ⇔ DHW tank rising fast while compressor isn't heating it,
    //   or anti-bacteria cycle active (target > heatpump max).
    const twiC = this.scale(snapshot[REGISTERS.waterInletTemp.number]   ?? NO_SENSOR_VALUE, s);
    const twoC = this.scale(snapshot[REGISTERS.waterOutletTemp.number]  ?? NO_SENSOR_VALUE, s);
    const thoC = this.scale(snapshot[REGISTERS.heaterOutletTemp.number] ?? NO_SENSOR_VALUE, s);

    const COMPRESSOR_DELTA_THRESHOLD = 1.5;
    const BUH_DELTA_THRESHOLD        = 1.0;
    const TWO_RATE_THRESHOLD         = 0.05;     // °C/min — sign tells direction
    // Demand-transition hysteresis: filter out compressor-start ramps and
    // residual water-side delta-T after a cycle ends.
    const STARTING_HYSTERESIS_MS     = 60_000;   // ignore first 60 s of demand-on
    const POST_CYCLE_LOCK_MS         = 180_000;  // force 0 W for 180 s after demand-off
    // Modulation against rated input. Estia rated condition has |ΔT| ≈ 5 °C;
    // larger ΔT means the inverter is pushing harder, smaller means modulating down.
    const NOMINAL_DELTA_T            = 5;
    const MODULATION_MIN             = 0.5;      // 50 % rated minimum when running
    const MODULATION_MAX             = 1.5;      // 150 % rated maximum (boost mode)

    const z1IsOn  = snapshot[REGISTERS.zone1OnOff.number] === 1;
    const dhwIsOn = s.enableDhw && snapshot[REGISTERS.hotWaterOnOff.number] === 1;
    const modeRaw = snapshot[REGISTERS.operationMode.number];
    const anyHeatpumpDemand = z1IsOn || dhwIsOn;

    // TWO rate of change (°C / minute). Capture the "rate available" flag
    // while the previous values are still in scope — we update them below.
    const nowMs = Date.now();
    let twoRatePerMin  = 0;
    let twoRateAvailable = false;
    if (this.lastSampleMs != null && twoC != null && this.lastTwoC != null) {
      const dtMin = (nowMs - this.lastSampleMs) / 60000;
      if (dtMin > 0) {
        twoRatePerMin = (twoC - this.lastTwoC) / dtMin;
        twoRateAvailable = true;
      }
    }
    this.lastTwoC = twoC;
    this.lastSampleMs = nowMs;

    // Demand-edge tracking — capture timestamps of on→off and off→on transitions.
    if (anyHeatpumpDemand !== this.lastDemandOn) {
      this.demandTransitionMs = nowMs;
      this.lastDemandOn = anyHeatpumpDemand;
    }
    const sinceTransitionMs = this.demandTransitionMs != null
      ? nowMs - this.demandTransitionMs
      : Number.POSITIVE_INFINITY;
    const inStartingHysteresis = anyHeatpumpDemand && sinceTransitionMs < STARTING_HYSTERESIS_MS;
    const inPostCycleLock      = !anyHeatpumpDemand && sinceTransitionMs < POST_CYCLE_LOCK_MS;

    // Compressor: needs demand AND active heat exchange AND TWO moving in the
    // expected direction. After a cycle ends, residual delta-T lingers but TWO
    // decays — that decay is what eliminates the false positive.
    let compressorRunning = false;
    if (anyHeatpumpDemand && twiC != null && twoC != null) {
      const deltaOK = Math.abs(twoC - twiC) > COMPRESSOR_DELTA_THRESHOLD;
      // Heating: TWO should be rising (or steady-high). Cooling: TWO should be falling.
      const directionOK = modeRaw === 2
        ? twoRatePerMin < -TWO_RATE_THRESHOLD || (twoRatePerMin <= 0 && twoC < twiC)
        : twoRatePerMin >  TWO_RATE_THRESHOLD || (twoRatePerMin >= 0 && twoC > twiC);
      // First poll has no rate — fall back to delta-T alone so a unit that's
      // actually running at app startup isn't wrongly reported as 0 W.
      compressorRunning = deltaOK && (twoRateAvailable ? directionOK : true);
    }
    // Suppress during the starting-up window (compressor still ramping) and
    // after demand drops (water-side delta-T lingers ~3 min as it equalises).
    const compressorBilling = compressorRunning && !inStartingHysteresis && !inPostCycleLock;

    // BUH: independent of compressor — heats whichever side the 3-way valve points at.
    const buhRunning =
      thoC != null && twoC != null && (thoC - twoC) > BUH_DELTA_THRESHOLD;

    // Immersion: the only reliable runtime signal we have is the lifetime hour
    // counter ticking between two polls. The anti-bacteria flag (reg 40011) is
    // a config bit ("feature enabled"), not a runtime status — using it caused
    // a permanent false positive. Tank-temperature heuristics also misfire
    // because tank readings are integer-quantized and the heatpump itself can
    // reach >55 °C. Hours-only is rare-but-correct.
    const immersionRunning =
      ratedImm > 0 &&
      this.lastImmersionHours != null &&
      hImm > this.lastImmersionHours;
    this.lastBackupHours = hBackup;
    this.lastImmersionHours = hImm;

    let watts = 0;
    if (compressorBilling && twiC != null && twoC != null) {
      // 3-way valve sends compressor heat to whichever destination is active.
      // DHW takes priority over zone heating when both are on.
      const ratedKw = dhwIsOn ? ratedDhw : (modeRaw === 2 ? ratedCool : ratedHeat);
      // Modulation: ΔT scales linearly with thermal output (Q = ṁ·Cp·ΔT) at
      // constant flow, and electrical input tracks thermal output via COP. So
      // watts ≈ rated × (|ΔT| / nominal). Clipped to a sane band.
      const deltaT = Math.abs(twoC - twiC);
      const modulation = Math.max(MODULATION_MIN, Math.min(MODULATION_MAX, deltaT / NOMINAL_DELTA_T));
      watts += ratedKw * modulation * 1000;
    }
    if (buhRunning) watts += ratedBackup * 1000;
    if (immersionRunning) watts += ratedImm * 1000;

    if (this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', Math.round(watts)).catch(() => undefined);
    }
    // ─────────────────────────────────────────────────────────────────────

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
