import { MAX_YEARS } from '../core/constants';
export { PLANET_FORMATION_DELAY } from '../core/constants';
import { Galaxy, StarCatalog, generateStarCatalog, starSeed } from '../gen/galaxy';
import { generateSystem } from '../gen/planets';
import { H_MIN, integrateLife, lifeGenome } from '../life/life';

/**
 * The survey is a pure function: Galaxy → compact summary of every star, planet and
 * biosphere in it. It is the only place the whole universe is enumerated, and it produces
 * flat typed arrays (transferable between threads without copying).
 *
 * Planets are generated *without* moons and secular dynamics (those use independent RNG
 * streams, so the planets are identical to the ones the detailed system view generates).
 */

export const HABITABLE_THRESHOLD = 0.4;

/** Columns of a life row. */
export const LIFE_COLS = 11;
export const L_STAR = 0, L_PLANET = 1, L_H = 2; // then stage times 2..7 at cols 3..8
export const L_T = (stage: number) => 1 + stage; // stage 2 → col 3 … stage 7 → col 8
export const L_END = 9, L_OCEANS = 10;

export const HAB_COLS = 4; // s, p, start, end

export interface GalaxySurvey {
  galaxy: number;
  catalog: StarCatalog;
  planetCount: Uint8Array;
  /** Rows of [star, planet, start, end] for planets with H ≥ HABITABLE_THRESHOLD. */
  habitable: Float64Array;
  /** Rows of LIFE_COLS for planets whose biosphere reaches at least simple replicators. */
  life: Float64Array;
  totalPlanets: number;
  totalMoonsEstimate: number;
  elapsedMs: number;
}

export function surveyGalaxy(gal: Galaxy): GalaxySurvey {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const catalog = generateStarCatalog(gal);
  const n = catalog.count;
  const planetCount = new Uint8Array(n);
  const hab: number[] = [];
  const life: number[] = [];
  let totalPlanets = 0;

  for (let s = 0; s < n; s++) {
    const sys = generateSystem(
      { g: gal.index, s, seed: starSeed(gal.seed, s), mass: catalog.mass[s], feh: catalog.feh[s], birth: catalog.birth[s] },
      { moons: false, dynamics: false },
    );
    planetCount[s] = sys.planets.length;
    totalPlanets += sys.planets.length;
    const msEnd = catalog.msEnd[s];
    for (const p of sys.planets) {
      if (p.formation >= msEnd) continue;
      if (p.habitability >= HABITABLE_THRESHOLD) hab.push(s, p.index, p.formation, msEnd);
      if (p.habitability <= H_MIN) continue;
      const tl = integrateLife(lifeGenome(p.seed), {
        formation: p.formation,
        windowEnd: msEnd,
        segments: [{ t: p.formation, H: p.habitability }],
        until: MAX_YEARS,
        recordExtinctions: false,
      });
      if (!isFinite(tl.stageTimes[2])) continue;
      life.push(s, p.index, p.habitability);
      for (let k = 2; k <= 7; k++) life.push(tl.stageTimes[k]);
      life.push(tl.end, tl.oceans);
    }
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    galaxy: gal.index,
    catalog,
    planetCount,
    habitable: Float64Array.from(hab),
    life: Float64Array.from(life),
    totalPlanets,
    totalMoonsEstimate: Math.round(totalPlanets * 1.6),
    elapsedMs: t1 - t0,
  };
}

/** Typed arrays to transfer (zero-copy) from a worker. */
export function surveyTransferables(s: GalaxySurvey): ArrayBuffer[] {
  const c = s.catalog;
  return [c.x, c.y, c.z, c.mass, c.feh, c.birth, c.msEnd, c.death, c.lum, c.temp, s.planetCount, s.habitable, s.life].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
