import { describe, expect, it } from 'vitest';
import { DEG, TAU, Vec3 } from '../src/engine/core/math';
import { makeTime, addYears, timeYears } from '../src/engine/core/time';
import {
  OrbitalElements,
  hillRadius,
  orbitalPeriodYears,
  orbitalPosition,
  rocheLimit,
  secularPrecessionRates,
  solveKepler,
  stellarReflex,
  tidalLockTimeYears,
  visVivaKmS,
} from '../src/engine/physics/orbits';
import { orbitNormal, spinAxis, subsolarLatitude } from '../src/engine/physics/rotation';

const el = (a: number, e: number, extra: Partial<OrbitalElements> = {}): OrbitalElements => ({
  a,
  e,
  i: 0,
  node: 0,
  argPeri: 0,
  M0: 0,
  period: orbitalPeriodYears(a, 1),
  precession: 0,
  ...extra,
});

describe('orbital mechanics', () => {
  it("obeys Kepler's third law (1 AU around 1 M☉ = 1 yr; P² ∝ a³)", () => {
    expect(orbitalPeriodYears(1, 1)).toBeCloseTo(1, 3);
    expect(orbitalPeriodYears(5.2, 1)).toBeCloseTo(Math.pow(5.2, 1.5), 2);
    expect(orbitalPeriodYears(1, 4)).toBeCloseTo(0.5, 3);
  });

  it('solves Kepler’s equation to machine precision for eccentricities up to 0.97', () => {
    for (const e of [0, 0.1, 0.5, 0.8, 0.9, 0.97]) {
      for (let k = 0; k < 64; k++) {
        const M = (k / 64) * TAU;
        const E = solveKepler(M, e);
        const resid = E - e * Math.sin(E) - M;
        expect(Math.abs(((resid + Math.PI) % TAU) - Math.PI)).toBeLessThan(1e-10);
      }
    }
  });

  it('elliptical orbits reach periapsis a(1−e) and apoapsis a(1+e)', () => {
    const o = el(2, 0.4);
    let rmin = Infinity, rmax = 0;
    for (let k = 0; k < 2000; k++) {
      const t = makeTime((k / 2000) * o.period);
      const p = orbitalPosition(o, t, timeYears(t));
      const r = Math.hypot(...p);
      rmin = Math.min(rmin, r);
      rmax = Math.max(rmax, r);
    }
    expect(rmin).toBeCloseTo(2 * 0.6, 2);
    expect(rmax).toBeCloseTo(2 * 1.4, 2);
  });

  it('conserves energy: finite-difference speed matches vis-viva everywhere on the orbit', () => {
    const o = el(1.5, 0.3);
    const AU_PER_YR_IN_KMS = 4.74047;
    for (let k = 0; k < 20; k++) {
      const t = (k / 20) * o.period;
      const h = o.period * 1e-6;
      const p1 = orbitalPosition(o, makeTime(t - h), t - h), p2 = orbitalPosition(o, makeTime(t + h), t + h);
      const v = (Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / (2 * h)) * AU_PER_YR_IN_KMS;
      const r = Math.hypot(...orbitalPosition(o, makeTime(t), t));
      expect(v).toBeCloseTo(visVivaKmS(r, o.a, 1), 1);
    }
  });

  it('conserves angular momentum (Kepler’s second law)', () => {
    const o = el(1, 0.5, { i: 10 * DEG, node: 1, argPeri: 2 });
    const hs: number[] = [];
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * o.period, h = o.period * 1e-6;
      const p = orbitalPosition(o, makeTime(t), t);
      const a = orbitalPosition(o, makeTime(t - h), t - h), b = orbitalPosition(o, makeTime(t + h), t + h);
      const v: Vec3 = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
      hs.push(Math.hypot(p[1] * v[2] - p[2] * v[1], p[2] * v[0] - p[0] * v[2], p[0] * v[1] - p[1] * v[0]));
    }
    for (const h of hs) expect(h / hs[0]).toBeCloseTo(1, 4);
  });

  it('prograde orbits circulate counter-clockwise about +y, matching orbitNormal', () => {
    const o = el(1, 0.1, { i: 0.3, node: 0.7 });
    const p1 = orbitalPosition(o, makeTime(0), 0), p2 = orbitalPosition(o, makeTime(0.01), 0.01);
    const L: Vec3 = [p1[1] * p2[2] - p1[2] * p2[1], p1[2] * p2[0] - p1[0] * p2[2], p1[0] * p2[1] - p1[1] * p2[0]];
    const n = orbitNormal(o);
    const cos = (L[0] * n[0] + L[1] * n[1] + L[2] * n[2]) / Math.hypot(...L);
    expect(cos).toBeCloseTo(1, 6);
  });

  it('Hill radius and Roche limit match the Earth–Moon system', () => {
    const rh = hillRadius(1, 0.0167, 3.003e-6, 1);
    expect(rh).toBeGreaterThan(0.0098);
    expect(rh).toBeLessThan(0.0102);
    // Earth (5.51 g/cc) vs Moon (3.34 g/cc): fluid Roche limit ≈ 2.9 Earth radii.
    expect(rocheLimit(1, 5.51, 3.34)).toBeCloseTo(2.88, 1);
  });

  it('secular precession: Jupiter perturbs Earth’s perihelion on the right order of magnitude', () => {
    const rates = secularPrecessionRates([1, 5.2], [3.0e-6, 9.55e-4], 1);
    const arcsecPerCentury = (rates[0] * 180 / Math.PI) * 3600 * 100;
    // Real total ≈ 1160″/century (mostly Jupiter + Venus); Jupiter alone a few hundred.
    expect(arcsecPerCentury).toBeGreaterThan(100);
    expect(arcsecPerCentury).toBeLessThan(2000);
    expect(rates[1]).toBeGreaterThan(0);
  });

  it('close-in planets around M dwarfs tidally lock; Earth does not', () => {
    expect(tidalLockTimeYears(0.03, 20, 1, 1, 0.2)).toBeLessThan(1e9);
    expect(tidalLockTimeYears(1, 24, 1, 1, 1)).toBeGreaterThan(5e10); // far longer than the age of the universe
  });

  it('stellar reflex motion keeps the barycentre fixed', () => {
    const planets: Vec3[] = [[5.2, 0, 0], [0, 0, -1]];
    const masses = [9.55e-4, 3e-6];
    const s = stellarReflex(planets, masses, 1);
    const cm = [s[0] + planets[0][0] * masses[0] + planets[1][0] * masses[1], s[2] + planets[0][2] * masses[0] + planets[1][2] * masses[1]];
    expect(Math.abs(cm[0])).toBeLessThan(1e-12);
    expect(Math.abs(cm[1])).toBeLessThan(1e-12);
  });

  it('seasons emerge: sub-solar latitude swings ±tilt over one orbit', () => {
    const o = el(1, 0.01);
    const tilt = 23.4 * DEG;
    const axis = spinAxis(o, tilt, 1234);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 365; k++) {
      const t = k / 365;
      const lat = subsolarLatitude(axis, orbitalPosition(o, makeTime(t), t));
      lo = Math.min(lo, lat);
      hi = Math.max(hi, lat);
    }
    expect(hi / DEG).toBeCloseTo(23.4, 0);
    expect(lo / DEG).toBeCloseTo(-23.4, 0);
  });

  it('orbital phase stays continuous at 13.8 Gyr (no float64 collapse)', () => {
    const o = el(1, 0.2);
    let t = makeTime(13.787e9);
    const p0 = orbitalPosition(o, t, timeYears(t));
    t = addYears(t, 1 / (365.25 * 24)); // one hour
    const p1 = orbitalPosition(o, t, timeYears(t));
    const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    // Earth-like orbit: ~0.00072 AU per hour.
    expect(moved).toBeGreaterThan(0.0005);
    expect(moved).toBeLessThan(0.001);
  });
});
