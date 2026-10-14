/**
 * Electrical power estimation for Toshiba Estia heat pumps.
 *
 * The BMS-IFMB0UEW-E exposes no power, current or flow register (the remote
 * controller shows CT and WF, the interface doesn't pass them on). Two models:
 *
 * 1. Frequency model (R32 units that report compressor frequency, TE and TC in the
 *    undocumented registers 40032 / 40028 / 40021):
 *
 *      electric = compressor Hz × C × compression work per m³ of R32 between TE and TC
 *
 *    C is the compressor's displacement over its overall efficiency (cm³), one constant
 *    per compressor: from Toshiba's Data Book, scaled on a measured unit, or calibrated
 *    by the user from the CT current on the remote controller.
 *
 * 2. Water model (everything else):
 *
 *      thermal  = water flow × 4.186 kJ/(kg·K) × |TWO − TWI|
 *      electric = input(thermal, outdoor temperature, leaving water temperature)
 *
 *    `input()` interpolates the "part load capacity and input" tables of the Estia R32
 *    Engineering Data Book (data/r32-tables.json); units without tables use their rated
 *    COP, shaped by the same tables' COP-versus-temperature curve. Water flow is learnt
 *    from domestic-hot-water runs (tank volume × ΔTTW). Both the learnt flow and the
 *    tables' COP proved optimistic on a measured unit — see AGENTS.md § 7.
 *
 * On top of either: the unit's own draw — standby (controls, interface, remote), water pump
 * and outdoor fan while the compressor runs, and the compressor-winding preheat in frost —
 * from the ErP data per outdoor unit.
 *
 * Pure module — no Homey imports — so it can be replayed against recorded data.
 * See AGENTS.md § 7 for the design notes and the validation data.
 */
import tables from './data/r32-tables.json';

const WATER_KJ_PER_L_K = 4.186;

/** One poll of the unit. Temperatures in °C, null when the sensor reports "no sensor". */
export interface PowerSample {
  timeMs: number;
  zoneOn: boolean;
  dhwOn: boolean;
  /** Zone mode is cooling (register 40003 = 2). Only meaningful while the zone is on. */
  coolMode: boolean;
  outdoorC: number | null;
  /** TWI — water entering the hydro unit (return). */
  twiC: number | null;
  /** TWO — water leaving the refrigerant/water heat exchanger, before the backup heater. */
  twoC: number | null;
  /** THO — water leaving the backup heater. */
  thoC: number | null;
  /** TTW — domestic hot water tank. */
  tankC: number | null;
  /**
   * Outdoor heat exchanger temperature (TE). Not in Toshiba's register list: read from
   * 40028, which carries it on R32 units (see RefrigerantSensorCheck). Pass null when
   * the unit doesn't provide it; detection then uses the water sensors.
   */
  evaporatorC?: number | null;
  /** Condensing temperature (TC, register 40021, undocumented). */
  condensingC?: number | null;
  /** Compressor frequency (Hz, register 40032, undocumented); 0 while stopped. */
  compressorHz?: number | null;
  /**
   * A hot-water boost that switches the backup heater on: the Modbus boost (40009), or
   * SG Ready "System Forced ON" with DN 6CE = 0.
   */
  boostActive?: boolean;
  /** Boost set point (register 40213, DN 09). */
  boostSetpointC?: number | null;
}

export interface PowerConfig {
  /** Outdoor unit capacity code with performance tables ('401', '601', '801', '1101'), or null. */
  tableModel: string | null;
  /** Rated heating capacity (kW) and COP at A7/W35, for units without tables. */
  ratedHeatKw: number;
  ratedCop: number;
  /** Nominal water flow (l/min) at rated conditions — used until a flow has been learnt. */
  ratedFlowLpm: number;
  /** Water flow (l/min) entered by the user; replaces the learnt and rated flow. */
  fixedFlowLpm?: number | null;
  /** Backup heater actually wired (kW), 0 when none, and its step size (Toshiba: 3 kW). */
  backupHeaterKw: number;
  backupStepKw: number;
  /** Separate-cylinder immersion heater (kW); 0 for All-In-One units. */
  immersionKw: number;
  /** Domestic hot water tank volume (l), or null when there is no tank. */
  tankLitres: number | null;
  /**
   * Compressor displacement ÷ overall efficiency (cm³) for the frequency model, or null
   * when unknown (the water model is used then).
   */
  compressorCm3?: number | null;
  /**
   * Draw (W) while the compressor stands still: controls, Modbus interface and remote
   * controller. Omitted = 0, as in replays against a house meter that can't see it.
   */
  standbyW?: number;
  /**
   * Extra draw (W) while the water pump runs: with the compressor (pump and outdoor fan),
   * and with the zone on while the compressor waits (ErP "thermostat off", P_TO).
   */
  runAuxW?: number;
  /**
   * Compressor-winding preheat (W) while stopped in frost — the Estia has no crankcase
   * heater; the inverter warms the winding instead (service manual AE0-2101W p. 104).
   */
  preheatW?: number;
}

export type Activity = 'idle' | 'dhw' | 'heating' | 'cooling';

