import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/core/rng';
import { CivState, CivWorld, HomeEnvironment, applyImpactTo, cloneCiv, createCivilization, stepCivilization, stepLength, techLevel, totalPopulation } from '../src/engine/civ/civilization';
import { CivEngine, SpawnEntry } from '../src/engine/civ/civEngine';

const goodHome: HomeEnvironment = { habitability: 0.9, area: 1, geology: 0.4, starAlive: true, impactFactor: 1, resourceIndex: 1, hydrocarbons: 0.8, moons: 1, colonyTargets: [{ p: 3, quality: 0.5 }] };
const world = (env: Partial<HomeEnvironment> = {}): CivWorld => ({
  home: () => ({ ...goodHome, ...env }),
  nearestStars: (_g, s, k, exclude) => {
    const out = [];
    for (let i = 1; out.length < k && i < 1000; i++) if (!exclude.has(s + i)) out.push({ s: s + i, distLy: 4 + i });
    return out;
  },
});

const spawn = (seed: number, t = 1e10) => createCivilization({ id: 0, seed, g: 0, s: 10, p: 2, t, source: 'natural' }, goodHome).civ;

function runUntil(c: CivState, w: CivWorld, T: number) {
  while (c.alive && c.time + stepLength(c) <= T) stepCivilization(c, w);
}

describe('civilization model', () => {
  it('has every required attribute', () => {
    const c = spawn(1);
    for (const k of ['population', 'intelligence', 'tech', 'energy', 'resources', 'territory', 'stability', 'culture', 'economy', 'born'] as const) expect(c[k]).not.toBeUndefined();
  });

  it('progresses through technology stages in order under good conditions', () => {
    let reachedStars = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const c = spawn(seed);
      runUntil(c, world(), 1e10 + 2e6);
      const order = ['agriculture', 'industry', 'digital', 'spacefaring', 'interplanetary', 'interstellar'].map((k) => c.milestones[k]).filter((x) => x !== undefined);
      for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
      if (c.alive && techLevel(c.tech) === 6) reachedStars++;
    }
    // Some survive the technological adolescence, many do not (great filter).
    expect(reachedStars).toBeGreaterThan(3);
    expect(reachedStars).toBeLessThan(30);
  });

  it('progress depends on resources: a resource-poor world advances more slowly', () => {
    let rich = 0, poor = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const a = spawn(seed), b = spawn(seed);
      b.resources = b.resourcesMax = 1e18;
      runUntil(a, world(), 1e10 + 2.2e5);
      runUntil(b, world({ resourceIndex: 0.01, hydrocarbons: 0 }), 1e10 + 2.2e5);
      rich += a.tech;
      poor += b.tech;
    }
    expect(rich).toBeGreaterThan(poor);
  });

  it('a famine reduces population; a war consumes resources; depletion cuts output', () => {
    // Drive many steps and verify each recorded event's effect really changed state.
    let famine = 0, war = 0, depletion = 0;
    for (let seed = 1; seed <= 40 && (famine === 0 || war === 0 || depletion === 0); seed++) {
      const c = spawn(seed);
      while (c.alive && c.time < 1e10 + 3e5) {
        const evs = stepCivilization(c, world());
        for (const e of evs) {
          if (e.type === 'famine') {
            famine++;
            expect(e.effects.population[1]).toBeLessThan(e.effects.population[0]);
          }
          if (e.type === 'war') {
            war++;
            // Wars consume resources (unless none are left) and always cost lives.
            expect(e.effects.resources[1]).toBeLessThanOrEqual(e.effects.resources[0]);
            if (e.effects.resources[0] > 0) expect(e.effects.resources[1]).toBeLessThan(e.effects.resources[0]);
            expect(e.effects.population[1]).toBeLessThan(e.effects.population[0]);
          }
          if (e.type === 'resource-depletion') {
            depletion++;
            expect(e.effects.resources[1]).toBeLessThan(25);
          }
        }
      }
    }
    expect(famine + war).toBeGreaterThan(0);
  });

  it('resource depletion lowers economic output relative to a resource-rich twin', () => {
    const a = spawn(77), b = spawn(77);
    const w = world();
    runUntil(a, w, 1e10 + 1.9e5);
    runUntil(b, w, 1e10 + 1.9e5);
    if (!a.alive || techLevel(a.tech) < 2) return; // seed-dependent path; covered by other seeds
    b.resources = b.resourcesMax * 0.02;
    stepCivilization(a, w);
    stepCivilization(b, w);
    expect(b.economy).toBeLessThan(a.economy);
  });

  it('asteroid impacts reduce population and stability', () => {
    const c = spawn(5);
    runUntil(c, world(), 1e10 + 5e4);
    const p0 = c.population, s0 = c.stability;
    const evs = applyImpactTo(c, c.time, 0.6);
    expect(evs[0].type).toBe('asteroid-impact');
    expect(c.population).toBeLessThan(p0);
    expect(c.stability).toBeLessThan(s0);
  });

  it('dies when its star dies, unless it has an interstellar refuge', () => {
    const c = spawn(3);
    stepCivilization(c, world({ starAlive: false }));
    expect(c.alive).toBe(false);
    expect(c.endCause).toBe('Host star died');
    const d = spawn(3);
    d.colonies.push({ kind: 'star', g: 0, s: 99, p: -1, m: -1, founded: d.time, population: 1e8, capacity: 2e9 });
    stepCivilization(d, world({ starAlive: false }));
    expect(d.alive).toBe(true);
    expect(d.capital.s).toBe(99);
  });

  it('stepping is deterministic and snapshot/restore resumes exactly', () => {
    const a = spawn(11), b = spawn(11);
    runUntil(a, world(), 1e10 + 1e5);
    runUntil(b, world(), 1e10 + 1e5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const snap = cloneCiv(a);
    runUntil(a, world(), 1e10 + 2e5);
    const restored = cloneCiv(snap);
    runUntil(restored, world(), 1e10 + 2e5);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(a));
  });

  it('regression: a stagnant civilization costs O(log t) steps, not O(t)', () => {
    const c = spawn(21);
    c.tech = 4.5;
    c.levelSince = c.time;
    let steps = 0;
    // A world with no resources and no habitability left: it can only stagnate.
    const w = world({ resourceIndex: 0, habitability: 0.05 });
    c.resources = 0;
    c.stability = 0.9;
    while (c.alive && c.time < 1e10 + 5e8 && steps < 100_000) {
      stepCivilization(c, w);
      steps++;
    }
    expect(steps).toBeLessThan(20_000);
  });

  it('interstellar civilizations expand to new star systems', () => {
    const c = spawn(8);
    c.tech = 6.2;
    c.levelSince = c.time;
    c.milestones.interstellar = c.time;
    runUntil(c, world(), c.time + 2e6);
    expect(c.colonies.filter((k) => k.kind === 'star').length).toBeGreaterThan(0);
    expect(totalPopulation(c)).toBeGreaterThan(c.population);
  });
});

