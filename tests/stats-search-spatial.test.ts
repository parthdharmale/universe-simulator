import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/core/rng';
import { PRESENT_YEARS, PLANET_FORMATION_DELAY } from '../src/engine/core/constants';
import { StarGrid } from '../src/engine/spatial/grid';
import { Stage } from '../src/engine/life/life';
import { search } from '../src/engine/sim/search';
import { historyOf } from '../src/engine/sim/history';
import { describe as describeEntity } from '../src/engine/sim/describe';
import { observerBaseline, observerSummary } from '../src/engine/sim/observer';
import { makeSim } from './fixtures';

describe('statistics come from the simulation', () => {
  const sim = makeSim(2468);

  it('binary-searched catalog counts equal brute-force counts at arbitrary times', () => {
    const cat = sim.catalog!;
    for (const t of [2e8, 1e9, 4.5e9, 9e9, PRESENT_YEARS, 25e9]) {
      let shining = 0, planets = 0;
      for (const sv of cat.surveys) {
        const c = sv.catalog;
        for (let i = 0; i < c.count; i++) {
          if (c.birth[i] <= t && t < c.death[i]) shining++;
          if (c.birth[i] + PLANET_FORMATION_DELAY <= t) planets += sv.planetCount[i];
        }
      }
      expect(cat.starsShining(t)).toBe(shining);
      expect(cat.planetsFormed(t)).toBe(planets);
      let life = 0;
      for (const r of cat.life) if (r.t[Stage.REPL] <= t && t < r.end) life++;
      expect(cat.atStage(Stage.REPL, t)).toBe(life);
    }
  });

  it('civilization counts equal the civ engine registry', () => {
    sim.advanceTo(PRESENT_YEARS);
    const st = sim.stats();
    expect(st.civilizations).toBe(sim.civs.aliveIds.length);
    expect(st.spacefaring).toBe(sim.civs.aliveIds.filter((id) => sim.civs.civs[id].tech >= 4).length);
    expect(st.galaxies).toBe(24);
  });

  it('inspector and history are populated for every entity kind', () => {
    const c = sim.civs.civs[0];
    for (const ref of [
      { kind: 'universe' as const },
      { kind: 'galaxy' as const, g: 1 },
      { kind: 'star' as const, g: c.g, s: c.s },
      { kind: 'planet' as const, g: c.g, s: c.s, p: c.p },
      { kind: 'civ' as const, civ: c.id },
    ]) {
      const info = describeEntity(sim, ref)!;
      expect(info.sections.length).toBeGreaterThan(0);
      expect(historyOf(sim, ref).length).toBeGreaterThan(0);
    }
    // Planet history tells the biological story in order.
    const h = historyOf(sim, { kind: 'planet', g: c.g, s: c.s, p: c.p });
    const titles = h.map((e) => e.title);
    expect(titles.indexOf('Formation')).toBeLessThan(titles.indexOf('First life'));
    expect(titles.indexOf('First life')).toBeLessThan(titles.findIndex((x) => x.includes('emerges')));
    for (let i = 1; i < h.length; i++) expect(h[i].t).toBeGreaterThanOrEqual(h[i - 1].t);
  });

  it('observer mode summarises real changes over the observed interval', () => {
    const id = sim.civs.aliveIds[0];
    const b = observerBaseline(sim, id, 10_000);
    sim.advanceTo(sim.now() + 10_000);
    const sum = observerSummary(sim, b);
    expect(sum.t1 - sum.t0).toBeCloseTo(10_000, 3);
    expect(sum.populationAfter).toBe(sim.civs.civs[id].population + sim.civs.civs[id].colonies.reduce((s, k) => s + k.population, 0));
    expect(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']).toContain(sum.risk);
  });
});

describe('search', () => {
  const sim = makeSim(2468);
  sim.advanceTo(PRESENT_YEARS);
  it('finds civilizations by code with their location chain', () => {
    const c = sim.civs.civs[0];
    const r = search(sim, c.code)[0];
    expect(r.ref).toEqual({ kind: 'civ', civ: c.id });
    expect(r.lines.some((l) => l.startsWith('Planet: '))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('Star: '))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('Galaxy: '))).toBe(true);
  });
  it('resolves hierarchical IDs without any index', () => {
    expect(search(sim, 'G3-S17')[0].ref).toEqual({ kind: 'star', g: 3, s: 17 });
    const sys = sim.queries.getSystem(3, 17)!;
    if (sys.planets.length) expect(search(sim, 'G3-S17-b')[0].ref).toEqual({ kind: 'planet', g: 3, s: 17, p: 0 });
  });
  it('finds galaxies by name and species by name', () => {
    const gal = sim.universe.galaxies[5];
    expect(search(sim, gal.name.slice(0, 5)).some((r) => r.ref.kind === 'galaxy' && r.ref.g === 5)).toBe(true);
    const c = sim.civs.civs[0];
    expect(search(sim, c.species).length).toBeGreaterThan(0);
  });
});

describe('spatial grid', () => {
  it('k-nearest-neighbour queries match brute force exactly', () => {
    const r = new Rng(1);
    const n = 5000;
    const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = r.gaussian(0, 10);
      ys[i] = r.gaussian(0, 1);
      zs[i] = r.gaussian(0, 10);
    }
    const grid = new StarGrid(xs, ys, zs);
    for (let q = 0; q < 200; q++) {
      const i = r.int(0, n - 1);
      const k = r.int(1, 8);
      const accept = (j: number) => j !== i && j % 3 !== 0;
      const got = grid.nearest(xs[i], ys[i], zs[i], k, accept);
      const brute = Array.from({ length: n }, (_, j) => j)
        .filter(accept)
        .map((j) => ({ j, d: (xs[j] - xs[i]) ** 2 + (ys[j] - ys[i]) ** 2 + (zs[j] - zs[i]) ** 2 }))
        .sort((a, b) => a.d - b.d || a.j - b.j)
        .slice(0, k)
        .map((x) => x.j);
      expect(got).toEqual(brute);
    }
  });
});