export interface PowerReading {
  watts: number;
  compressorW: number;
  heaterW: number;
  immersionW: number;
  /** Standby, pump and fan, and winding preheat (PowerConfig standbyW / runAuxW / preheatW). */
  auxW: number;
  thermalW: number;
  activity: Activity;
  compressorOn: boolean;
  /**
   * How the compressor was judged: its frequency (frequency model), the refrigerant
   * sensor TE, or the water temperatures.
   */
  detection: 'frequency' | 'refrigerant' | 'water';
  /** The water-side verdict on its own (also computed when the refrigerant sensor decides). */
  waterSaysOn: boolean;
  /**
   * Energy (kWh) the watts trace missed and that belongs to the meter: when the heater is
   * recognised just after the compressor stopped (DHW hand-over), the time between.
   */
  backfillKwh: number;
}

/** Persisted between restarts (device store). */
export interface LearntState {
  flowSamplesLpm: number[];
}

type Table = { loads: number[]; cap: Record<string, number[]>; input: Record<string, number[]> };
type MaxTable = { lwt: number[]; cap: Record<string, (number | null)[]>; input: Record<string, (number | null)[]> };
interface ModelTables {
  heatingPartLoad: Record<string, Table>;
  coolingPartLoad: Record<string, Table>;
  heatingMax: MaxTable;
}
const MODELS = (tables as unknown as { models: Record<string, ModelTables> }).models;

// R32 saturation pressure (MPa abs.) every 10 °C from −30 to 70 °C (REFPROP).
const R32_SAT_C = [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70];
const R32_SAT_MPA = [0.273, 0.406, 0.581, 0.813, 1.107, 1.474, 1.927, 2.478, 3.140, 3.927, 4.855];
const POLYTROPIC_N = 1.2;
// In heating and hot water, TC sits on the liquid line after the plate heat exchanger
// (service manual AE0-2101W p. 29): it reads subcooled liquid, which leaves at the
// return-water end and can be colder than the leaving water (seen: TC 28 °C at TWO 32 °C
// in floor heating). The refrigerant condenses above the leaving water; literature and
// field data put that approach at 1–5.6 K. 3 K matched the measured input within ±5 %
// at both 28 and 60 °C condensing (AGENTS.md § 7).
export const CONDENSING_APPROACH_K = 3;
// Winding preheat: when TO ≤ −1 °C (and TD < 30 °C), 10 min on / 5 min off down to −3 °C,
// continuously below (service manual AE0-2101W p. 104).
const PREHEAT_ON_C = -1;
const PREHEAT_CONTINUOUS_C = -3;
const PREHEAT_DUTY = 10 / 15;

/** R32 saturation pressure (Pa) at a temperature, interpolated in ln(p) over 1/T. */
export function r32SaturationPa(tempC: number): number {
  const x = 1 / (tempC + 273.15);
  let i = R32_SAT_C.findIndex((t) => t > tempC) - 1;
  if (i < 0) i = tempC < R32_SAT_C[0] ? 0 : R32_SAT_C.length - 2;
  const x0 = 1 / (R32_SAT_C[i] + 273.15);
  const x1 = 1 / (R32_SAT_C[i + 1] + 273.15);
  const y = Math.log(R32_SAT_MPA[i]) + ((x - x0) / (x1 - x0)) * (Math.log(R32_SAT_MPA[i + 1]) - Math.log(R32_SAT_MPA[i]));
  return Math.exp(y) * 1e6;
}

/**
 * Polytropic compression work (J) per m³ of R32 drawn in at the evaporating pressure and
 * pushed to the condensing pressure: n/(n−1) · p1 · ((p2/p1)^((n−1)/n) − 1).
 */
export function compressionWorkJPerM3(evaporatingC: number, condensingC: number): number {
  const p1 = r32SaturationPa(evaporatingC);
  const p2 = r32SaturationPa(Math.max(condensingC, evaporatingC));
  const k = (POLYTROPIC_N - 1) / POLYTROPIC_N;
  return (1 / k) * p1 * ((p2 / p1) ** k - 1);
}

/**
 * Evaporating and condensing temperature for the compression work. Heating and hot water
 * (TC above TE): TE evaporates, and the refrigerant condenses at TC or CONDENSING_APPROACH_K
 * above the leaving water, whichever is higher. Cooling and defrost reverse the cycle: the
 * outdoor coil (TE) condenses, the plate heat exchanger (TC) evaporates.
 */
export function compressionTempsC(evaporatorC: number, condensingC: number, waterOutC: number | null): [number, number] {
  if (condensingC >= evaporatorC) {
    return [evaporatorC, waterOutC == null ? condensingC : Math.max(condensingC, waterOutC + CONDENSING_APPROACH_K)];
  }
  return [condensingC, evaporatorC];
}

/** Electrical input (W) of the compressor from its frequency (frequency model). */
export function frequencyModelWatts(cm3: number, hz: number, evaporatingC: number, condensingC: number): number {
  return hz <= 0 ? 0 : hz * cm3 * 1e-6 * compressionWorkJPerM3(evaporatingC, condensingC);
}

/**
 * C (cm³) from one reading of the outdoor unit's current (CT on the remote controller):
 * P = V × I × power factor (Toshiba: 0.95–0.98 at rated load).
 */
