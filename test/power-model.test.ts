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
  compressorCm3FromCurrent, frequencyModelWatts, compressionTempsC,
} from '../drivers/heatpump/power-model';

interface Row extends PowerSample { houseW: number; realW?: number }

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
      // Power-meter fixtures (2026-10-13): the boost flag (40009) and the heat pump's own meter.
      ...(c.boost === undefined ? {} : { boostActive: c.boost === '1' }),
      ...(c.realW === undefined ? {} : { realW: Number(c.realW) }),
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

/** Same unit with the frequency model: C = 22.0 cm³ / 0.77, measured with a power meter (see below). */
const R32_1101_HZ: PowerConfig = { ...R32_1101_AIO, compressorCm3: 28.6 };

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
// Until 2026-10-14 C was 29.3 cm³, fitted on these three with TC as the condensing
// temperature. The power meter of 2026-10-13 (tests below) showed TC reads the liquid line
// (up to 5 K under the leaving water in floor heating): with compressionTempsC() and the
// aux draw apart, C = 22.0 / 0.77 = 28.6 cm³ — and the three still agree within ±6 %.

test('frequency model: the earlier electrical references still agree (±6 %)', () => {
  const temps = (te: number, tc: number, two: number | null) => compressionTempsC(te, tc, two);
  const ct = 14.6 * 235 * 0.98; // CT = the whole outdoor unit, so the compressor alone sits a little lower
  const [e1, c1] = temps(13, 59, 58);
  assert.ok(Math.abs(frequencyModelWatts(28.6, 71, e1, c1) - ct) / ct < 0.06, `${frequencyModelWatts(28.6, 71, e1, c1).toFixed(0)} W vs CT ${ct.toFixed(0)} W`);
  const rows = load(FIXTURE);
  const stop = rows.filter((r) => r.timeMs < at('2026-10-03T10:08:01Z')).pop()!;
  const atStop = frequencyModelWatts(28.6, stop.compressorHz!, ...temps(stop.evaporatorC!, stop.condensingC!, stop.twoC));
  assert.ok(Math.abs(atStop - 1973) / 1973 < 0.06, `${atStop.toFixed(0)} W vs step 1973 W at ${stop.compressorHz} Hz`);
  const heater = load(FIXTURE_HEATER);
  const before = heater.filter((r) => r.timeMs < at('2026-10-03T12:16:56Z')).pop()!;
  const [e3, c3] = temps(before.evaporatorC!, before.condensingC!, before.twoC);
  const drop = frequencyModelWatts(28.6, 45, e3, c3) - frequencyModelWatts(28.6, 30, e3, c3);
  assert.ok(Math.abs(drop - 678) / 678 < 0.1, `${drop.toFixed(0)} W vs step 678 W`);
  // The calibration helper recovers the constant from the CT reading (fan included, so a bit above 28.6).
  assert.ok(Math.abs(compressorCm3FromCurrent(14.6, 71, e1, c1, 235, 0.98)! - 29.5) < 0.5);
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
  // House-meter step: ±5 % of base-load noise; the power meter of 2026-10-13 is the sharper reference.
  assert.ok(Math.abs(readings[i - 1].compressorW - step) / step < 0.06, `model ${readings[i - 1].compressorW} W vs step ${step} W`);
  // At the app's 60 s poll the registers are trusted during this 14-minute run.
  const check = new RefrigerantSensorCheck();
  const water = new PowerEstimator(R32_1101_AIO);
  rows.filter((_, k) => k % 4 === 0).forEach((r) => check.update(r, water.update({ ...r, evaporatorC: null, compressorHz: null }).waterSaysOn));
  assert.equal(check.trusted, true, JSON.stringify(check.snapshot));
});

test('backup heater at the DHW hand-over: energy within 12 % of its house-meter steps', () => {
  // Heater on/off steps: 2026-10-03 12:28:03 → 12:40:36 UTC at 3185 W, 2026-10-04
  // 12:29:58 → 12:40:30 UTC at 3066 W (a 3 kW element above 230 V). The model rates it at
  // 3000 W and books the minutes before it can recognise the heater (backfillKwh).
  for (const [file, on, off, watts] of [
    [FIXTURE_HEATER, '2026-10-03T12:28:03Z', '2026-10-03T12:40:36Z', 3185],
    ['r32s1-1101-dhw-heater-2026-10-04.csv', '2026-10-04T12:29:58Z', '2026-10-04T12:40:30Z', 3066],
    ['r32s1-1101-dhw-heater-2026-10-05.csv', '2026-10-05T11:26:35Z', '2026-10-05T11:36:49Z', 3105],
  ] as const) {
    for (const config of [R32_1101_AIO, R32_1101_HZ]) {
      const rows = load(file);
      const est = new PowerEstimator(config, { flowSamplesLpm: [17.4] });
      let kwh = 0;
      let prev: ReturnType<PowerEstimator['update']> | null = null;
      rows.forEach((r, i) => {
        const x = est.update(r);
        if (prev) kwh += energyKwh(prev.heaterW, x.heaterW, r.timeMs - rows[i - 1].timeMs);
        kwh += x.backfillKwh;
        prev = x;
      });
      const real = (watts * (at(off) - at(on))) / 3_600_000_000;
      assert.ok(Math.abs(kwh - real) / real < 0.12, `${file} ${config.compressorCm3 ? 'Hz' : 'water'}: heater ${kwh.toFixed(3)} vs ${real.toFixed(3)} kWh`);
    }
  }
});

