/**
 * Season detection from the outdoor temperature, the way heat pump and HVAC
 * controllers do their heating/cooling changeover: on the average over a few
 * days (day and night), with a gap between the switch-on and switch-off
 * points so one cool night or one warm day doesn't flip the season.
 *
 * Pure functions — device.ts keeps the hourly history in the device store.
 */

export type Season = 'summer' | 'midseason' | 'winter';

export interface SeasonConfig {
  days: number;         // averaging period
  summerStart: number;  // midseason → summer at average ≥ this
  summerEnd: number;    // summer → midseason at average ≤ this
  winterStart: number;  // any season → winter at average ≤ this
  winterEnd: number;    // winter → midseason at average ≥ this
}

/** [hour number (ms since epoch / 3 600 000), average °C of that hour] */
export type HourlyTemp = [number, number];

/** Hourly values are kept this long, enough for the longest averaging period. */
export const HISTORY_HOURS = 7 * 24;

/** Share of the period's hours that must have a value before we trust the average. */
const MIN_COVERAGE = 2 / 3;

/**
 * Average of the hourly values in the last `days` days, or null while less
 * than two thirds of those hours have a value (e.g. the first days after
 * pairing, or after a long outage).
 */
export function averageOutdoor(history: HourlyTemp[], nowHour: number, days: number): number | null {
  const values = inPeriod(history, nowHour, days);
  if (values.length < days * 24 * MIN_COVERAGE) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** How many hours of the last `days` days have a value. */
export function hoursMeasured(history: HourlyTemp[], nowHour: number, days: number): number {
  return inPeriod(history, nowHour, days).length;
}

const inPeriod = (history: HourlyTemp[], nowHour: number, days: number) =>
  history.filter(([hour]) => hour >= nowHour - days * 24 && hour < nowHour).map(([, v]) => v);

/**
 * The season for this average. From a known season the switch points apply
 * (hysteresis); without one yet, the season whose band is nearest is picked.
 */
export function nextSeason(current: Season | null, avg: number, c: SeasonConfig): Season {
  if (current === null) {
    if (avg >= (c.summerStart + c.summerEnd) / 2) return 'summer';
    if (avg <= (c.winterStart + c.winterEnd) / 2) return 'winter';
    return 'midseason';
  }
  if (current === 'winter') return avg >= c.winterEnd ? 'midseason' : 'winter';
  if (avg <= c.winterStart) return 'winter';
  if (current === 'summer') return avg <= c.summerEnd ? 'midseason' : 'summer';
  return avg >= c.summerStart ? 'summer' : 'midseason';
}

/** The switch points must be in order: winter start < winter end ≤ summer end < summer start. */
export function validSeasonConfig(c: SeasonConfig): boolean {
  return c.winterStart < c.winterEnd && c.winterEnd <= c.summerEnd && c.summerEnd < c.summerStart;
}