export function compressorCm3FromCurrent(
  currentA: number, hz: number, evaporatingC: number, condensingC: number, volts = 230, powerFactor = 0.97,
): number | null {
  const work = compressionWorkJPerM3(evaporatingC, condensingC);
  if (hz <= 0 || currentA <= 0 || work <= 0) return null;
  return (currentA * volts * powerFactor) / (hz * work * 1e-6);
}

// Detection thresholds. Temperatures arrive as whole degrees unless the interface's
// DIP switch S4-1 selects decidegrees, so thresholds sit at ≥ 2 K.
const REFRIGERANT_ON_K = 4; // |TE − TO| while the compressor runs (observed 9–19 K; idle up to 3 K with sun on the unit)
const WATER_ON_K = 2; // |TWO − TWI| for the water-side fallback
// After the pump stops, the water standing in the unit keeps TWO and TWI apart for
// many minutes (seen: 51 vs 43 °C, then 27 vs 25 °C), so a water ΔT alone doesn't
// prove a running compressor. A start does: the leaving water moves away from the
// return by this much within 2 minutes. Or, after an app start mid-run, a ΔT of at
// least WATER_STEADY_ON_K with a leaving temperature that holds for 5 minutes.
const WATER_START_K = 2;
const WATER_STEADY_ON_K = 3;
const WATER_STEADY_MS = 5 * 60_000;
const HEATER_ON_K = 2; // THO − TWO; sensor offset alone is 0–1 K
// When the pump starts, warm water from the coil passes TWI, TWO and THO in turn and
// THO can read 2 K above TWO for a few seconds; a heater keeps that up for minutes.
const HEATER_MIN_MS = 60_000;
// In a boost the heater is on by design; THO ≥ TWO + 1 K for this long confirms the water flows past it.
const BOOST_HEATER_MIN_MS = 120_000;
const HANDOVER_BACKFILL_MS = 5 * 60_000; // heater recognised this soon after a compressor stop: count from the stop
const DT_SMOOTHING_S = 60; // ΔT time constant against whole-degree jitter
const HEATER_MAX_TWO_DROP_K = 1; // TWO/TWI may fall at most this much per 2 min while the heater runs
const MAX_GAP_MS = 5 * 60_000; // longer gaps reset the trackers
const FLOW_MIN_LPM = 3;
const FLOW_MAX_LPM = 60;
const FLOW_SAMPLES_KEPT = 7;
const LEARN_MIN_S = 10 * 60; // DHW segment long enough to learn flow from
const LEARN_MIN_RISE_K = 8; // whole-degree tank readings: ±1 K must stay a small error

/** Linear interpolation of y over sorted x, extrapolating with the end slopes. */
function interp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0] + (ys[1] - ys[0]) * ((x - xs[0]) / (xs[1] - xs[0] || 1));
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * ((x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1));
  }
  const n = xs.length - 1;
  return ys[n] + (ys[n] - ys[n - 1]) * ((x - xs[n]) / (xs[n] - xs[n - 1] || 1));
}

/** Electrical input (kW) for a thermal output (kW) at one outdoor-temperature row of a part-load table. */
function inputAtRow(table: Table, row: string, thermalKw: number): number {
  const pairs = table.cap[row].map((c, i) => [c, table.input[row][i]] as const)
    // Toshiba repeats the minimum-load row at the lowest loads; keep strictly rising capacity.
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] > arr[i - 1][0]);
  const caps = pairs.map((p) => p[0]);
  const inputs = pairs.map((p) => p[1]);
  if (thermalKw <= caps[0]) return inputs[0] * (thermalKw / caps[0]); // below minimum modulation: cycling
  if (thermalKw >= caps[caps.length - 1]) return inputs[inputs.length - 1] * (thermalKw / caps[caps.length - 1]);
  return interp(caps, inputs, thermalKw);
}

/** Interpolates across the outdoor-temperature rows of a part-load table. */
function inputAtOutdoor(table: Table, outdoorC: number, thermalKw: number): number {
  const rows = Object.keys(table.cap).map(Number).sort((a, b) => a - b);
  const t = Math.min(Math.max(outdoorC, rows[0]), rows[rows.length - 1]);
  let lo = rows[0];
  let hi = rows[rows.length - 1];
  for (const r of rows) {
    if (r <= t) lo = r;
    if (r >= t) {
      hi = r; break;
    }
  }
  const a = inputAtRow(table, String(lo), thermalKw);
  if (hi === lo) return a;
  const b = inputAtRow(table, String(hi), thermalKw);
  return a + (b - a) * ((t - lo) / (hi - lo));
}

