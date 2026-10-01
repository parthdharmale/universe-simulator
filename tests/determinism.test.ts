import { describe, expect, it } from 'vitest';
import { generateUniverse, generateStarCatalog } from '../src/engine/gen/galaxy';
import { generateSystem } from '../src/engine/gen/planets';
import { surveyGalaxy } from '../src/engine/survey/survey';
import { PRESENT_YEARS } from '../src/engine/core/constants';
import { SMALL, hashNumbers, makeSim, universeHash } from './fixtures';

/**
 * The central guarantee: (seed, interventions, time) fully determine the universe.
 */
describe('determinism', () => {
  it('seed 123456 generates the same universe every time (galaxies, stars, planets, life)', () => {
    const a = makeSim(123456);
    const b = makeSim(123456);
    expect(universeHash(a)).toBe(universeHash(b));
    expect(a.catalog!.totalStars).toBe(b.catalog!.totalStars);
    expect(a.catalog!.totalPlanets).toBe(b.catalog!.totalPlanets);
    // Detailed planetary systems (with moons and dynamics) are identical too.
    const sa = a.queries.getSystem(3, 17)!, sb = b.queries.getSystem(3, 17)!;
    expect(JSON.stringify(sa)).toBe(JSON.stringify(sb));
  });

  it('seed 123456 produces identical civilizations and history when run to the present', () => {
    const a = makeSim(123456);
    const b = makeSim(123456);
    a.advanceTo(PRESENT_YEARS);
    // b advances in many uneven increments: the result must not depend on frame timing.
    let t = 0;
    let k = 0;
    while (t < PRESENT_YEARS) {
      t = Math.min(PRESENT_YEARS, t + 3.7e7 * (1 + (k++ % 5)));
      b.advanceTo(t);
    }
    expect(a.civs.civs.length).toBeGreaterThan(0);
    expect(a.civs.stateHash()).toBe(b.civs.stateHash());
    expect(JSON.stringify(a.stats())).toBe(JSON.stringify(b.stats()));
  });

  it('seed 123456 and seed 123457 produce different universes', () => {
    const a = makeSim(123456);
    const b = makeSim(123457);
    expect(universeHash(a)).not.toBe(universeHash(b));
    const posA = a.universe.galaxies.map((g) => g.position).flat();
    const posB = b.universe.galaxies.map((g) => g.position).flat();
    expect(hashNumbers(posA)).not.toBe(hashNumbers(posB));
    // Not just shifted: different galaxy types and star counts.
    expect(a.universe.galaxies.map((g) => g.type).join()).not.toBe(b.universe.galaxies.map((g) => g.type).join());
    expect(a.catalog!.totalStars).not.toBe(b.catalog!.totalStars);
  });

  it('lazy generation is order-independent (galaxy 5 before galaxy 2 gives identical results)', () => {
    const u = generateUniverse({ seed: 99, ...SMALL });
    const c5first = generateStarCatalog(u.galaxies[5]);
    const c2 = generateStarCatalog(u.galaxies[2]);
    const c5again = generateStarCatalog(u.galaxies[5]);
    expect(hashNumbers(c5first.mass)).toBe(hashNumbers(c5again.mass));
    expect(hashNumbers(c5first.birth)).toBe(hashNumbers(c5again.birth));
    expect(c2.count).toBe(u.galaxies[2].starCount);
    // A star's system is a pure function of its seed, regardless of what was generated before.
    const inp = { g: 5, s: 10, seed: 777, mass: 1, feh: 0, birth: 5e9 };
    const s1 = generateSystem(inp);
    generateSystem({ ...inp, s: 11, seed: 778 });
    expect(JSON.stringify(generateSystem(inp))).toBe(JSON.stringify(s1));
  });

  it('survey planets equal the detailed generator (moons/dynamics use separate RNG streams)', () => {
    const u = generateUniverse({ seed: 31337, ...SMALL });
    const sv = surveyGalaxy(u.galaxies[0]);
    const sim = makeSim(31337);
    for (let s = 0; s < 200; s++) {
      const sys = sim.queries.getSystem(0, s)!;
      expect(sys.planets.length).toBe(sv.planetCount[s]);
    }
  });
});
