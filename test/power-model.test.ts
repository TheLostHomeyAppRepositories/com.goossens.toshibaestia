/* eslint-disable node/no-unsupported-features/es-syntax */
/**
 * Replays recorded polls through the power model and compares with a whole-house
 * meter. Fixtures: an R32 1 Series 11 kW All-In-One (HWT-1101F21ST6W-E, one 3 kW
 * backup-heater stage wired) with a 210 l tank, polled every ~15 s; `houseW` is the
 * house consumption from a battery/PV gateway, so heat pump power = houseW − the
 * house's base load. Other appliances switch up to ~1 kW during the runs, so the
 * sharpest references are single-poll steps in houseW and the tank's own heat-up.
 *
 * - r32s1-1101-dhw-2026-10-03.csv: tank 29 → 45 °C on the compressor (09:36–10:08 UTC).
 * - r32s1-1101-dhw-heater-2026-10-03.csv: tank 45 → 51 °C on the compressor until the
 *   return water reached 56 °C (12:06–12:28 UTC), then 51 → 54 °C on the backup heater
 *   (12:28:03–12:40:36 UTC: +1895 W / −3185 W steps in houseW).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  PowerEstimator, PowerConfig, PowerSample, RefrigerantSensorCheck, compressorInputKw, energyKwh,
  compressorCm3FromCurrent, frequencyModelWatts,
} from '../drivers/heatpump/power-model';

interface Row extends PowerSample { houseW: number }

function load(file: string, evaporator: 'te' | 'none' | 'outdoor' | 'constant' = 'te'): Row[] {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const num = (v: string): number | null => (v === '' || v === '-32768' ? null : Number(v));
  return lines.slice(1).map((line) => {
    const c = Object.fromEntries(line.split(',').map((v, i) => [head[i], v]));
    const evaporatorC = {
      te: num(c.te), none: null, outdoor: num(c.outdoor), constant: 63,
    }[evaporator];
    return {
      timeMs: Date.parse(c.time),
      zoneOn: c.zoneOn === '1',
      dhwOn: c.dhwOn === '1',
      coolMode: c.mode === '2',
      outdoorC: num(c.outdoor),
      twiC: num(c.twi),
      twoC: num(c.two),
      thoC: num(c.tho),
      tankC: num(c.tank),
      evaporatorC,
      condensingC: evaporator === 'te' ? num(c.tc) : null,
      compressorHz: evaporator === 'te' ? num(c.hz) : null,
      houseW: Number(c.houseW),
    };
  });
}

const R32_1101_AIO: PowerConfig = {
  tableModel: '1101',
  ratedHeatKw: 11,
  ratedCop: 4.6,
  ratedFlowLpm: 31.8,
  backupHeaterKw: 3,
  backupStepKw: 3,
  immersionKw: 0,
  tankLitres: 210,
};

/** Same unit with the frequency model: C from the CT reading and house-meter steps below. */
const R32_1101_HZ: PowerConfig = { ...R32_1101_AIO, compressorCm3: 29.3 };

const FIXTURE = 'r32s1-1101-dhw-2026-10-03.csv';
const FIXTURE_HEATER = 'r32s1-1101-dhw-heater-2026-10-03.csv';
const at = (iso: string) => Date.parse(iso);

/**
 * Real heat pump energy over the run: house consumption above the base load. The base
 * load is the mean of the quiet periods before the DHW timer (09:20–09:30 UTC) and
 * after the stop (10:09–10:16 UTC): other appliances change by up to ~1 kW, which is
 * the main uncertainty of this reference (about ±10 %).
 */
function replay(rows: Row[], estimator: PowerEstimator) {
  const readings = rows.map((r) => estimator.update(r));
  const within = (from: string, to: string) => rows.filter((r) => {
    const t = new Date(r.timeMs).toISOString().slice(11, 19);
    return t >= from && t < to;
  }).map((r) => r.houseW).sort((a, b) => a - b);
  const median = (v: number[]) => v[Math.floor(v.length / 2)];
  const base = (median(within('09:20', '09:30')) + median(within('10:09', '10:16'))) / 2;
  let modelKwh = 0;
  let realKwh = 0;
  rows.forEach((r, i) => {
    if (i === 0) return;
    const t = new Date(r.timeMs).toISOString().slice(11, 19);
    if (t < '09:36:30' || t > '10:08:30') return; // compressor run, from the refrigerant sensors
    const ms = r.timeMs - rows[i - 1].timeMs;
    modelKwh += energyKwh(readings[i - 1].watts, readings[i].watts, ms);
    realKwh += energyKwh(rows[i - 1].houseW - base, r.houseW - base, ms);
  });
  const first = readings.findIndex((x) => x.watts > 0);
  return {
    readings, first, base, modelKwh, realKwh,
  };
}