/** COP at maximum frequency from the "average heating capacity" table, or null. */
function maxCop(model: ModelTables, outdoorC: number, lwtC: number): number | null {
  const m = model.heatingMax;
  const rows = Object.keys(m.cap).map(Number).sort((a, b) => a - b);
  const t = Math.min(Math.max(outdoorC, rows[0]), rows[rows.length - 1]);
  const copAt = (row: number): number | null => {
    const lwts: number[] = [];
    const cops: number[] = [];
    m.lwt.forEach((l, i) => {
      const c = m.cap[String(row)][i];
      const p = m.input[String(row)][i];
      if (c != null && p != null && p > 0) {
        lwts.push(l); cops.push(c / p);
      }
    });
    return lwts.length >= 2 ? interp(lwts, cops, Math.min(Math.max(lwtC, lwts[0]), lwts[lwts.length - 1])) : null;
  };
  let lo = rows[0];
  let hi = rows[rows.length - 1];
  for (const r of rows) {
    if (r <= t) lo = r;
    if (r >= t) {
      hi = r; break;
    }
  }
  const a = copAt(lo);
  const b = copAt(hi);
  if (a == null || b == null) return a ?? b;
  return hi === lo ? a : a + (b - a) * ((t - lo) / (hi - lo));
}

/** Shape of COP over outdoor/leaving-water temperature, relative to A7/W35 (from the 11 kW tables). */
function copShape(outdoorC: number, lwtC: number): number {
  const ref = MODELS['1101'];
  const at = maxCop(ref, outdoorC, lwtC);
  const base = maxCop(ref, 7, 35);
  return at != null && base ? at / base : 1;
}

/** Electrical input (kW) at the lowest modulation step in the tables (compressor running, little heat out). */
export function minimumInputKw(config: PowerConfig, mode: 'heating' | 'cooling', outdoorC: number, lwtC: number): number {
  const model = config.tableModel ? MODELS[config.tableModel] : undefined;
  if (!model) return 0.3 * (config.ratedHeatKw / config.ratedCop);
  const set = mode === 'cooling' ? model.coolingPartLoad : model.heatingPartLoad;
  const lwts = Object.keys(set).map(Number).sort((a, b) => a - b);
  const lwt = Math.min(Math.max(lwtC, lwts[0]), lwts[lwts.length - 1]);
  const nearest = lwts.reduce((best, l) => (Math.abs(l - lwt) < Math.abs(best - lwt) ? l : best), lwts[0]);
  const table = set[String(nearest)];
  const rows = Object.keys(table.input).map(Number);
  const row = rows.reduce((best, r) => (Math.abs(r - outdoorC) < Math.abs(best - outdoorC) ? r : best), rows[0]);
  return Math.min(...table.input[String(row)]);
}

/** Electrical input (kW) of the compressor for a thermal output (kW). */
export function compressorInputKw(
  config: PowerConfig, mode: 'heating' | 'cooling', thermalKw: number, outdoorC: number, lwtC: number,
): number {
  if (thermalKw <= 0) return 0;
  const model = config.tableModel ? MODELS[config.tableModel] : undefined;
  if (!model) {
    const cop = mode === 'cooling'
      ? Math.max(1.5, config.ratedCop * 0.75) // cooling EER sits ~25 % below heating COP across the range
      : Math.max(1.2, config.ratedCop * copShape(outdoorC, lwtC));
    return thermalKw / cop;
  }
  const set = mode === 'cooling' ? model.coolingPartLoad : model.heatingPartLoad;
  const lwts = Object.keys(set).map(Number).sort((a, b) => a - b);
  const lwt = Math.min(Math.max(lwtC, lwts[0]), lwts[lwts.length - 1]);
  let lo = lwts[0];
  let hi = lwts[lwts.length - 1];
  for (const l of lwts) {
    if (l <= lwt) lo = l;
    if (l >= lwt) {
      hi = l; break;
    }
  }
  const a = inputAtOutdoor(set[String(lo)], outdoorC, thermalKw);
  let kw = hi === lo ? a : a + (inputAtOutdoor(set[String(hi)], outdoorC, thermalKw) - a) * ((lwt - lo) / (hi - lo));
  // Beyond the part-load tables (hot water above 55 °C, or below 35 °C): scale by the
  // maximum-frequency COP ratio between the clamped and the real leaving temperature.
  if (mode === 'heating' && lwtC !== lwt) {
    const copClamped = maxCop(model, outdoorC, lwt);
    const copReal = maxCop(model, outdoorC, lwtC);
    if (copClamped && copReal) kw *= copClamped / copReal;
  }
  return kw;
}

/** Stateful estimator: feed every poll in order, read the electrical power back. */
export class PowerEstimator {
  private last: PowerSample | null = null;
  private dtSmoothed: number | null = null;
  private waterOn = false;
  private waterOffStreak = 0;
  private waterDtSinceMs: number | null = null;
  private heaterSinceMs: number | null = null;
  private boostHeaterSinceMs: number | null = null;
  private compressorWasOn = false;
  private compressorStopMs: number | null = null;
  private heaterWasOn = false;
  private flowSamples: number[];
  private segment: { startMs: number; lastMs: number; tank0: number; tankLast: number; kSeconds: number; clean: boolean } | null = null;
  private tankHistory: Array<{ t: number; c: number }> = [];
  private twoHistory: Array<{ t: number; c: number }> = [];
  private twiHistory: Array<{ t: number; c: number }> = [];
  private thoHistory: Array<{ t: number; c: number }> = [];
  private twoLongHistory: Array<{ t: number; c: number }> = [];