test('no backup heater while the compressor runs with THO 1–2 K above TWO (2026-10-05, every poll phase)', () => {
  // 13:06–13:27 local the compressor ran alone (45 → 30 Hz); the heater only came on at
  // 11:26:35 UTC (+3157 W step) after the compressor stopped. At a 60 s poll one of the
  // four phases used to count it at 11:13:28 UTC from a 2 K sensor offset.
  const rows = load('r32s1-1101-dhw-heater-2026-10-05.csv');
  for (const config of [R32_1101_AIO, R32_1101_HZ]) {
    for (let phase = 0; phase < 4; phase += 1) {
      const est = new PowerEstimator(config, { flowSamplesLpm: [17.4] });
      rows.filter((_, i) => i % 4 === phase).forEach((r) => {
        const x = est.update(r);
        if (r.timeMs < at('2026-10-05T11:26:35Z')) assert.equal(x.heaterW, 0, `phase ${phase}: heater at ${new Date(r.timeMs).toISOString()}`);
      });
    }
  }
});

test('SG Ready Forced ON boost (DN 6CE = 0): heater counted at any water flow, energy within 12 % of the house meter', () => {
  // 2026-10-05: contact closed since 12:16 UTC, DN 6CE set to 0 at ~12:57 UTC (unit restart).
  // From 13:01:53 UTC the heater ran (+3.4 kW step) and the compressor joined twice (to ~41 Hz,
  // the house up to 5.9 kW); in boost the pump ran ~26 l/min, so THO was only 1–3 K above TWO.
  const rows = load('r32s1-1101-sg-boost-2026-10-05.csv');
  const base = rows.filter((r) => r.timeMs < at('2026-10-05T12:57:00Z')).map((r) => r.houseW).sort((a, b) => a - b)[3];
  for (let phase = 0; phase < 2; phase += 1) {
    const est = new PowerEstimator(R32_1101_HZ, { flowSamplesLpm: [17.4] });
    let model = 0;
    let real = 0;
    let prev: { t: number; w: number; real: number } | null = null;
    rows.filter((_, i) => i % 2 === phase).forEach((r) => {
      const x = est.update({ ...r, boostActive: r.timeMs >= at('2026-10-05T12:58:20Z'), boostSetpointC: 60 });
      const realW = Math.max(0, r.houseW - base);
      if (prev && r.timeMs >= at('2026-10-05T12:58:20Z')) {
        model += energyKwh(prev.w, x.watts, r.timeMs - prev.t) + x.backfillKwh;
        real += energyKwh(prev.real, realW, r.timeMs - prev.t);
      }
      prev = { t: r.timeMs, w: x.watts, real: realW };
    });
    assert.ok(Math.abs(model - real) / real < 0.12, `phase ${phase}: model ${model.toFixed(2)} kWh vs house ${real.toFixed(2)} kWh (base ${base} W)`);
  }
});

// ── Power meter on the heat pump (2026-10-13) ──────────────────────────────────
// A Shelly Pro EM-50 clamps both line wires leaving the Estia's breaker (outdoor + indoor
// unit), so `realW` is the whole heat pump: compressor, backup heater, pump, fan, controls.
// Same unit as above (HWT-1101HW-E + HWT-1101F21ST6W-E, one 3 kW heater stage), polled
// every ~15 s. Aux draw as the app's preset for this model (ErP + interface, device.ts).
const R32_1101_METERED: PowerConfig = {
  ...R32_1101_HZ, standbyW: 7, runAuxW: 42, preheatW: 40,
};

function meterReplay(file: string, config = R32_1101_METERED) {
  const rows = load(file);
  const est = new PowerEstimator(config, { flowSamplesLpm: [11.5] });
  const readings = rows.map((r) => est.update(r));
  let modelKwh = 0;
  let realKwh = 0;
  rows.forEach((r, i) => {
    modelKwh += readings[i].backfillKwh;
    if (i === 0) return;
    const ms = r.timeMs - rows[i - 1].timeMs;
    realKwh += energyKwh(rows[i - 1].realW!, r.realW!, ms);
    modelKwh += energyKwh(readings[i - 1].watts, readings[i].watts, ms);
  });
  return {
    rows, readings, modelKwh, realKwh, err: (modelKwh - realKwh) / realKwh,
  };
}

