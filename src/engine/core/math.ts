export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => (x - a) / (b - a);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Fractional part, always in [0,1). */
export const fract = (x: number) => x - Math.floor(x);
/** Wrap angle to [0, 2π). */
export const wrapAngle = (a: number) => a - TAU * Math.floor(a / TAU);
export const gaussBell = (x: number, mu: number, sigma: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);

export type Vec3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vDot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vLen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const vNorm = (a: Vec3): Vec3 => {
  const l = vLen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vCross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Build an orthonormal basis (u, v) perpendicular to unit normal n. */
export function basisFromNormal(n: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = vNorm(vCross(ref, n));
  const v = vCross(n, u);
  return { u, v };
}

/** Upper bound: first index i with arr[i] > x (arr sorted ascending). */
export function upperBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Lower bound: first index i with arr[i] >= x. */
export function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number of values v in sorted arr with lo < v <= hi. */
export const countInRange = (arr: ArrayLike<number>, lo: number, hi: number) =>
  Math.max(0, upperBound(arr, hi) - upperBound(arr, lo));