/** Heat delivered by the model (thermal W integrated) and by the tank (volume × rise) between two times. */
function heatCheck(rows: Row[], readings: ReturnType<PowerEstimator['update']>[], fromMs: number, toMs: number) {
  let modelKwh = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.timeMs <= fromMs || r.timeMs > toMs) return;
    modelKwh += energyKwh(readings[i - 1].thermalW, readings[i].thermalW, r.timeMs - rows[i - 1].timeMs);
  });
  const tankAt = (ms: number) => rows.filter((r) => r.timeMs <= ms).pop()!.tankC!;
  const tankKwh = (210 * 4.186 * (tankAt(toMs) - tankAt(fromMs))) / 3600;
  return { modelKwh, tankKwh };
}

test('table lookup matches the Data Book at its own grid points', () => {
  // 1101, LWT 35, TO 7 °C: 6.44 kW at 50 % load needs 1.57 kW input.
  assert.ok(Math.abs(compressorInputKw(R32_1101_AIO, 'heating', 6.44, 7, 35) - 1.57) < 0.01);
  // 1101 cooling, LWT 7, TO 35 °C: 4.79 kW at 60 % load needs 1.72 kW.
  assert.ok(Math.abs(compressorInputKw(R32_1101_AIO, 'cooling', 4.79, 35, 7) - 1.72) < 0.01);
  // Hotter water costs more for the same heat.
  assert.ok(compressorInputKw(R32_1101_AIO, 'heating', 7, 20, 60) > compressorInputKw(R32_1101_AIO, 'heating', 7, 20, 55));
});

test('DHW run: energy within 15 % of the house meter (refrigerant detection)', () => {
  const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
  const r = replay(load(FIXTURE), est);
  const err = (r.modelKwh - r.realKwh) / r.realKwh;
  assert.ok(Math.abs(err) < 0.15, `model ${r.modelKwh.toFixed(2)} kWh vs real ${r.realKwh.toFixed(2)} kWh (${(err * 100).toFixed(0)} %)`);
  assert.equal(r.readings[r.first].detection, 'refrigerant');
  assert.equal(r.readings[r.first + 10].activity, 'dhw');
});

test('DHW run: same accuracy with water sensors only (units without 40028)', () => {
  const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
  const r = replay(load(FIXTURE, 'none'), est);
  const err = (r.modelKwh - r.realKwh) / r.realKwh;
  assert.ok(Math.abs(err) < 0.2, `model ${r.modelKwh.toFixed(2)} kWh vs real ${r.realKwh.toFixed(2)} kWh (${(err * 100).toFixed(0)} %)`);
  assert.equal(r.readings[r.first].detection, 'water');
});

test('compressor power just before the stop matches the step in the house meter within 10 %', () => {
  // The stop is a single-poll drop in houseW: independent of the base load.
  const rows = load(FIXTURE);
  const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
  const readings = rows.map((r) => est.update(r));
  // 10:08:01 UTC; an appliance's 2.1 kW one-minute spike at 09:39–09:40 is not the heat pump.
  const i = rows.findIndex((r, k) => k > 0 && r.timeMs > at('2026-10-03T10:00:00Z') && rows[k - 1].houseW - r.houseW > 1500);
  const step = rows[i - 1].houseW - rows[i].houseW;
  const model = readings[i - 1].watts;
  assert.ok(Math.abs(model - step) / step < 0.1, `model ${model} W vs step ${step} W`);
});

test('thermal output adds up to the tank heat-up within 10 %', () => {
  // Checks flow × ΔT, the half of the model that doesn't depend on Toshiba's tables.
  for (const [file, from, to] of [
    [FIXTURE, '2026-10-03T09:36:30Z', '2026-10-03T10:08:00Z'],
    [FIXTURE_HEATER, '2026-10-03T12:06:00Z', '2026-10-03T12:28:00Z'],
  ]) {
    const rows = load(file);
    const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.4] });
    const readings = rows.map((r) => est.update(r));
    const { modelKwh, tankKwh } = heatCheck(rows, readings, at(from), at(to));
    assert.ok(Math.abs(modelKwh - tankKwh) / tankKwh < 0.1, `${file}: model ${modelKwh.toFixed(2)} kWh vs tank ${tankKwh.toFixed(2)} kWh`);
  }
});

test('hot water only: never reported as cooling, also at the compressor start', () => {
  // Register 40003 still says "cool" (2) in this fixture; the zone is off.
  for (const file of [FIXTURE, FIXTURE_HEATER]) {
    const rows = load(file);
    const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.4] });
    rows.forEach((r) => {
      const reading = est.update(r);
      if (reading.compressorOn) assert.equal(reading.activity, 'dhw', `${file} ${new Date(r.timeMs).toISOString()}`);
    });
  }
});

