import { Simulation } from '../src/engine/sim/simulation';
import { surveyGalaxy } from '../src/engine/survey/survey';
import { UniverseConfig } from '../src/engine/gen/galaxy';
import { mix32 } from '../src/engine/core/rng';

/** A small but complete universe: fast enough for unit tests, large enough to contain civs. */
export const SMALL: Omit<UniverseConfig, 'seed'> = { galaxyCount: 24, starDensity: 0.6 };

export function makeSim(seed: number, cfg: Omit<UniverseConfig, 'seed'> = SMALL): Simulation {
  const sim = new Simulation({ seed, ...cfg });
  sim.attachSurveys(sim.universe.galaxies.map(surveyGalaxy));
  return sim;
}

/** Exact hash of any typed array / number list (IEEE-754 bit patterns). */
export function hashNumbers(values: ArrayLike<number>, h = 0x1234567): number {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < values.length; i++) {
    f[0] = values[i];
    h = mix32(h ^ u[0]);
    h = mix32(h ^ u[1]);
  }
  return h >>> 0;
}

/** Hash of the generated universe: galaxies, every star catalog, every survey record. */
export function universeHash(sim: Simulation): number {
  let h = 0;
  for (const g of sim.universe.galaxies) h = hashNumbers([...g.position, g.radius, g.mass, g.starCount, g.formation, g.metallicity, g.arms, g.pitch], h);
  for (const sv of sim.catalog!.surveys) {
    const c = sv.catalog;
    for (const arr of [c.x, c.y, c.z, c.mass, c.feh, c.birth, c.death, c.lum, c.temp, sv.planetCount, sv.habitable, sv.life]) h = hashNumbers(arr, h);
  }
  return h;
}

/** Find a habitable rocky planet (deterministic search). */
export function findHabitablePlanet(sim: Simulation, minH = 0.4) {
  for (const sv of sim.catalog!.surveys) {
    for (let r = 0; r < sv.habitable.length; r += 4) {
      const s = sv.habitable[r], p = sv.habitable[r + 1];
      const sys = sim.queries.getSystem(sv.galaxy, s)!;
      const pl = sys.planets[p];
      if (pl.habitability >= minH && sys.star.mass > 0.7 && sys.star.mass < 1.3) return { g: sv.galaxy, s, p, planet: pl, sys };
    }
  }
  throw new Error('no habitable planet in fixture universe');
}
