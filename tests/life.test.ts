import { describe, expect, it } from 'vitest';
import { BASE_DURATION, LifeGenome, Stage, gateProbability, integrateLife, lifeGenome, lifeStateAt, oxygenFraction } from '../src/engine/life/life';

/** A genome that passes every gate with average luck — isolates the rate model. */
const lucky = (): LifeGenome => ({ seed: 1, coolingDelay: 4e8, luck: [1, 1, 1, 1, 1, 1, 1], gateRoll: [0, 0, 0, 0, 0, 0, 0, 0] });

describe('life engine', () => {
  it('an Earth-like world (H = 1) reaches intelligence after a few billion years', () => {
    const tl = integrateLife(lucky(), { formation: 0, windowEnd: 1e10, segments: [{ t: 0, H: 1 }], until: 1e10 });
    expect(tl.stageTimes[Stage.REPL]).toBeCloseTo(4e8 + BASE_DURATION[1], -3);
    expect(tl.stageTimes[Stage.INTEL]).toBeGreaterThan(3e9);
    expect(tl.stageTimes[Stage.INTEL]).toBeLessThan(5.5e9);
    // Stages are strictly ordered.
    for (let k = 3; k <= 7; k++) expect(tl.stageTimes[k]).toBeGreaterThan(tl.stageTimes[k - 1]);
  });

  it('lower habitability slows evolution proportionally', () => {
    const fast = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 1 }], until: 1e11 });
    const slow = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 0.5 }], until: 1e11 });
    const span = (tl: typeof fast) => tl.stageTimes[Stage.CELL] - tl.oceans;
    expect(span(slow) / span(fast)).toBeCloseTo(2, 1);
  });

  it('uninhabitable worlds never develop life; abiogenesis probability grows with H', () => {
    const tl = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 0 }], until: 1e11 });
    expect(isFinite(tl.stageTimes[Stage.REPL])).toBe(false);
    expect(gateProbability(2, 0.2)).toBeLessThan(gateProbability(2, 0.8));
    expect(gateProbability(6, 0.3)).toBeLessThan(gateProbability(4, 0.3)); // intelligence is the hardest filter
  });

  it('failing a gate is an evolutionary dead end', () => {
    const g = lucky();
    g.gateRoll[Stage.MULTI] = 0.999;
    const tl = integrateLife(g, { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 1 }], until: 1e11 });
    expect(isFinite(tl.stageTimes[Stage.CELL])).toBe(true);
    expect(isFinite(tl.stageTimes[Stage.MULTI])).toBe(false);
    expect(tl.events.some((e) => e.kind === 'dead-end')).toBe(true);
  });

  it('life ends when the star leaves the main sequence', () => {
    const tl = integrateLife(lucky(), { formation: 0, windowEnd: 2e9, segments: [{ t: 0, H: 1 }], until: 1e10 });
    expect(tl.end).toBe(2e9);
    expect(lifeStateAt(tl, 1.9e9).alive).toBe(true);
    expect(lifeStateAt(tl, 2.1e9).alive).toBe(false);
  });

  it('removing water mid-history sterilises the planet; restoring it restarts chemistry', () => {
    const tl = integrateLife(lucky(), {
      formation: 0,
      windowEnd: 1e11,
      segments: [
        { t: 0, H: 1 },
        { t: 2e9, H: 0 },
        { t: 3e9, H: 1 },
      ],
      until: 1e11,
    });
    expect(lifeStateAt(tl, 1.9e9).stage).toBeGreaterThanOrEqual(Stage.CELL);
    expect(lifeStateAt(tl, 2.5e9).stage).toBe(Stage.NONE);
    expect(lifeStateAt(tl, 3.1e9).stage).toBe(Stage.CHEM);
    expect(tl.events.some((e) => e.kind === 'sterilized' && e.t === 2e9)).toBe(true);
  });

  it('accelerate-evolution advances exactly one stage at the intervention time', () => {
    const base = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 1 }], until: 1e11 });
    const t = 1e9;
    const before = lifeStateAt(base, t).stage;
    const boosted = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 1 }], impulses: [{ t, kind: 'boost', amount: 1 }], until: 1e11 });
    expect(lifeStateAt(boosted, t).stage).toBe(before + 1);
    expect(boosted.stageTimes[Stage.INTEL]).toBeLessThan(base.stageTimes[Stage.INTEL]);
  });

  it('is deterministic per planet seed, including mass extinctions', () => {
    const a = integrateLife(lifeGenome(4242), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 0.9 }], until: 1e11 });
    const b = integrateLife(lifeGenome(4242), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 0.9 }], until: 1e11 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = integrateLife(lifeGenome(4243), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 0.9 }], until: 1e11 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('photosynthesis oxygenates the atmosphere ~1–3 Gyr after single-celled life', () => {
    const tl = integrateLife(lucky(), { formation: 0, windowEnd: 1e11, segments: [{ t: 0, H: 1 }], until: 1e11 });
    const t3 = tl.stageTimes[Stage.CELL];
    expect(oxygenFraction(tl, t3 + 5e8)).toBe(0);
    expect(oxygenFraction(tl, t3 + 3e9)).toBeCloseTo(0.21, 2);
  });
});