test('backup heater: seen within 3.5 minutes, at its rating, and gone within one poll after it stops', () => {
  const rows = load(FIXTURE_HEATER);
  const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.4] });
  const readings = rows.map((r) => est.update(r));
  const heaterOn = at('2026-10-03T12:28:03Z');
  const heaterOff = at('2026-10-03T12:40:36Z');
  const firstSeen = rows.findIndex((r, i) => readings[i].heaterW > 0);
  assert.ok(rows[firstSeen].timeMs - heaterOn < 3.5 * 60_000, `heater seen at ${new Date(rows[firstSeen].timeMs).toISOString()}`);
  rows.forEach((r, i) => {
    if (r.timeMs < heaterOn) assert.equal(readings[i].heaterW, 0, `false heater at ${new Date(r.timeMs).toISOString()}`);
    if (r.timeMs > heaterOff + 20_000) assert.equal(readings[i].watts, 0, `still ${readings[i].watts} W at ${new Date(r.timeMs).toISOString()}`);
    if (readings[i].heaterW > 0) assert.equal(readings[i].heaterW, 3000);
  });
  // The heater's own step in the house meter: 3185 W at ~235 V for a 3 kW (230 V) element.
  const step = rows.find((r) => r.timeMs >= heaterOff)!;
  const before = rows.filter((r) => r.timeMs < heaterOff).pop()!;
  assert.ok(Math.abs(before.houseW - step.houseW - 3000) / 3000 < 0.1);
});

test('zero watts while the compressor is off, even with the stored zone mode on "cool"', () => {
  const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
  const rows = load(FIXTURE);
  const readings = rows.map((r) => est.update(r));
  rows.forEach((row, i) => {
    const hhmm = new Date(row.timeMs).toISOString().slice(11, 16);
    // Before the compressor starts (09:36 UTC) and once it has stopped (10:08:30 UTC).
    if (hhmm < '09:36' || hhmm >= '10:09') assert.equal(readings[i].watts, 0, `${hhmm} reads ${readings[i].watts} W`);
  });
});

test('standing water after the hot-water window: no heater, no compressor (evening of 2026-10-03)', () => {
  // Zone and hot water off; the water in the unit cools slowly with THO 2 K above TWO.
  for (const step of [1, 4]) { // every poll (~17 s) and every 4th (~70 s, like the app)
    const rows = load('r32s1-1101-standing-water-2026-10-03.csv').filter((_, i) => i % step === 0);
    const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.4] });
    rows.forEach((r) => {
      const reading = est.update({ ...r, evaporatorC: null });
      assert.equal(reading.watts, 0, `${reading.watts} W at ${new Date(r.timeMs).toISOString()}`);
    });
  }
});

test('learns the installation flow from the tank, starting from the rated flow', () => {
  const est = new PowerEstimator(R32_1101_AIO);
  assert.equal(est.flowIsLearnt, false);
  load(FIXTURE).forEach((r) => est.update(r));
  assert.ok(est.flowIsLearnt, 'flow not learnt from a 16 K tank run');
  assert.ok(est.flowLpm > 14 && est.flowLpm < 22, `learnt ${est.flowLpm.toFixed(1)} l/min, measured 17–18`);
});

test('register 40028 is trusted only when it behaves like TE', () => {
  const run = (evaporator: 'te' | 'outdoor' | 'constant') => {
    const check = new RefrigerantSensorCheck();
    const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
    load(FIXTURE, evaporator).forEach((r) => check.update(r, est.update({ ...r, evaporatorC: null }).waterSaysOn));
    return check;
  };
  assert.equal(run('te').trusted, true, JSON.stringify(run('te').snapshot));
  assert.equal(run('outdoor').trusted, false, 'an outdoor-like value never leaves the outdoor temperature');
  assert.equal(run('constant').trusted, false, 'a constant never sits at the outdoor temperature');
  // The verdict survives a restart.
  assert.equal(new RefrigerantSensorCheck(run('te').snapshot).trusted, true);
});

// ── Frequency model ────────────────────────────────────────────────────────────
// References on the same 11 kW unit, each a direct electrical measurement:
// - CT on the remote controller, 2026-10-04 11:40: 14.6 A at 71 Hz, TE 13 °C, TC 59 °C
//   → 14.6 A × 235 V × 0.98 (Toshiba's power factor) = 3362 W;
// - compressor stop, 2026-10-03 10:08:01 UTC: −1973 W in one poll at 45 Hz;
// - 45 → 30 Hz, 2026-10-03 12:16:56 UTC: −678 W in one poll.
// C = 29.3 cm³ is fitted on these three; the Data Book's maximum-frequency table gives
// 33.5 cm³ for this model before scaling (see AGENTS.md § 7).