test('power meter: no backup heater after a hot-water run with nothing asked for (2026-10-16)', () => {
  // The DHW timer ends at 12:01 (local); the tank still creeps up 1 K while it settles and
  // THO stays 1–2 K above TWO as the heater vessel cools slower. The meter shows 11–12 W:
  // no heater, so neither a heater reading nor a hand-over backfill after the stop.
  const { rows, readings, err } = meterReplay('r32s1-1101-em-dhw-cooldown-2026-10-16.csv');
  const stop = rows.findIndex((r) => r.timeMs >= Date.parse('2026-10-16T10:01:00Z'));
  const after = readings.slice(stop + 1);
  assert.ok(after.every((x) => x.heaterW === 0), `heater seen at ${after.findIndex((x) => x.heaterW > 0)}`);
  assert.equal(after.reduce((s, x) => s + x.backfillKwh, 0), 0);
  assert.ok(Math.abs(err) < 0.1, `energy off by ${(err * 100).toFixed(1)} %`);
});

test('power meter: every recorded run within 10 % of the measured energy (2026-10-13)', () => {
  for (const file of [
    'r32s1-1101-em-dhw-2026-10-13.csv', // hot water 29 → 45 °C, up to 80 Hz
    'r32s1-1101-em-dhw-heater-2026-10-13.csv', // hot water 45 → 53 °C, then 5 min backup heater
    'r32s1-1101-em-floor-2026-10-13.csv', // floor heating at 32 °C, TC up to 5 K under the leaving water
    'r32s1-1101-em-short-runs-2026-10-13.csv', // three 10–15 min runs at low water temperature
  ]) {
    const r = meterReplay(file);
    assert.ok(Math.abs(r.err) < 0.1, `${file}: model ${r.modelKwh.toFixed(3)} vs meter ${r.realKwh.toFixed(3)} kWh (${(r.err * 100).toFixed(1)} %)`);
  }
});

test('power meter: steady polls within 10 % in hot water and in floor heating', () => {
  for (const file of ['r32s1-1101-em-dhw-2026-10-13.csv', 'r32s1-1101-em-floor-2026-10-13.csv']) {
    const { rows, readings } = meterReplay(file);
    const ratios: number[] = [];
    rows.forEach((r, i) => {
      if (i === 0 || i === rows.length - 1 || !r.compressorHz) return;
      const steady = rows[i - 1].compressorHz === r.compressorHz && rows[i + 1].compressorHz === r.compressorHz
        && Math.abs(rows[i + 1].realW! - rows[i - 1].realW!) < 0.05 * r.realW!;
      if (steady && r.realW! > 300) ratios.push(readings[i].watts / r.realW!);
    });
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    assert.ok(ratios.length >= 20, `${file}: only ${ratios.length} steady polls`);
    assert.ok(median > 0.95 && median < 1.05, `${file}: median model/meter ${median.toFixed(3)}`);
    assert.ok(ratios[Math.floor(ratios.length * 0.1)] > 0.9 && ratios[Math.floor(ratios.length * 0.9)] < 1.1,
      `${file}: p10–p90 ${ratios[Math.floor(ratios.length * 0.1)].toFixed(2)}–${ratios[Math.floor(ratios.length * 0.9)].toFixed(2)}`);
  }
});

test('power meter: standby = ErP P_SB while stopped (meter: ~12 W incl. interface, gateway and SG relay)', () => {
  const r = meterReplay('r32s1-1101-em-idle-2026-10-13.csv');
  r.readings.forEach((x) => assert.equal(x.watts, 7));
  // This window is in the ~26.5 W state: a 14.5 W load that switches for hours with no
  // register changing (cause unknown, not modelled) on top of ~12 W (P_SB + the extras).
  assert.ok(r.realKwh / r.modelKwh > 3, `idle ${r.modelKwh.toFixed(3)} vs ${r.realKwh.toFixed(3)} kWh`);
  // Without aux settings (house-meter replays) a stopped unit still reads 0 W.
  const bare = meterReplay('r32s1-1101-em-idle-2026-10-13.csv', R32_1101_HZ);
  bare.readings.forEach((x) => assert.equal(x.watts, 0));
});

