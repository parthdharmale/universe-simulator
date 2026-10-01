import { describe, expect, it } from 'vitest';
import { KPC_PER_AU } from '../src/engine/core/constants';
import { anchorDiff, Anchor } from '../src/render/CameraRig';
import { planetLook } from '../src/render/planetLook';
import { parseYears } from '../src/ui/TimeMachine';
import { seaLevelFor, terrainHeight } from '../src/engine/gen/terrain';
import { makeSim } from './fixtures';

describe('render-side logic (pure, testable without WebGL)', () => {
  it('#5 camera anchors keep planet-scale precision at galaxy-scale distances', () => {
    // Two bodies 1 km apart in a system 2,500 kpc from the origin: float64 kpc alone cannot
    // resolve this (ulp ≈ 7,000 km); the anchor difference is exact.
    const base: [number, number, number] = [2500.123456789, -1800.5, 977.25];
    const km = 1 / 1.495978707e8; // AU
    const a: Anchor = { star: [3, 7], base, local: [1 + km, 0, 0] };
    const b: Anchor = { star: [3, 7], base, local: [1, 0, 0] };
    const d = anchorDiff(a, b);
    expect(d[0] / KPC_PER_AU / km).toBeCloseTo(1, 6);
    const naive = (base[0] + (1 + km) * KPC_PER_AU) - (base[0] + 1 * KPC_PER_AU);
    expect(Math.abs(naive / KPC_PER_AU / km - 1)).toBeGreaterThan(0.01);
  });

  it('planet appearance is derived from simulated properties (desert ≠ ocean ≠ giant)', () => {
    const sim = makeSim(1212);
    const looks: Record<string, ReturnType<typeof planetLook>> = {};
    outer: for (let g = 0; g < 24; g++)
      for (let s = 0; s < 400; s++) {
        const sys = sim.queries.getSystem(g, s);
        if (!sys) continue;
        for (const p of sys.planets) {
          const d = sim.queries.planetAt(g, s, p.index, 13e9)!;
          const key = d.type === 'frozen' && d.climate.ice > 0.3 ? 'icy' : d.type;
          if (!looks[key]) looks[key] = planetLook(d);
          if (looks.desert && looks.ocean && looks['gas-giant'] && looks.icy) break outer;
        }
      }
    expect(looks.desert.seaLevel).toBe(-1); // no oceans drawn on a dry world
    expect(looks.ocean.seaLevel).toBeGreaterThan(0.4); // most of the sphere under water
    expect(looks['gas-giant'].kind).toBe(1);
    expect(looks.icy.iceLat).toBeLessThan(looks.desert.iceLat); // ice caps reach low latitudes
  });

  it('sea level matches the simulated liquid-water fraction of the same terrain field', () => {
    const seed = 424242;
    for (const f of [0.2, 0.5, 0.8]) {
      const sea = seaLevelFor(seed, f);
      let under = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) {
        const y = 1 - (2 * (i + 0.37)) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963;
        if (terrainHeight(Math.cos(th) * r, y, Math.sin(th) * r, seed) < sea) under++;
      }
      expect(under / N).toBeCloseTo(f, 1);
    }
  });

  it('time-machine input accepts human formats', () => {
    expect(parseYears('4,000,000,000')).toBe(4e9);
    expect(parseYears('4.5 Gyr')).toBe(4.5e9);
    expect(parseYears('13.7B')).toBeCloseTo(13.7e9, 0);
    expect(parseYears('250 Myr')).toBe(2.5e8);
    expect(parseYears('10k')).toBe(1e4);
    expect(parseYears('soon')).toBeNull();
  });
});
