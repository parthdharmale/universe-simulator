import { describe, expect, it } from 'vitest';
import { YEAR_S, PRESENT_YEARS } from '../src/engine/core/constants';
import { addYears, makeTime, phase, timeYears } from '../src/engine/core/time';
import { makeSim } from './fixtures';

describe('simulation clock', () => {
  it('accumulates 1/60 s frames at 13.8 Gyr without losing time (float64 years alone would)', () => {
    let t = makeTime(13.787e9);
    const frame = 1 / 60 / YEAR_S;
    for (let i = 0; i < 60 * 3600; i++) t = addYears(t, frame); // one simulated hour at 1×
    const elapsedSeconds = (t.whole - 13.787e9 + t.frac) * YEAR_S;
    expect(elapsedSeconds).toBeCloseTo(3600, 3);
    // The naive representation loses everything:
    let naive = 13.787e9;
    for (let i = 0; i < 1000; i++) naive += frame;
    expect(naive).toBe(13.787e9);
  });

  it('phase() is continuous and exact at cosmological times', () => {
    const day = 1 / 365.25;
    const t0 = makeTime(13.787e9 + 0.25);
    const p0 = phase(t0, day);
    const p1 = phase(addYears(t0, day / 4), day);
    let d = p1 - p0;
    if (d < 0) d += 1;
    expect(d).toBeCloseTo(0.25, 4);
  });

  it('simulation time advances by realDt × speed', () => {
    const sim = makeSim(5);
    sim.speed = 1e10;
    const t0 = sim.now();
    sim.update(0.05);
    expect(sim.now() - t0).toBeCloseTo((0.05 * 1e10) / YEAR_S, 6);
    sim.paused = true;
    sim.update(0.05);
    expect(sim.now() - t0).toBeCloseTo((0.05 * 1e10) / YEAR_S, 6);
  });

  it('clamps huge frame gaps (tab switches) to a bounded step', () => {
    const sim = makeSim(5);
    sim.speed = 1e10;
    sim.update(30); // 30 s hitch
    expect(sim.now()).toBeCloseTo((0.1 * 1e10) / YEAR_S, 6);
  });
});

describe('time travel', () => {
  it('jumping back and forward reproduces the exact same state (checkpoint + replay)', () => {
    const sim = makeSim(123456);
    sim.advanceTo(PRESENT_YEARS);
    const hNow = sim.civs.stateHash();
    const statsNow = JSON.stringify(sim.stats());

    const ref = makeSim(123456);
    ref.advanceTo(11e9);
    const h11 = ref.civs.stateHash();

    sim.seek(11e9);
    expect(sim.now()).toBe(11e9);
    expect(sim.civs.stateHash()).toBe(h11);
    sim.seek(PRESENT_YEARS);
    expect(sim.civs.stateHash()).toBe(hNow);
    expect(JSON.stringify(sim.stats())).toBe(statsNow);
  });

  it('async jumpTo yields the same state as synchronous advance', async () => {
    const a = makeSim(77), b = makeSim(77);
    await a.jumpTo(12.5e9);
    b.advanceTo(12.5e9);
    expect(a.civs.stateHash()).toBe(b.civs.stateHash());
    expect(timeYears(a.clock)).toBe(12.5e9);
  });

  it('rewinding (negative direction) moves time backwards deterministically', () => {
    const sim = makeSim(77);
    sim.advanceTo(13e9);
    sim.direction = -1;
    sim.speed = 1e16;
    const t0 = sim.now();
    sim.update(0.05);
    expect(sim.now()).toBeLessThan(t0);
    const t1 = sim.now();
    const ref = makeSim(77);
    ref.advanceTo(t1);
    expect(sim.civs.stateHash()).toBe(ref.civs.stateHash());
  });

  it('stats at any time are pure functions of time (identical forward and after rewind)', () => {
    const sim = makeSim(9);
    sim.advanceTo(9e9);
    const s9 = sim.stats();
    sim.advanceTo(13e9);
    sim.seek(9e9);
    expect(sim.stats()).toEqual(s9);
  });
});
