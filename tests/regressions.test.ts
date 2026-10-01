import { describe, expect, it } from 'vitest';
import { PRESENT_YEARS } from '../src/engine/core/constants';
import { SaveValidationError, applySave, createSave, validateSave } from '../src/engine/persistence/save';
import { keepInHistory } from '../src/engine/civ/civEngine';
import { runSurvey, SurveyCancelled } from '../src/engine/survey/surveyPool';
import { generateUniverse } from '../src/engine/gen/galaxy';
import { makeSim } from './fixtures';

/** Regression tests for weaknesses found in the self-review (see REVIEW.md). */
describe('review regressions', () => {
  it('#10 concurrent time-machine jumps: the newest request wins, the older one abandons cleanly', async () => {
    const sim = makeSim(808);
    // A tiny time slice forces the first jump to yield before completing.
    const first = sim.jumpTo(PRESENT_YEARS, undefined, 0.001);
    const second = sim.jumpTo(9e9); // issued before the first finishes
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(false);
    expect(r2).toBe(true);
    expect(sim.now()).toBe(9e9);
    expect(sim.jumping).toBe(false);
    const ref = makeSim(808);
    ref.advanceTo(9e9);
    expect(sim.civs.stateHash()).toBe(ref.civs.stateHash());
  });

  it('#14 replaying an earlier period after loading lays down checkpoints in sorted order', () => {
    const a = makeSim(909);
    a.advanceTo(PRESENT_YEARS);
    const save = validateSave(JSON.parse(JSON.stringify(createSave(a, 's', null))));
    const b = makeSim(909);
    applySave(b, save);
    const before = b.checkpointCount; // origin + load point
    b.seek(11e9);
    expect(b.checkpointCount).toBeGreaterThan(before);
    // Scrubbing nearby now restores from a nearby checkpoint and is still exact.
    b.seek(11.3e9);
    const ref = makeSim(909);
    ref.advanceTo(11.3e9);
    expect(b.civs.stateHash()).toBe(ref.civs.stateHash());
  });

  it('#13 imports whose interventions point at non-existent objects are rejected', () => {
    const sim = makeSim(707);
    sim.advanceTo(10e9);
    const good = JSON.parse(JSON.stringify(createSave(sim, 'x', null)));
    const bad = (target: object, kind = 'set-water') => ({ ...good, interventions: [{ id: 1, t: 1e9, kind, target, params: { water: 1, mass: 1 }, label: '', previous: '', next: '' }] });
    for (const target of [{ g: 999 }, { g: 0, s: 10_000_000, p: 0 }, { g: 0, s: 0, p: 99 }, { g: 0, civ: 5000 }]) {
      const target2 = makeSim(707);
      expect(() => applySave(target2, validateSave(bad(target)))).toThrow(SaveValidationError);
    }
  });

  it('#20 civilization histories are hard-bounded but keep defining events', () => {
    expect(keepInHistory(10, 'discovery')).toBe(true);
    expect(keepInHistory(500, 'discovery')).toBe(false);
    expect(keepInHistory(500, 'colonization')).toBe(true);
    expect(keepInHistory(5000, 'colonization')).toBe(false);
    expect(keepInHistory(5000, 'extinction')).toBe(true);
    const sim = makeSim(123456);
    sim.advanceTo(30e9);
    for (const h of sim.civs.histories) expect(h.length).toBeLessThan(1300);
  });

  it('#11/#12 the survey works without workers and can be cancelled', async () => {
    const u = generateUniverse({ seed: 5, galaxyCount: 6, starDensity: 0.3 });
    const res = await runSurvey(u.galaxies);
    expect(res.length).toBe(6);
    for (let i = 0; i < 6; i++) expect(res[i].galaxy).toBe(i);
    const signal = { cancelled: false };
    const p = runSurvey(u.galaxies, (done) => {
      if (done === 2) signal.cancelled = true;
    }, signal);
    await expect(p).rejects.toBeInstanceOf(SurveyCancelled);
  });

  it('#21 interventions are refused while an async jump is running', async () => {
    const sim = makeSim(606);
    const j = sim.jumpTo(PRESENT_YEARS, undefined, 0.001);
    expect(sim.jumping).toBe(true);
    expect(() => sim.intervene('destroy-star', { g: 0, s: 1 }, {}, 'a', 'b')).toThrow(/jump/);
    await j;
    expect(() => sim.intervene('destroy-star', { g: 0, s: 1 }, {}, 'a', 'b')).not.toThrow();
  });
});