  constructor(private config: PowerConfig, learnt?: LearntState) {
    this.flowSamples = [...(learnt?.flowSamplesLpm ?? [])].filter((f) => f >= FLOW_MIN_LPM && f <= FLOW_MAX_LPM);
  }

  setConfig(config: PowerConfig): void {
    this.config = config;
  }

  /** Learnt state to persist. */
  get learnt(): LearntState {
    return { flowSamplesLpm: [...this.flowSamples] };
  }

  /** Flow in l/min: the user's value, else the median of learnt DHW runs, else the rated flow. */
  get flowLpm(): number {
    if (this.config.fixedFlowLpm) return this.config.fixedFlowLpm;
    if (this.flowSamples.length === 0) return this.config.ratedFlowLpm;
    const s = [...this.flowSamples].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  get flowIsLearnt(): boolean {
    return this.flowSamples.length > 0;
  }

  update(s: PowerSample): PowerReading {
    const prev = this.last;
    const gap = prev ? s.timeMs - prev.timeMs : Infinity;
    if (gap > MAX_GAP_MS) this.reset();
    this.last = s;

    PowerEstimator.track(this.twoHistory, s.timeMs, s.twoC, 2 * 60_000);
    PowerEstimator.track(this.twiHistory, s.timeMs, s.twiC, 2 * 60_000);
    PowerEstimator.track(this.thoHistory, s.timeMs, s.thoC, 2 * 60_000);
    PowerEstimator.track(this.twoLongHistory, s.timeMs, s.twoC, WATER_STEADY_MS);
    if (s.tankC != null) {
      this.tankHistory.push({ t: s.timeMs, c: s.tankC });
      while (this.tankHistory.length > 0 && s.timeMs - this.tankHistory[0].t > 10 * 60_000) this.tankHistory.shift();
    }

    const idleAuxKw = this.auxKw(s, false);
    const idle: PowerReading = {
      watts: Math.round(idleAuxKw * 1000), compressorW: 0, heaterW: 0, immersionW: 0, auxW: Math.round(idleAuxKw * 1000),
      thermalW: 0, activity: 'idle', compressorOn: false, detection: 'water', waterSaysOn: false, backfillKwh: 0,
    };
    if (s.twiC == null || s.twoC == null) return idle;
    const rawDt = s.twoC - s.twiC;

    // Smooth ΔT against whole-degree quantisation.
    const dtS = Number.isFinite(gap) ? gap / 1000 : DT_SMOOTHING_S;
    const alpha = 1 - Math.exp(-dtS / DT_SMOOTHING_S);
    this.dtSmoothed = this.dtSmoothed == null ? rawDt : this.dtSmoothed + alpha * (rawDt - this.dtSmoothed);

    // ── Compressor on? ──────────────────────────────────────────────────
    const demand = s.zoneOn || s.dhwOn;
    const waterSaysOn = this.waterDetector(s, rawDt, demand);
    let compressorOn: boolean;
    let detection: PowerReading['detection'];
    const frequencyModel = !!this.config.compressorCm3 && s.compressorHz != null
      && s.evaporatorC != null && s.condensingC != null;
    if (frequencyModel) {
      detection = 'frequency';
      compressorOn = s.compressorHz! > 0;
    } else if (s.evaporatorC != null && s.outdoorC != null) {
      detection = 'refrigerant';
      compressorOn = Math.abs(s.evaporatorC - s.outdoorC) >= REFRIGERANT_ON_K;
    } else {
      detection = 'water';
      compressorOn = waterSaysOn;
    }

    // ── What is being served? Register 40003 keeps its last value while the zone is
    // off, so the zone mode only counts while the zone is on. ────────────────
    let activity: Activity = 'idle';
    if (compressorOn) {
      if (s.dhwOn && !s.zoneOn) activity = 'dhw'; // the 3-way valve can only point at the tank
      else if (s.zoneOn && !s.dhwOn) activity = s.coolMode ? 'cooling' : 'heating';
      else if (this.dtSmoothed <= -1) activity = 'cooling';
      else if (s.zoneOn && (s.coolMode || this.tankRising())) activity = 'dhw'; // cooling never warms the water
      else activity = 'heating'; // zone heating, or no demand (frost protection, anti-legionella)
    }

    // ── Compressor electrical input ─────────────────────────────────────
    const flowLps = this.flowLpm / 60;
    const thermalKw = compressorOn ? Math.max(0, flowLps * WATER_KJ_PER_L_K * Math.abs(this.dtSmoothed)) : 0;
    const outdoor = s.outdoorC ?? 7;
    const mode = activity === 'cooling' ? 'cooling' : 'heating';
    let compressorKw: number;
    if (detection === 'frequency') {
      const [low, high] = compressionTempsC(s.evaporatorC!, s.condensingC!, s.twoC);
      compressorKw = frequencyModelWatts(this.config.compressorCm3!, s.compressorHz!, low, high) / 1000;
    } else {
      compressorKw = compressorOn ? compressorInputKw(this.config, mode, thermalKw, outdoor, s.twoC) : 0;
    }
    // The refrigerant sensors prove the compressor turns: it draws at least its lowest
    // modulation step, also while the water loop is still warming up after a start.
    if (compressorOn && detection === 'refrigerant') {
      compressorKw = Math.max(compressorKw, minimumInputKw(this.config, mode, outdoor, s.twoC));
    }

    // ── Backup heater: heats the water between TWO and THO ──────────────
    let heaterKw = 0;
    const heaterDt = s.thoC != null ? s.thoC - s.twoC : 0;
    // A heater only warms flowing water. After the pump stops, THO stays hot while TWO and
    // TWI cool fast, and the standing water drifts apart for many minutes — neither is a
    // heater. So the return (TWI) must hold steady, and:
    // - compressor on: TWO and THO steady too (2 minutes);
    // - compressor off: the water flows through the idle condenser, so TWO stays near TWI
    //   (at most 1 K warmer, up to 3 K cooler). When the compressor hands over to the heater
    //   (DHW: return water at its limit), TWO and THO drop a few degrees first while TWI
    //   stays at least as warm as TWO.
    const drop = (h: Array<{ c: number }>, now: number) => (h.length > 0 ? Math.max(...h.map((x) => x.c)) - now : 0);
    const twoThoSteady = drop(this.twoHistory, s.twoC) <= HEATER_MAX_TWO_DROP_K
      && (s.thoC == null || drop(this.thoHistory, s.thoC) <= HEATER_MAX_TWO_DROP_K);
    const flowing = compressorOn ? twoThoSteady : rawDt <= 1 && rawDt >= -3 && (s.twiC >= s.twoC || twoThoSteady);
    const waterSteady = drop(this.twiHistory, s.twiC) <= HEATER_MAX_TWO_DROP_K && flowing;
    // Standing water can also cool so slowly that it looks steady and flowing (seen: TWI 43,
    // TWO 44, THO 46 °C for 25 minutes with nothing asked for). A heater only runs for a
    // demand, or for anti-legionella / a boost outside it — which then heats the tank.
    // With the compressor running, THO sits 1–2 K above TWO from sensor offsets alone
    // (whole degrees flip between 1 and 2); a 3 kW step at the Estia's hot-water flow
    // (~12 l/min) adds ~3.6 K. In space heating at ~30 l/min a step adds only ~1.4 K, too
    // little to see next to a running compressor with whole-degree sensors.
    const heaterOnK = compressorOn ? HEATER_ON_K + 1 : HEATER_ON_K;
    const heaterPossible = this.config.backupHeaterKw > 0 && heaterDt >= heaterOnK && waterSteady
      && (demand || this.tankRising());
    if (!heaterPossible) this.heaterSinceMs = null;
    else if (this.heaterSinceMs == null) this.heaterSinceMs = s.timeMs;
    // Boost: Toshiba switches the backup heater on at once and keeps it on until the tank
    // reaches the boost set point (service manual § 7-3, items 8 and 10). The water flow is
    // then anything from ~12 to ~26 l/min (seen), so its ΔT says too little: count the
    // heater's rating while THO stays above TWO.
    const boostHeater = this.config.backupHeaterKw > 0 && !!s.boostActive && s.dhwOn && s.thoC != null
      && heaterDt >= 1 && (s.boostSetpointC == null || s.tankC == null || s.tankC < s.boostSetpointC);
    if (!boostHeater) this.boostHeaterSinceMs = null;
    else if (this.boostHeaterSinceMs == null) this.boostHeaterSinceMs = s.timeMs;
    if (this.boostHeaterSinceMs != null && s.timeMs - this.boostHeaterSinceMs >= BOOST_HEATER_MIN_MS) {
      heaterKw = this.config.backupHeaterKw;
      if (activity === 'idle') activity = 'dhw';
    } else if (this.heaterSinceMs != null && s.timeMs - this.heaterSinceMs >= HEATER_MIN_MS) {
      const step = this.config.backupStepKw > 0 ? this.config.backupStepKw : this.config.backupHeaterKw;
      const measured = flowLps * WATER_KJ_PER_L_K * heaterDt;
      const steps = Math.max(1, Math.round(measured / step));
      heaterKw = Math.min(this.config.backupHeaterKw, steps * step);
      if (activity === 'idle') activity = s.dhwOn ? 'dhw' : 'heating';
    }

    // ── Immersion (separate cylinder): tank rising with nothing else heating it ──
    let immersionKw = 0;
    if (this.config.immersionKw > 0 && s.dhwOn && !compressorOn && heaterKw === 0 && this.tankRising()) {
      immersionKw = this.config.immersionKw;
      activity = 'dhw';
    }

    // DHW hand-over: the heater takes over the moment the compressor stops, but is only
    // recognised once the water has settled (1–3 polls later). Book the gap on the meter.
    if (this.compressorWasOn && !compressorOn) this.compressorStopMs = s.timeMs;
    let backfillKwh = 0;
    if (heaterKw > 0 && !this.heaterWasOn && prev && this.compressorStopMs != null
      && s.timeMs - this.compressorStopMs <= HANDOVER_BACKFILL_MS) {
      // The trapezoid from the previous poll already counts half of that interval.
      const missedMs = s.timeMs - this.compressorStopMs - (s.timeMs - prev.timeMs) / 2;
      backfillKwh = (heaterKw * Math.max(0, missedMs)) / 3_600_000;
    }
    if (compressorOn) this.compressorStopMs = null;
    this.compressorWasOn = compressorOn;
    this.heaterWasOn = heaterKw > 0;

    this.learnFlow(s, activity, compressorOn, heaterKw > 0);

    const auxKw = this.auxKw(s, compressorOn);
    const watts = Math.round((compressorKw + heaterKw + immersionKw + auxKw) * 1000);
    return {
      watts,
      compressorW: Math.round(compressorKw * 1000),
      heaterW: Math.round(heaterKw * 1000),
      immersionW: Math.round(immersionKw * 1000),
      auxW: Math.round(auxKw * 1000),
      thermalW: Math.round(thermalKw * 1000),
      activity,
      compressorOn,
      detection,
      waterSaysOn,
      backfillKwh,
    };
  }

  /**
   * The unit's own draw (kW): standby; plus pump and fan while the compressor runs, or the
   * pump alone while the zone is on and the compressor waits (measured ~20 W above standby,
   * ErP P_TO − P_SB 42 W); plus winding preheat in frost.
   */
  private auxKw(s: PowerSample, compressorOn: boolean): number {
    const { standbyW = 0, runAuxW = 0, preheatW = 0 } = this.config;
    let w = standbyW;
    if (compressorOn || s.zoneOn) w += runAuxW;
    if (!compressorOn && preheatW > 0 && s.outdoorC != null && s.outdoorC <= PREHEAT_ON_C) {
      w += s.outdoorC <= PREHEAT_CONTINUOUS_C ? preheatW : preheatW * PREHEAT_DUTY;
    }
    return w / 1000;
  }

  /**
   * Water-side compressor detection, for units without a usable TE register. Switches on
   * at a start (leaving water moving away from the return in the expected direction) or
   * after a steady ΔT for 5 minutes; off after two polls without the expected ΔT.
   */
  private waterDetector(s: PowerSample, rawDt: number, demand: boolean): boolean {
    // Expected direction of TWO − TWI: hot water and heating warm the water, cooling
    // chills it; with cooling and hot water both on, either.
    const up = s.dhwOn || (s.zoneOn && !s.coolMode);
    const down = s.zoneOn && s.coolMode;
    let along = up ? rawDt : -rawDt;
    if (up && down) along = Math.abs(rawDt);
    const dtOk = demand && along >= WATER_ON_K;
    if (!dtOk) this.waterDtSinceMs = null;
    else if (this.waterDtSinceMs == null) this.waterDtSinceMs = s.timeMs;

    if (this.waterOn) {
      this.waterOffStreak = dtOk ? 0 : this.waterOffStreak + 1;
      if (this.waterOffStreak >= 2) this.waterOn = false;
      return this.waterOn;
    }
    if (!dtOk) return false;
    const two = this.twoHistory.map((x) => x.c);
    const rise = s.twoC! - Math.min(...two);
    const fall = Math.max(...two) - s.twoC!;
    const started = (up && rise >= WATER_START_K) || (down && fall >= WATER_START_K);
    const long = this.twoLongHistory.map((x) => x.c);
    const steady = this.waterDtSinceMs != null && s.timeMs - this.waterDtSinceMs >= WATER_STEADY_MS
      && along >= WATER_STEADY_ON_K && Math.max(...long) - Math.min(...long) <= 1;
    if (started || steady) {
      this.waterOn = true;
      this.waterOffStreak = 0;
    }
    return this.waterOn;
  }

  private reset(): void {
    this.dtSmoothed = null;
    this.waterOn = false;
    this.waterOffStreak = 0;
    this.waterDtSinceMs = null;
    this.heaterSinceMs = null;
    this.boostHeaterSinceMs = null;
    this.compressorWasOn = false;
    this.compressorStopMs = null;
    this.heaterWasOn = false;
    this.segment = null;
    this.tankHistory = [];
    this.twoHistory = [];
    this.twiHistory = [];
    this.thoHistory = [];
    this.twoLongHistory = [];
  }

  private static track(history: Array<{ t: number; c: number }>, t: number, c: number | null, windowMs: number): void {
    if (c == null) return;
    history.push({ t, c });
    while (history.length > 0 && t - history[0].t > windowMs) history.shift();
  }

  /** Tank temperature rose by ≥ 1 K over the last 10 minutes. */
  private tankRising(): boolean {
    const h = this.tankHistory;
    return h.length >= 2 && h[h.length - 1].c - Math.min(...h.map((x) => x.c)) >= 1;
  }

  /**
   * Flow calibration on DHW runs: delivered heat = tank volume × ΔTTW, and the same
   * heat = flow × ∫ΔT dt, so flow = volume × ΔTTW / ∫ΔT dt. Only uninterrupted
   * compressor-only segments count; hot water drawn during the run biases low, so the
   * median of several runs is used.
   */
  private learnFlow(s: PowerSample, activity: Activity, compressorOn: boolean, heaterOn: boolean): void {
    const volume = this.config.tankLitres;
    if (!volume || s.tankC == null || s.twoC == null || s.twiC == null) return;
    const active = compressorOn && activity === 'dhw';
    if (active) {
      if (!this.segment) {
        // Start from the tank temperature before the run: the tank sensor dips ~1 K when
        // the pump starts pulling water through the coil.
        const tank0 = Math.max(s.tankC, ...this.tankHistory.map((x) => x.c));
        this.segment = {
          startMs: s.timeMs, lastMs: s.timeMs, tank0, tankLast: s.tankC, kSeconds: 0, clean: true,
        };
      } else {
        const dtS = (s.timeMs - this.segment.lastMs) / 1000;
        this.segment.kSeconds += Math.max(0, s.twoC - s.twiC) * dtS;
        this.segment.lastMs = s.timeMs;
        this.segment.tankLast = s.tankC;
      }
      if (heaterOn) this.segment.clean = false;
      return;
    }
    const seg = this.segment;
    this.segment = null;
    if (!seg || !seg.clean) return;
    const durationS = (seg.lastMs - seg.startMs) / 1000;
    const rise = seg.tankLast - seg.tank0;
    if (durationS < LEARN_MIN_S || rise < LEARN_MIN_RISE_K || seg.kSeconds <= 0) return;
    const flowLpm = ((volume * rise) / seg.kSeconds) * 60;
    if (flowLpm < FLOW_MIN_LPM || flowLpm > FLOW_MAX_LPM) return;
    this.flowSamples.push(flowLpm);
    while (this.flowSamples.length > FLOW_SAMPLES_KEPT) this.flowSamples.shift();
  }
}

/** Persisted between restarts (device store). */
export interface RefrigerantCheckState {
  /** Quiet-water polls with TE next to the outdoor temperature. */
  idleAgree: number;
  /** Polls with the compressor clearly running (water side) and TE away from outdoor. */
  runConfirm: number;
  /** Polls with the compressor clearly running but TE still next to outdoor. */
  runMiss: number;
}

const CHECK_MIN_IDLE = 20;
const CHECK_MIN_RUN = 5; // polls; with the frequency in the check, a few are conclusive
const CHECK_COUNT_CAP = 1000;

/**
 * Registers 40028 (TE), 40032 (compressor Hz) and 40021 (TC) carry these values on the
 * R32 unit this was built on, but they're not in Toshiba's register list, so another
 * unit may put something else there. Trust them only once they behaved that way on this
 * unit: TE next to the outdoor temperature and 0 Hz while the water is quiet; TE well
 * away from outdoor, Hz above 0 and TC at or above the return water while the water
 * side shows a run. A constant or an outdoor-like value never passes both.
 */
export class RefrigerantSensorCheck {
  private state: RefrigerantCheckState;
  private runStreak = 0;

