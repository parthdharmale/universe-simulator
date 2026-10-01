import { describe, expect, it } from 'vitest';
import { generateSystem, habitabilityFactors, habitabilityIndex, EARTH_MASS_IN_SUN } from '../src/engine/gen/planets';
import { solveClimate, boilingPointK } from '../src/engine/physics/climate';
import { mutualHillRadius } from '../src/engine/physics/orbits';

const earthLike = { insolation: 1, pN2: 0.79, pCO2: 60, pCH4: 1e-6, pO2: 0, water: 1, geology: 0.5, forcing: 0 };

describe('climate model', () => {
  it('reproduces Earth, Venus and Mars', () => {
    const earth = solveClimate(earthLike);
    expect(earth.surfaceTemp).toBeGreaterThan(280);
    expect(earth.surfaceTemp).toBeLessThan(296);
    expect(earth.liquidWater).toBeGreaterThan(0.5);
    const venus = solveClimate({ insolation: 1.91, pN2: 3, pCO2: 60, pCH4: 0, pO2: 0, water: 0.0001, geology: 0.5, forcing: 0 });
    expect(venus.surfaceTemp).toBeGreaterThan(550);
    expect(venus.liquidWater).toBe(0);
    const mars = solveClimate({ insolation: 0.43, pN2: 0.0002, pCO2: 0.006, pCH4: 0, pO2: 0, water: 0.2, geology: 0.1, forcing: 0 });
    expect(mars.surfaceTemp).toBeGreaterThan(195);
    expect(mars.surfaceTemp).toBeLessThan(225);
    expect(mars.liquidWater).toBeLessThan(0.01);
  });

  it('temperature increases with stellar flux and decreases with distance', () => {
    let prev = 0;
    for (const S of [0.3, 0.6, 1, 1.5, 3]) {
      const T = solveClimate({ ...earthLike, co2Locked: true, pCO2: 0.0004 }).surfaceTemp;
      const T2 = solveClimate({ ...earthLike, insolation: S, co2Locked: true, pCO2: 0.0004 }).surfaceTemp;
      expect(T2).toBeGreaterThan(prev);
      prev = T2;
      void T;
    }
  });

  it('more CO₂ means a warmer planet (greenhouse effect)', () => {
    const lo = solveClimate({ ...earthLike, pCO2: 0.0004, co2Locked: true });
    const hi = solveClimate({ ...earthLike, pCO2: 0.2, co2Locked: true });
    expect(hi.surfaceTemp).toBeGreaterThan(lo.surfaceTemp + 10);
    expect(hi.greenhouseK).toBeGreaterThan(lo.greenhouseK);
  });

  it('the carbonate–silicate thermostat buffers temperature against insolation changes', () => {
    const dim = solveClimate({ ...earthLike, insolation: 0.85 });
    const bright = solveClimate({ ...earthLike, insolation: 1.2 });
    const lockedDim = solveClimate({ ...earthLike, insolation: 0.85, pCO2: dim.pCO2 * 0 + 0.0006, co2Locked: true });
    // With weathering, the dim planet retains more CO₂ than the bright one…
    expect(dim.pCO2).toBeGreaterThan(bright.pCO2);
    // …which keeps it warmer than it would be with fixed CO₂.
    expect(dim.surfaceTemp).toBeGreaterThan(lockedDim.surfaceTemp);
  });

  it('boiling point follows Clausius–Clapeyron', () => {
    expect(boilingPointK(1)).toBeCloseTo(373.15, 1);
    expect(boilingPointK(92)).toBeGreaterThan(540);
    expect(boilingPointK(0.1)).toBeLessThan(330);
  });
});

