export function fmtNum(x: number, digits = 2): string {
  if (!isFinite(x)) return x > 0 ? '∞' : '—';
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e7)) return x.toExponential(digits);
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  return x.toFixed(digits);
}

/** 8.4B, 312K, 1.2T … */
export function fmtCompact(x: number, digits = 1): string {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  const units: [number, string][] = [
    [1e24, 'Y'],
    [1e21, 'Z'],
    [1e18, 'E'],
    [1e15, 'P'],
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, u] of units) if (a >= v) return `${(x / v).toFixed(digits)}${u}`;
  return a < 10 && a % 1 !== 0 ? x.toFixed(digits) : Math.round(x).toString();
}

export const fmtInt = (x: number) => Math.round(x).toLocaleString('en-US');
export const fmtPct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

export function fmtWatts(w: number): string {
  if (w <= 0) return '0 W';
  const units: [number, string][] = [
    [1e24, 'YW'],
    [1e21, 'ZW'],
    [1e18, 'EW'],
    [1e15, 'PW'],
    [1e12, 'TW'],
    [1e9, 'GW'],
    [1e6, 'MW'],
    [1e3, 'kW'],
  ];
  for (const [v, u] of units) if (w >= v) return `${(w / v).toFixed(1)} ${u}`;
  return `${w.toFixed(0)} W`;
}

/** Kardashev rating (Sagan's interpolation): K = (log10 P − 6) / 10. */
export const kardashev = (watts: number) => (watts > 0 ? (Math.log10(watts) - 6) / 10 : 0);

export function fmtHours(h: number): string {
  if (!isFinite(h)) return '∞ (locked)';
  const a = Math.abs(h);
  if (a >= 24 * 365.25 * 2) return `${(a / (24 * 365.25)).toFixed(1)} yr`;
  if (a >= 48) return `${(a / 24).toFixed(1)} d`;
  return `${a.toFixed(1)} h`;
}

export function fmtPeriodYears(y: number): string {
  if (y < 2 / 365.25) return `${(y * 365.25 * 24).toFixed(1)} h`;
  if (y < 1) return `${(y * 365.25).toFixed(1)} d`;
  if (y < 1e4) return `${y.toFixed(y < 10 ? 2 : 1)} yr`;
  return `${fmtCompact(y)} yr`;
}