test('frequency model: the three electrical references agree on one constant (±6 %)', () => {
  const ct = 14.6 * 235 * 0.98;
  assert.ok(Math.abs(frequencyModelWatts(29.3, 71, 13, 59) - ct) / ct < 0.06, `${frequencyModelWatts(29.3, 71, 13, 59).toFixed(0)} W vs CT ${ct.toFixed(0)} W`);
  const rows = load(FIXTURE);
  const stop = rows.filter((r) => r.timeMs < at('2026-10-03T10:08:01Z')).pop()!;
  const atStop = frequencyModelWatts(29.3, stop.compressorHz!, stop.evaporatorC!, stop.condensingC!);
  assert.ok(Math.abs(atStop - 1973) / 1973 < 0.06, `${atStop.toFixed(0)} W vs step 1973 W at ${stop.compressorHz} Hz`);
  const heater = load(FIXTURE_HEATER);
  const before = heater.filter((r) => r.timeMs < at('2026-10-03T12:16:56Z')).pop()!;
  const drop = frequencyModelWatts(29.3, 45, before.evaporatorC!, before.condensingC!) - frequencyModelWatts(29.3, 30, before.evaporatorC!, before.condensingC!);
  assert.ok(Math.abs(drop - 678) / 678 < 0.1, `${drop.toFixed(0)} W vs step 678 W`);
  // The calibration helper recovers the constant from the CT reading.
  assert.ok(Math.abs(compressorCm3FromCurrent(14.6, 71, 13, 59, 235, 0.98)! - 30.7) < 0.5);
});

test('frequency model: zero watts whenever the compressor reports 0 Hz, heater still seen', () => {
  for (const file of [FIXTURE, FIXTURE_HEATER, 'r32s1-1101-standing-water-2026-10-03.csv']) {
    const est = new PowerEstimator(R32_1101_HZ, { flowSamplesLpm: [17.4] });
    load(file).forEach((r) => {
      const reading = est.update(r);
      assert.equal(reading.detection, 'frequency');
      if (r.compressorHz === 0) assert.equal(reading.compressorW, 0, `${file} ${new Date(r.timeMs).toISOString()}`);
      if (r.compressorHz! > 0) assert.ok(reading.compressorW > 0);
    });
  }
  const est = new PowerEstimator(R32_1101_HZ, { flowSamplesLpm: [17.4] });
  const readings = load(FIXTURE_HEATER).map((r) => est.update(r));
  assert.ok(readings.some((x) => x.heaterW === 3000), 'backup heater not seen');
});

test('frequency model: register checks need Hz at 0 while quiet and above 0 during a run', () => {
  const run = (hz: (r: Row) => number | null) => {
    const check = new RefrigerantSensorCheck();
    const est = new PowerEstimator(R32_1101_AIO, { flowSamplesLpm: [17.8] });
    load(FIXTURE).forEach((r) => {
      const sample = { ...r, compressorHz: hz(r) };
      check.update(sample, est.update({ ...sample, evaporatorC: null }).waterSaysOn);
    });
    return check.trusted;
  };
  assert.equal(run((r) => r.compressorHz ?? null), true);
  assert.equal(run(() => 0), false, 'a register stuck at 0 is not a frequency');
  assert.equal(run(() => 63), false, 'a constant is not a frequency');
});

test('frequency model: independent check on a 71 Hz run (2026-10-04), not used for the constant', () => {
  // The run ended with a −3168 W step in the house meter at 09:50:18 UTC (4050 → 882 W);
  // the frequency register only drops to 0 one or two polls later (interface lag ~35 s).
  const rows = load('r32s1-1101-dhw-71hz-2026-10-04.csv');
  const est = new PowerEstimator(R32_1101_HZ, { flowSamplesLpm: [17.4] });
  const readings = rows.map((r) => est.update(r));
  const i = rows.findIndex((r) => r.timeMs >= at('2026-10-04T09:50:18Z'));
  const step = rows[i - 1].houseW - rows[i].houseW;
  assert.ok(Math.abs(readings[i - 1].compressorW - step) / step < 0.05, `model ${readings[i - 1].compressorW} W vs step ${step} W`);
  // At the app's 60 s poll the registers are trusted during this 14-minute run.
  const check = new RefrigerantSensorCheck();
  const water = new PowerEstimator(R32_1101_AIO);
  rows.filter((_, k) => k % 4 === 0).forEach((r) => check.update(r, water.update({ ...r, evaporatorC: null, compressorHz: null }).waterSaysOn));
  assert.equal(check.trusted, true, JSON.stringify(check.snapshot));
});
