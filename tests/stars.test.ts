import { describe, expect, it } from 'vitest';
import { lifetimeFromMass, luminosityFromMass, mainSequenceProps, spectralClassFromTemp, starPhaseAt, starTimeline, starPropsAt } from '../src/engine/gen/star';

describe('stellar physics', () => {
  it('reproduces the Sun', () => {
    const sun = mainSequenceProps(1, 0);
    expect(sun.luminosity).toBeCloseTo(1, 5);
    expect(sun.radius).toBeCloseTo(1, 5);
    expect(sun.temperature).toBeGreaterThan(5600);
    expect(sun.temperature).toBeLessThan(5900);
    expect(sun.spectralClass).toBe('G');
    expect(sun.lifetime / 1e9).toBeCloseTo(10, 5);
  });

  it('luminosity rises steeply with mass and lifetime falls', () => {
    let prevL = 0, prevLife = Infinity;
    for (const m of [0.1, 0.3, 0.6, 1, 2, 5, 10, 30, 80]) {
      const L = luminosityFromMass(m), life = lifetimeFromMass(m);
      expect(L).toBeGreaterThan(prevL);
      expect(life).toBeLessThan(prevLife);
      prevL = L;
      prevLife = life;
    }
    // Massive stars die orders of magnitude sooner.
    expect(lifetimeFromMass(20)).toBeLessThan(lifetimeFromMass(1) / 500);
    expect(lifetimeFromMass(0.2)).toBeGreaterThan(1e11); // outlives the present universe ×20
  });

  it('covers every spectral class O B A F G K M with temperature-consistent assignment', () => {
    const seen = new Set<string>();
    for (const m of [0.1, 0.5, 0.8, 1, 1.3, 2, 4, 15, 60]) seen.add(mainSequenceProps(m, 0).spectralClass);
    expect([...seen].sort().join('')).toBe('ABFGKMO'.split('').sort().join(''));
    expect(spectralClassFromTemp(40000)).toBe('O');
    expect(spectralClassFromTemp(3000)).toBe('M');
  });

  it('follows the life cycle: main sequence → red giant → remnant by mass', () => {
    const sun = starTimeline(1, 0, 1e9);
    expect(starPhaseAt(sun, 5e8)).toBe('unborn');
    expect(starPhaseAt(sun, 3e9)).toBe('main-sequence');
    expect(starPhaseAt(sun, sun.msEnd + 1)).toBe('red-giant');
    expect(starPhaseAt(sun, sun.death + 1)).toBe('white-dwarf');
    const big = starTimeline(15, 0, 0);
    expect(starPhaseAt(big, big.death + 1)).toBe('neutron-star');
    const huge = starTimeline(40, 0, 0);
    expect(starPhaseAt(huge, huge.death + 1)).toBe('black-hole');
    // Red giants are larger and cooler than their main-sequence selves.
    const ms = starPropsAt(sun, 5e9), rg = starPropsAt(sun, sun.msEnd + (sun.death - sun.msEnd) / 2);
    expect(rg.radius).toBeGreaterThan(ms.radius * 10);
    expect(rg.temperature).toBeLessThan(ms.temperature);
  });

  it('destroyed stars report the destroyed phase only after the intervention time', () => {
    const s = starTimeline(1, 0, 0);
    expect(starPhaseAt(s, 4e9, 5e9)).toBe('main-sequence');
    expect(starPhaseAt(s, 6e9, 5e9)).toBe('destroyed');
  });
});