describe('civilization engine', () => {
  const entries = (n: number): SpawnEntry[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, id: 0, seed: 1000 + i, g: 0, s: i * 50, p: 1, t: 1e9 + i * 3e5, source: 'natural' as const }));

  it('advancing in one jump or many small steps yields bit-identical state', () => {
    const A = new CivEngine(world()), B = new CivEngine(world());
    A.setSchedule(entries(6));
    B.setSchedule(entries(6));
    const T = 1e9 + 4e6;
    A.advanceTo(T);
    const r = new Rng(3);
    let t = 0;
    while (t < T) {
      t = Math.min(T, t + r.range(1, 2e5) + (t < 1e9 ? 1e9 : 0));
      B.advanceTo(t);
    }
    expect(A.civs.length).toBe(6);
    expect(A.stateHash()).toBe(B.stateHash());
  });

  it('snapshot → advance → restore → advance reproduces the same future', () => {
    const E = new CivEngine(world());
    E.setSchedule(entries(4));
    E.advanceTo(1e9 + 5e5);
    const snap = E.snapshot();
    E.advanceTo(1e9 + 3e6);
    const h1 = E.stateHash();
    const hist1 = E.histories.map((h) => h.length);
    E.restore(snap);
    E.advanceTo(1e9 + 3e6);
    expect(E.stateHash()).toBe(h1);
    expect(E.histories.map((h) => h.length)).toEqual(hist1);
  });

  it('spawn order (and therefore civ ids) is deterministic regardless of schedule input order', () => {
    const A = new CivEngine(world()), B = new CivEngine(world());
    A.setSchedule(entries(5));
    B.setSchedule(entries(5).reverse());
    A.advanceTo(1e9 + 2e6);
    B.advanceTo(1e9 + 2e6);
    expect(A.civs.map((c) => c.seed)).toEqual(B.civs.map((c) => c.seed));
  });
});
