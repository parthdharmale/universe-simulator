import { describe, expect, it } from 'vitest';
import { PRESENT_YEARS } from '../src/engine/core/constants';
import { SaveValidationError, applySave, createSave, replayHash, validateSave } from '../src/engine/persistence/save';
import { findHabitablePlanet, makeSim } from './fixtures';

describe('save / load', () => {
  it('round-trips through JSON: same time, interventions, civilization state and stats', () => {
    const sim = makeSim(4242);
    sim.advanceTo(12e9);
    const { g, s, p } = findHabitablePlanet(sim);
    sim.intervene('set-water', { g, s, p }, { water: 2.5 }, '1 ocean', '2.5 oceans');
    sim.advanceTo(PRESENT_YEARS);
    const save = createSave(sim, 'test', { kind: 'planet', g, s, p });
    const json = JSON.stringify(save);
    // The universe itself is not stored — saves stay small.
    expect(json.length).toBeLessThan(5_000_000);

    const loaded = validateSave(JSON.parse(json));
    const sim2 = makeSim(4242);
    applySave(sim2, loaded);
    expect(sim2.now()).toBe(sim.now());
    expect(sim2.interventions.length).toBe(1);
    expect(sim2.civs.stateHash()).toBe(sim.civs.stateHash());
    expect(JSON.stringify(sim2.stats())).toBe(JSON.stringify(sim.stats()));
    // The modified planet is modified after loading.
    expect(sim2.queries.planetAt(g, s, p, sim2.now())!.env.water).toBe(2.5);
  });

  it('a save can be verified by deterministic replay from seed + interventions', () => {
    const sim = makeSim(4242);
    sim.advanceTo(10e9);
    const { g, s, p } = findHabitablePlanet(sim);
    sim.intervene('accelerate-evolution', { g, s, p }, {}, 'x', 'y');
    sim.advanceTo(PRESENT_YEARS);
    const save = validateSave(JSON.parse(JSON.stringify(createSave(sim, 'v', null))));
    const fresh = makeSim(4242);
    expect(replayHash(fresh, save)).toBe(save.stateHash);
  });

  it('continuing after load evolves identically to never having saved', () => {
    const a = makeSim(31);
    a.advanceTo(12.5e9);
    const save = validateSave(JSON.parse(JSON.stringify(createSave(a, 'c', null))));
    const b = makeSim(31);
    applySave(b, save);
    a.advanceTo(PRESENT_YEARS);
    b.advanceTo(PRESENT_YEARS);
    expect(b.civs.stateHash()).toBe(a.civs.stateHash());
  });

  it('rejects malformed, foreign or future-version files with a clear error', () => {
    const sim = makeSim(4242);
    const good = createSave(sim, 'ok', null);
    expect(() => validateSave(null)).toThrow(SaveValidationError);
    expect(() => validateSave({ format: 'something-else' })).toThrow(/format/);
    expect(() => validateSave({ ...good, version: 999 })).toThrow(/version/);
    expect(() => validateSave({ ...good, time: { whole: -5, frac: 0 } })).toThrow(/time/);
    expect(() => validateSave({ ...good, interventions: [{ id: 1, t: 1, kind: 'rm -rf', target: { g: 0 }, params: {} }] })).toThrow(/intervention/);
    expect(() => validateSave({ ...good, interventions: [{ id: 1, t: 1, kind: 'set-water', target: { g: 0 }, params: { water: 'lots' } }] })).toThrow(/parameter/);
    expect(() => validateSave({ ...good, config: { seed: 1, galaxyCount: 1e9, starDensity: 1 } })).toThrow(/Galaxy count/);
    // Loading into a universe with a different seed is refused.
    const other = makeSim(4243);
    expect(() => applySave(other, validateSave(JSON.parse(JSON.stringify(good))))).toThrow(/configuration/);
  });
});