describe('planetary systems', () => {
  const systems = Array.from({ length: 400 }, (_, i) => generateSystem({ g: 0, s: i, seed: 1000 + i * 7, mass: 1, feh: 0.05, birth: 5e9 }));

  it('every planet has the full property set, internally consistent', () => {
    for (const sys of systems.slice(0, 80)) {
      for (const p of sys.planets) {
        expect(p.massE).toBeGreaterThan(0);
        expect(p.radiusE).toBeGreaterThan(0);
        expect(p.density).toBeCloseTo((5.51 * p.massE) / p.radiusE ** 3, 6);
        expect(p.orbit.period).toBeGreaterThan(0);
        expect(p.axialTilt).toBeGreaterThanOrEqual(0);
        expect(p.climate.surfaceTemp).toBeGreaterThan(0);
        expect(p.magneticField).toBeGreaterThanOrEqual(0);
        expect(p.geology0).toBeGreaterThanOrEqual(0);
        expect(Object.values(p.resources).every((v) => v >= 0 && v <= 1)).toBe(true);
        expect(['gas-giant', 'ice-giant', 'terrestrial', 'ocean', 'desert', 'frozen', 'volcanic', 'habitable']).toContain(p.type);
      }
    }
  });

  it('classifications are derived from properties, not random', () => {
    const all = systems.flatMap((s) => s.planets);
    for (const p of all) {
      if (p.type === 'gas-giant') expect(p.massE).toBeGreaterThan(15);
      if (p.type === 'habitable') {
        expect(p.habitability).toBeGreaterThanOrEqual(0.4);
        expect(p.climate.liquidWater).toBeGreaterThan(0.02);
      }
      if (p.type === 'frozen') expect(p.climate.surfaceTemp < 235 || p.climate.ice > 0.6).toBe(true);
      if (p.type === 'ocean') expect(p.climate.liquidWater).toBeGreaterThan(0.85);
    }
    // All eight classes occur across a few hundred Sun-like systems.
    expect(new Set(all.map((p) => p.type)).size).toBe(8);
  });

  it('giants form beyond the snow line (unless migrated as hot Jupiters)', () => {
    let beyond = 0, total = 0;
    for (const sys of systems)
      for (const p of sys.planets)
        if (p.type === 'gas-giant') {
          total++;
          if (p.orbit.a > sys.snowLine * 0.9) beyond++;
        }
    expect(total).toBeGreaterThan(10);
    expect(beyond / total).toBeGreaterThan(0.8);
  });

  it('adjacent planets are dynamically stable (≥ 9 mutual Hill radii, non-crossing orbits)', () => {
    for (const sys of systems) {
      const M = sys.star.mass / EARTH_MASS_IN_SUN;
      for (let k = 0; k < sys.planets.length - 1; k++) {
        const p = sys.planets[k], q = sys.planets[k + 1];
        expect(q.orbit.a).toBeGreaterThan(p.orbit.a);
        expect((q.orbit.a - p.orbit.a) / mutualHillRadius(p.orbit.a, q.orbit.a, p.massE, q.massE, M)).toBeGreaterThanOrEqual(8.99);
        expect(p.orbit.a * (1 + p.orbit.e)).toBeLessThan(q.orbit.a * (1 - q.orbit.e));
      }
    }
  });

  it('moons orbit inside the Hill sphere and outside the Roche limit', () => {
    let n = 0;
    for (const sys of systems)
      for (const p of sys.planets)
        for (const m of p.moons) {
          n++;
          expect(m.aInPlanetRadii).toBeGreaterThan(2.4);
          const hill = p.orbit.a * (1 - p.orbit.e) * Math.cbrt((p.massE * EARTH_MASS_IN_SUN) / (3 * sys.star.mass));
          expect(m.orbit.a).toBeLessThan(hill * 0.41);
        }
    expect(n).toBeGreaterThan(50);
  });

  it('metal-rich stars build more giant planets (planet–metallicity correlation)', () => {
    const count = (feh: number) => {
      let g = 0;
      for (let i = 0; i < 400; i++) g += generateSystem({ g: 0, s: i, seed: 5000 + i, mass: 1, feh, birth: 5e9 }).planets.filter((p) => p.type === 'gas-giant').length;
      return g;
    };
    expect(count(0.3)).toBeGreaterThan(count(-0.5) * 1.5);
  });

  it('habitability is zero for scorching or airless worlds and high for temperate wet ones', () => {
    const hot = solveClimate({ ...earthLike, insolation: 4 });
    const fHot = habitabilityFactors(hot, 0.5, 0, 1, 'G', false, false);
    expect(habitabilityIndex(fHot)).toBe(0);
    const airless = solveClimate({ ...earthLike, pN2: 0, pCO2: 0 });
    expect(habitabilityIndex(habitabilityFactors(airless, 0.5, 0, 1, 'G', false, false))).toBe(0);
    const earth = solveClimate(earthLike);
    expect(habitabilityIndex(habitabilityFactors(earth, 0.5, 0, 1, 'G', false, false))).toBeGreaterThan(0.75);
    // M-dwarf flares and tidal locking reduce it.
    expect(habitabilityIndex(habitabilityFactors(earth, 0.5, 0, 1, 'M', true, false))).toBeLessThan(0.5);
  });
});

describe('climate solver numerics (regression)', () => {
  it('returns a true fixed point: re-evaluating the solution reproduces it', () => {
    for (const S of [0.3, 0.36, 0.5, 0.9, 1, 1.3, 1.9]) {
      for (const water of [0, 0.3, 1, 4]) {
        const c = solveClimate({ ...earthLike, insolation: S, water });
        const again = solveClimate({ ...earthLike, insolation: S, water, initialTemp: c.surfaceTemp });
        expect(again.surfaceTemp).toBeCloseTo(c.surfaceTemp, 2);
      }
    }
  });

  it('exhibits hysteresis: warm and frozen starts can settle on different branches', () => {
    // With CO₂ held fixed (no thermostat), a dim world has both a frozen and a temperate
    // equilibrium; which one it occupies depends on where it starts.
    const base = { ...earthLike, insolation: 0.8, pCO2: 0.01, co2Locked: true };
    const warm = solveClimate({ ...base, initialTemp: 300 });
    const cold = solveClimate({ ...base, initialTemp: 180 });
    expect(warm.liquidWater).toBeGreaterThan(0.3);
    expect(cold.liquidWater).toBeLessThan(0.05);
    expect(warm.surfaceTemp - cold.surfaceTemp).toBeGreaterThan(20);
  });
});