test('winding preheat in frost while stopped: 10/15 duty from −1 °C, continuous below −3 °C', () => {
  const est = new PowerEstimator(R32_1101_METERED);
  const base = {
    zoneOn: false, dhwOn: false, coolMode: false, twiC: 20, twoC: 20, thoC: 20, tankC: 45, condensingC: 10, compressorHz: 0,
  };
  const at = (outdoorC: number, k: number) => est.update({
    ...base, timeMs: k * 60_000, outdoorC, evaporatorC: outdoorC,
  }).auxW;
  assert.equal(at(5, 1), 7);
  assert.equal(at(0, 2), 7);
  assert.equal(at(-1, 3), Math.round(7 + (40 * 10) / 15));
  assert.equal(at(-2, 4), Math.round(7 + (40 * 10) / 15));
  assert.equal(at(-3, 5), 47);
  assert.equal(at(-8, 6), 47);
  // Zone on, compressor waiting: the pump runs (ErP P_TO) and the winding is still preheated.
  assert.equal(est.update({
    ...base, zoneOn: true, timeMs: 7 * 60_000, outdoorC: -5, evaporatorC: -5,
  }).auxW, 7 + 42 + 40);
});

test('register check stays trusted through floor heating with TC under the leaving water', () => {
  const rows = load('r32s1-1101-em-floor-2026-10-13.csv');
  assert.ok(rows.some((r) => r.compressorHz! > 0 && r.condensingC! <= r.twoC! - 4), 'fixture should hold TC ≥ 4 K under TWO');
  const check = new RefrigerantSensorCheck({
    idleAgree: 20, runConfirm: 5, runMiss: 0,
  });
  const water = new PowerEstimator(R32_1101_AIO);
  rows.forEach((r) => check.update(r, water.update({ ...r, evaporatorC: null, compressorHz: null }).waterSaysOn));
  const { runConfirm, runMiss } = check.snapshot;
  assert.equal(check.trusted, true, JSON.stringify(check.snapshot));
  assert.ok(runMiss * 10 <= runConfirm, `misses ${runMiss} vs confirms ${runConfirm}`);
});

test('condensing temperature: TC, or 3 K above the leaving water when TC reads lower; cooling reversed', () => {
  assert.deepEqual(compressionTempsC(9, 28, 32), [9, 35]); // floor heating: TC on the subcooled liquid line
  assert.deepEqual(compressionTempsC(8, 62, 58), [8, 62]); // hot water: TC above TWO + 3
  assert.deepEqual(compressionTempsC(35, 6, 12), [6, 35]); // cooling: outdoor coil condenses
  assert.deepEqual(compressionTempsC(9, 28, null), [9, 28]);
});

// Toshiba Engineering Data Book E23-103 (§ 2-5): input at maximum frequency, pump excluded,
// fan and controls included. A guard for every R32 outdoor unit, with this app's constants
// (device.ts MODEL_PRESETS) and no fitting: evaporating ≈ TO − 7 K, condensing = LWT + 3 K.
// W55 rows are left out: there the unit is current-limited below its maximum frequency.
test('frequency model against the Data Book peak input of every R32 outdoor unit (0.75–1.25)', () => {
  const units: Array<[string, number, number, number, Array<[number, number]>]> = [
    // name, C (cm³), max Hz, fan W, [outdoor °C, kW] at W35
    ['HWT-401HW-E', 19.5, 80, 43, [[7, 1.49], [2, 1.52], [-7, 1.49]]],
    // The 601's A7 and A2 peaks equal the 401's (7.25 kW out, 1.49 kW in): it is capped at
    // the 401's 80 Hz in mild weather and only reaches 100 Hz in the cold.
    ['HWT-601HW-E', 19.5, 80, 43, [[7, 1.49], [2, 1.52]]],
    ['HWT-601HW-E', 19.5, 100, 43, [[-7, 1.95]]],
    ['HWT-801HW-E', 28.6, 90, 60, [[7, 2.62], [2, 2.77], [-7, 2.88]]],
    ['HWT-1101HW-E', 28.6, 100, 60, [[7, 3.15], [2, 3.24], [-7, 3.41]]],
    ['HWT-1401HW-E', 49.4, 82, 100, [[7, 4.73], [2, 4.62], [-7, 4.53]]],
    ['HWT-801H8W-E', 49.4, 53, 100, [[7, 2.68], [2, 2.80], [-7, 2.58]]],
    ['HWT-1101H8W-E', 49.4, 64, 100, [[7, 3.66], [2, 3.57], [-7, 3.23]]],
    ['HWT-1401H8W-E', 49.4, 82, 100, [[7, 4.73], [2, 4.62], [-7, 4.53]]],
  ];
  for (const [name, cm3, hz, fanW, points] of units) {
    for (const [outdoor, kw] of points) {
      const model = (frequencyModelWatts(cm3, hz, outdoor - 7, 35 + 3) + fanW) / 1000;
      assert.ok(model / kw > 0.75 && model / kw < 1.25, `${name} A${outdoor}/W35: model ${model.toFixed(2)} vs Data Book ${kw} kW`);
    }
  }
});