  constructor(state?: Partial<RefrigerantCheckState>) {
    this.state = { idleAgree: state?.idleAgree ?? 0, runConfirm: state?.runConfirm ?? 0, runMiss: state?.runMiss ?? 0 };
  }

  get snapshot(): RefrigerantCheckState {
    return { ...this.state };
  }

  get trusted(): boolean {
    const { idleAgree, runConfirm, runMiss } = this.state;
    // A wrong register misses on every running poll; real ones only around starts and stops.
    return idleAgree >= CHECK_MIN_IDLE && runConfirm >= CHECK_MIN_RUN && runMiss * 2 <= runConfirm;
  }

  /** `waterSaysOn`: the estimator's water-side verdict for the same poll (PowerReading.waterSaysOn). */
  update(s: PowerSample, waterSaysOn: boolean): void {
    if (s.evaporatorC == null || s.outdoorC == null || s.twiC == null || s.twoC == null) {
      this.runStreak = 0;
      return;
    }
    const away = Math.abs(s.evaporatorC - s.outdoorC);
    const waterDt = Math.abs(s.twoC - s.twiC);
    const hz = s.compressorHz;
    this.runStreak = waterSaysOn ? this.runStreak + 1 : 0;
    const bump = (key: keyof RefrigerantCheckState) => {
      this.state[key] = Math.min(CHECK_COUNT_CAP, this.state[key] + 1);
    };
    if (this.runStreak >= 3) {
      // While heating, TC reads the liquid leaving the plate heat exchanger at the return-water
      // end: at or above the return (TWI), whole degrees allowing 2 K. Not TWO: in floor
      // heating TC sits up to 5 K below the leaving water (2026-10-13).
      const tcOk = s.condensingC == null || s.twoC <= s.twiC || s.condensingC >= s.twiC - 2;
      bump(away >= REFRIGERANT_ON_K && (hz == null || hz > 0) && tcOk ? 'runConfirm' : 'runMiss');
    } else if (away <= 2 && (hz == null ? waterDt <= 1 : hz === 0)) {
      // Standing water keeps TWI and TWO apart for hours; with a frequency, 0 Hz says idle.
      bump('idleAgree');
    }
  }
}

/** Energy (kWh) between two readings, trapezoidal; gaps longer than MAX_GAP_MS count only up to that limit. */
export function energyKwh(prevWatts: number, watts: number, intervalMs: number): number {
  const ms = Math.min(Math.max(0, intervalMs), MAX_GAP_MS);
  return (((prevWatts + watts) / 2) * (ms / 3_600_000)) / 1000;
}
