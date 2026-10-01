import { YEAR_S } from './constants';
import { fract } from './math';

/**
 * Simulation time representation.
 *
 * A single float64 "years since Big Bang" has a resolution of ~2e-6 yr (~60 s) at 13.8 Gyr,
 * and adding a 1/60 s frame increment at 1× speed would be lost entirely. Planet rotation
 * and orbits need sub-second continuity, so time is stored as
 *     whole: integer number of years (exact up to 2^53)
 *     frac:  fraction of the current year in [0, 1)  (≈1e-16 yr ≈ 3 ns resolution)
 *
 * Coarse systems (cosmology, life, civilizations) read `years()`; periodic motion
 * reads `phase(period)` which never forms the large product directly.
 */
export interface SimTime {
  whole: number;
  frac: number;
}

export const makeTime = (years: number): SimTime => {
  const whole = Math.floor(years);
  return { whole, frac: years - whole };
};

export const timeYears = (t: SimTime) => t.whole + t.frac;

export const cloneTime = (t: SimTime): SimTime => ({ whole: t.whole, frac: t.frac });

export function addYears(t: SimTime, dy: number): SimTime {
  // Split the increment so large jumps keep frac exact.
  const dWhole = Math.trunc(dy);
  let whole = t.whole + dWhole;
  let frac = t.frac + (dy - dWhole);
  const carry = Math.floor(frac);
  whole += carry;
  frac -= carry;
  if (frac >= 1) {
    whole += 1;
    frac -= 1;
  }
  if (frac < 0) frac = 0;
  return { whole, frac };
}

export const compareTime = (a: SimTime, b: SimTime) => (a.whole !== b.whole ? a.whole - b.whole : a.frac - b.frac);

/**
 * Phase in [0,1) of a periodic process with the given period (years), starting at phase0
 * at t=0. Computed as frac(frac(whole/P) + frac/P) so the large term is reduced first.
 * Error is bounded by ~whole/P * 2^-53 cycles (≈1e-3 cycle for a 1-day period at 13.8 Gyr),
 * and — importantly — that error is constant within a year, so motion stays smooth.
 */
export function phase(t: SimTime, periodYears: number, phase0 = 0): number {
  if (!isFinite(periodYears) || periodYears <= 0) return phase0;
  const inv = 1 / periodYears;
  // Split whole into hi/lo parts to reduce the product error further.
  const hi = Math.floor(t.whole / 65536) * 65536;
  const lo = t.whole - hi;
  const p = fract(fract(hi * inv) + fract(lo * inv) + t.frac * inv + phase0);
  return p;
}

/** Seconds within the current year — used by the UI clock at low speeds. */
export const secondsIntoYear = (t: SimTime) => t.frac * YEAR_S;

export function formatYears(years: number): string {
  return Math.floor(years).toLocaleString('en-US');
}

/** Human-friendly duration ("4.52 Gyr", "250 yr", "3.1 Myr"). */
export function formatDuration(years: number, digits = 2): string {
  const a = Math.abs(years);
  const sign = years < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(digits)} Gyr`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(digits)} Myr`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(digits === 2 ? 1 : digits)} kyr`;
  if (a >= 1) return `${sign}${Math.round(a).toLocaleString('en-US')} yr`;
  const days = a * 365.25;
  if (days >= 1) return `${sign}${days.toFixed(1)} d`;
  return `${sign}${(days * 24).toFixed(1)} h`;
}

/** "4.52B years ago" style relative label against a reference time. */
export function formatAgo(eventYears: number, nowYears: number): string {
  const d = nowYears - eventYears;
  if (d < 0) return `in ${formatDuration(-d)}`;
  if (d < 1) return 'Current';
  if (d >= 1e9) return `${(d / 1e9).toFixed(2)}B years ago`;
  if (d >= 1e6) return `${(d / 1e6).toFixed(d >= 1e8 ? 0 : 1)}M years ago`;
  if (d >= 1e3) return `${(d / 1e3).toFixed(d >= 1e5 ? 0 : 1)}K years ago`;
  return `${Math.round(d)} years ago`;
}
