import { describe, expect, it } from 'vitest';
import { PRESENT_YEARS } from '../src/engine/core/constants';
import { Stage } from '../src/engine/life/life';
import { techLevel } from '../src/engine/civ/civilization';
import { findHabitablePlanet, makeSim } from './fixtures';

describe('user interventions', () => {
  it('every intervention is logged and emits a UNIVERSE MODIFIED event with before/after', () => {
    const sim = makeSim(555);
    sim.advanceTo(11e9);
    const { g, s, p } = findHabitablePlanet(sim);
    const lastId = sim.feed[sim.feed.length - 1]?.id ?? 0;
    sim.intervene('set-temperature', { g, s, p }, { forcing: 40 }, '288 K', '+40 K');
    expect(sim.interventions.length).toBe(1);
    const ev = sim.feed[sim.feed.length - 1];
    expect(ev.id).toBeGreaterThan(lastId);
    expect(ev.title).toContain('UNIVERSE MODIFIED');
    expect(ev.body).toContain('Previous: 288 K');
    expect(ev.body).toContain('New: +40 K');
  });

  it('altering the atmosphere re-solves the climate (more CO₂ → warmer)', () => {
    const sim = makeSim(555);
    sim.advanceTo(11e9);
    const { g, s, p } = findHabitablePlanet(sim);
    const before = sim.queries.planetAt(g, s, p, sim.now())!;
    // Same total pressure, 30% CO₂.
    const P = before.climate.pressure;
    sim.intervene('set-atmosphere', { g, s, p }, { pN2: P * 0.7, pCO2: P * 0.3 }, 'a', 'b');
    const after = sim.queries.planetAt(g, s, p, sim.now())!;
    expect(after.climate.surfaceTemp).toBeGreaterThan(before.climate.surfaceTemp + 5);
    expect(after.atmosphere.co2).toBeGreaterThan(0.2);
    // The change applies from the intervention time onward only.
    expect(sim.queries.planetAt(g, s, p, sim.now() - 1)!.climate.surfaceTemp).toBeCloseTo(before.climate.surfaceTemp, 6);
  });

  it('regression: re-solving after a no-op change stays on the same climate branch', () => {
    // The climate is bistable; the solver must continue from the current state (hysteresis)
    // instead of restarting from the airless temperature and landing on the snowball branch.
    const sim = makeSim(555);
    sim.advanceTo(11e9);
    for (const { g, s, p } of [findHabitablePlanet(sim, 0.4), findHabitablePlanet(sim, 0.6)]) {
      const before = sim.queries.planetAt(g, s, p, sim.now())!;
      sim.intervene('set-water', { g, s, p }, { water: before.env.water }, 'same', 'same');
      const after = sim.queries.planetAt(g, s, p, sim.now())!;
      expect(after.climate.surfaceTemp).toBeCloseTo(before.climate.surfaceTemp, 3);
      expect(after.type).toBe(before.type);
    }
  });

  it('removing all water sterilises a living world', () => {
    const sim = makeSim(555);
    const rec = sim.catalog!.life.find((r) => r.t[Stage.CELL] < 11e9 && r.end > 12e9)!;
    sim.advanceTo(11e9);
    expect(sim.queries.planetAt(rec.g, rec.s, rec.p, sim.now())!.life.stage).toBeGreaterThanOrEqual(Stage.CELL);
    sim.intervene('set-water', { g: rec.g, s: rec.s, p: rec.p }, { water: 0 }, '1', '0');
    sim.advanceTo(11.1e9);
    const d = sim.queries.planetAt(rec.g, rec.s, rec.p, sim.now())!;
    expect(d.climate.liquidWater).toBe(0);
    expect(d.life.stage).toBe(Stage.NONE);
    // Statistics reflect it.
    const ref = makeSim(555);
    ref.advanceTo(11.1e9);
    expect(sim.stats().lifeBearing).toBe(ref.stats().lifeBearing - 1);
  });

  it('destroying a star removes it from the census and kills its biospheres', () => {
    const sim = makeSim(555);
    const rec = sim.catalog!.life.find((r) => r.t[Stage.REPL] < 11e9 && r.end > 12e9)!;
    sim.advanceTo(11e9);
    const stars0 = sim.stats().stars;
    sim.intervene('destroy-star', { g: rec.g, s: rec.s }, {}, 'alive', 'destroyed');
    sim.advanceTo(11e9 + 1);
    expect(sim.stats().stars).toBe(stars0 - 1);
    expect(sim.queries.starState(rec.g, rec.s, sim.now())!.phase).toBe('destroyed');
    expect(sim.queries.planetAt(rec.g, rec.s, rec.p, sim.now())!.life.alive).toBe(false);
  });

  it('creating a star adds it, with a generated planetary system, to the census', () => {
    const sim = makeSim(555);
    sim.advanceTo(11e9);
    const s0 = sim.stats();
    sim.intervene('create-star', { g: 2 }, { mass: 1, feh: 0, x: 1, y: 0, z: 1 }, 'none', 'G star');
    const cs = sim.overrides.createdStars[0];
    expect(cs.s).toBe(sim.catalog!.surveys[2].catalog.count);
    sim.advanceTo(11e9 + 1e8);
    const s1 = sim.stats();
    expect(s1.stars).toBeGreaterThanOrEqual(s0.stars + 1 - 50); // natural deaths over 100 Myr
    const sys = sim.queries.getSystem(2, cs.s)!;
    expect(sys.star.mass).toBe(1);
    expect(sim.queries.starState(2, cs.s, sim.now())!.phase).toBe('main-sequence');
  });

  it('spawning, uplifting and removing a civilization changes civ state', () => {
    const sim = makeSim(555);
    sim.advanceTo(12e9);
    const { g, s, p } = findHabitablePlanet(sim);
    const n0 = sim.civs.civs.length;
    sim.intervene('spawn-civilization', { g, s, p }, {}, 'none', 'seeded');
    expect(sim.civs.civs.length).toBe(n0 + 1);
    const id = sim.civs.civs.length - 1;
    expect(sim.civs.civs[id].source).toBe('intervention');
    const t0 = techLevel(sim.civs.civs[id].tech);
    sim.intervene('advance-tech', { g, civ: id }, {}, 'L0', 'L1');
    expect(techLevel(sim.civs.civs[id].tech)).toBe(t0 + 1);
    sim.intervene('remove-civilization', { g, civ: id }, {}, 'active', 'removed');
    expect(sim.civs.civs[id].alive).toBe(false);
    expect(sim.civs.aliveIds).not.toContain(id);
  });

  it('interventions replay deterministically when time travels back and forward', () => {
    const sim = makeSim(555);
    sim.advanceTo(12e9);
    const { g, s, p } = findHabitablePlanet(sim);
    sim.intervene('spawn-civilization', { g, s, p }, {}, 'none', 'seeded');
    sim.intervene('asteroid-impact', { g, s, p }, { severity: 0.4 }, 'x', 'y');
    sim.advanceTo(PRESENT_YEARS);
    const h = sim.civs.stateHash();
    sim.seek(11e9); // before the interventions
    expect(sim.civs.civs.some((c) => c.source === 'intervention')).toBe(false);
    sim.seek(PRESENT_YEARS); // they replay at their timestamps
    expect(sim.civs.stateHash()).toBe(h);
  });

  it('a new intervention in the past branches the timeline (later ones are discarded)', () => {
    const sim = makeSim(555);
    sim.advanceTo(12e9);
    const { g, s, p } = findHabitablePlanet(sim);
    sim.intervene('set-temperature', { g, s, p }, { forcing: 10 }, 'a', 'b');
    sim.advanceTo(13e9);
    sim.intervene('set-temperature', { g, s, p }, { forcing: 20 }, 'b', 'c');
    sim.seek(11e9);
    sim.intervene('set-water', { g, s, p }, { water: 3 }, 'x', 'y');
    expect(sim.interventions.map((iv) => iv.kind)).toEqual(['set-water']);
    expect(sim.feed[sim.feed.length - 1].body).toContain('Timeline branched: 2');
  });
});
