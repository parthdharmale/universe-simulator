import { hashFloat } from '../core/rng';
import { TAU, Vec3, vDot, vNorm } from '../core/math';
import { SimTime, phase } from '../core/time';
import { OrbitalElements } from './orbits';

/**
 * Planetary spin.
 *
 * The spin axis is fixed in inertial space (gyroscopic stiffness; precession of the
 * equinoxes is neglected). It is tilted from the orbit normal by the axial tilt, toward a
 * per-planet azimuth. Because the axis stays fixed while the planet orbits, the sub-solar
 * latitude oscillates between ±tilt over a year — seasons emerge from geometry, not from a
 * scripted sine wave.
 */

/** Unit orbital angular momentum (matches perifocalToFrame in orbits.ts). */
export function orbitNormal(el: OrbitalElements): Vec3 {
  const sinI = Math.sin(el.i), cosI = Math.cos(el.i);
  return vNorm([Math.sin(el.node) * sinI, cosI, Math.cos(el.node) * sinI]);
}

export function spinAxis(el: OrbitalElements, tilt: number, seed: number): Vec3 {
  const n = orbitNormal(el);
  const az = hashFloat(seed, 0xa715) * TAU;
  // In-plane basis (u along node line, v completing the triad).
  const u: Vec3 = [Math.cos(el.node), 0, -Math.sin(el.node)];
  const v: Vec3 = vNorm([n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]);
  const d: Vec3 = [Math.cos(az) * u[0] + Math.sin(az) * v[0], Math.cos(az) * u[1] + Math.sin(az) * v[1], Math.cos(az) * u[2] + Math.sin(az) * v[2]];
  return vNorm([Math.cos(tilt) * n[0] + Math.sin(tilt) * d[0], Math.cos(tilt) * n[1] + Math.sin(tilt) * d[1], Math.cos(tilt) * n[2] + Math.sin(tilt) * d[2]]);
}

/** Sidereal rotation angle (rad) at time t. Retrograde rotators have negative periods. */
export function rotationAngle(rotationHours: number, t: SimTime, seed: number): number {
  const periodYears = Math.abs(rotationHours) / (24 * 365.25);
  const ph = phase(t, periodYears, hashFloat(seed, 0x5917));
  return (rotationHours < 0 ? -1 : 1) * ph * TAU;
}

/** Sub-solar latitude (rad) given the spin axis and the planet position relative to its star. */
export function subsolarLatitude(axis: Vec3, planetPos: Vec3): number {
  const toStar = vNorm([-planetPos[0], -planetPos[1], -planetPos[2]]);
  return Math.asin(Math.max(-1, Math.min(1, vDot(axis, toStar))));
}

export function seasonName(subsolarLat: number, tilt: number): string {
  if (tilt < 0.05 || Math.abs(tilt - Math.PI) < 0.05) return 'No seasons (negligible tilt)';
  const f = subsolarLat / Math.sin(Math.min(tilt, Math.PI - tilt));
  if (f > 0.5) return 'Northern summer · southern winter';
  if (f < -0.5) return 'Northern winter · southern summer';
  return f >= 0 ? 'Equinox season (northern spring)' : 'Equinox season (northern autumn)';
}

/** Mean solar day (hours) from sidereal rotation and orbital period. */
export function solarDayHours(rotationHours: number, orbitalPeriodYears: number): number {
  const orbitHours = orbitalPeriodYears * 365.25 * 24;
  const inv = 1 / rotationHours - 1 / orbitHours;
  return Math.abs(inv) < 1e-12 ? Infinity : 1 / Math.abs(inv);
}
