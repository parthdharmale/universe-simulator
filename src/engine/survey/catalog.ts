import { PLANET_FORMATION_DELAY } from '../core/constants';
import { countInRange, upperBound } from '../core/math';
import { Universe } from '../gen/galaxy';
import { GalaxySurvey, HAB_COLS, LIFE_COLS, L_END, L_H, L_OCEANS, L_PLANET, L_STAR, L_T } from './survey';

/**
 * UniverseCatalog: the merged, query-optimised view of all galaxy surveys.
 *
 * Every time-dependent population statistic is a difference of two sorted arrays:
 *     alive(t) = #{start ≤ t} − #{end ≤ t}
 * so stats at *any* time — present, past or future — cost two binary searches.
 * Feed events (supernovae, first life …) between two frames are found the same way.
 */

export interface LifeRecord {
  row: number;
  g: number;
  s: number;
  p: number;
  H: number;
  /** stage → first-reach time (index 2..7), Infinity if never. */
  t: number[];
  end: number;
  oceans: number;
}

export const planetKey = (g: number, s: number, p: number) => (g * 1_000_000 + s) * 32 + p;
export const starKey = (g: number, s: number) => g * 1_000_000 + s;
export const decodeStarKey = (k: number): [number, number] => [Math.floor(k / 1_000_000), k % 1_000_000];
export const decodePlanetKey = (k: number): [number, number, number] => {
  const p = k % 32;
  const sk = (k - p) / 32;
  return [Math.floor(sk / 1_000_000), sk % 1_000_000, p];
};

export class UniverseCatalog {
  readonly starOffset: Int32Array;
  readonly totalStars: number;
  readonly totalPlanets: number;

  readonly births: Float64Array;
  readonly planetPrefix: Float64Array;
  readonly deaths: Float64Array;
  /** Global star ids sorted by end of main sequence (red-giant onset). */
  readonly msEndOrder: Uint32Array;
  readonly msEndSorted: Float64Array;
  readonly deathOrder: Uint32Array;
  readonly deathSorted: Float64Array;
  readonly remnantStarts: Float64Array;
  readonly galaxyFormation: Float64Array;

  readonly habStart: Float64Array;
  readonly habEnd: Float64Array;

  readonly life: LifeRecord[];
  readonly lifeByKey = new Map<number, LifeRecord>();
  readonly stageReach: Float64Array[] = [];
  readonly stageEnd: Float64Array[] = [];
  readonly stageOrder: Uint32Array[] = [];

  constructor(
    readonly universe: Universe,
    readonly surveys: GalaxySurvey[],
  ) {
    const G = universe.galaxies.length;
    this.starOffset = new Int32Array(G + 1);
    for (let g = 0; g < G; g++) this.starOffset[g + 1] = this.starOffset[g] + surveys[g].catalog.count;
    const N = this.starOffset[G];
    this.totalStars = N;

    // ---- stars ----
    const birthIdx = new Uint32Array(N);
    const birthAll = new Float64Array(N);
    const msEndAll = new Float64Array(N);
    const deathAll = new Float64Array(N);
    const pc = new Uint8Array(N);
    for (let g = 0; g < G; g++) {
      const c = surveys[g].catalog;
      const off = this.starOffset[g];
      birthAll.set(c.birth, off);
      msEndAll.set(c.msEnd, off);
      deathAll.set(c.death, off);
      pc.set(surveys[g].planetCount, off);
    }
    for (let i = 0; i < N; i++) birthIdx[i] = i;
    birthIdx.sort((a, b) => birthAll[a] - birthAll[b]);
    this.births = new Float64Array(N);
    this.planetPrefix = new Float64Array(N + 1);
    let planets = 0;
    for (let k = 0; k < N; k++) {
      const i = birthIdx[k];
      this.births[k] = birthAll[i];
      planets += pc[i];
      this.planetPrefix[k + 1] = planets;
    }
    this.totalPlanets = planets;

    this.msEndOrder = sortIndexBy(msEndAll);
    this.msEndSorted = gather(msEndAll, this.msEndOrder);
    this.deathOrder = sortIndexBy(deathAll);
    this.deathSorted = gather(deathAll, this.deathOrder);
    this.deaths = this.deathSorted;
    this.remnantStarts = this.deathSorted;
    this.galaxyFormation = Float64Array.from(universe.galaxies.map((g) => g.formation)).sort();

    // ---- habitable windows ----
    const hs: number[] = [];
    const he: number[] = [];
    for (const sv of surveys) {
      for (let r = 0; r < sv.habitable.length; r += HAB_COLS) {
        hs.push(sv.habitable[r + 2]);
        he.push(sv.habitable[r + 3]);
      }
    }
    this.habStart = Float64Array.from(hs).sort();
    this.habEnd = Float64Array.from(he).sort();

    // ---- biospheres ----
    this.life = [];
    for (const sv of surveys) {
      const L = sv.life;
      for (let r = 0; r < L.length; r += LIFE_COLS) {
        const t: number[] = [Infinity, Infinity];
        for (let k = 2; k <= 7; k++) t.push(L[r + L_T(k)]);
        const rec: LifeRecord = {
          row: this.life.length,
          g: sv.galaxy,
          s: L[r + L_STAR],
          p: L[r + L_PLANET],
          H: L[r + L_H],
          t,
          end: L[r + L_END],
          oceans: L[r + L_OCEANS],
        };
        this.life.push(rec);
        this.lifeByKey.set(planetKey(rec.g, rec.s, rec.p), rec);
      }
    }
    for (let k = 0; k <= 7; k++) {
      if (k < 2) {
        this.stageReach.push(new Float64Array(0));
        this.stageEnd.push(new Float64Array(0));
        this.stageOrder.push(new Uint32Array(0));
        continue;
      }
      const reached = this.life.filter((l) => isFinite(l.t[k]));
      const reach = Float64Array.from(reached.map((l) => l.t[k]));
      const order = sortIndexBy(reach);
      this.stageReach.push(gather(reach, order));
      this.stageOrder.push(Uint32Array.from(order, (i) => reached[i].row));
      this.stageEnd.push(Float64Array.from(reached.map((l) => l.end)).sort());
    }
  }

  globalToLocal(gid: number): [number, number] {
    const g = upperBound(this.starOffset, gid) - 1;
    return [g, gid - this.starOffset[g]];
  }

  galaxiesFormed(t: number) {
    return upperBound(this.galaxyFormation, t);
  }
  /** Luminous stars (born, not yet a remnant). */
  starsShining(t: number) {
    return upperBound(this.births, t) - upperBound(this.deaths, t);
  }
  starsBorn(t: number) {
    return upperBound(this.births, t);
  }
  remnants(t: number) {
    return upperBound(this.deaths, t);
  }
  planetsFormed(t: number) {
    return this.planetPrefix[upperBound(this.births, t - PLANET_FORMATION_DELAY)];
  }
  habitable(t: number) {
    return upperBound(this.habStart, t) - upperBound(this.habEnd, t);
  }
  /** Planets whose biosphere is at stage ≥ k at time t. */
  atStage(k: number, t: number) {
    return upperBound(this.stageReach[k], t) - upperBound(this.stageEnd[k], t);
  }
  /** Number of stage-k transitions in (t0, t1]. */
  stageEventsIn(k: number, t0: number, t1: number) {
    return countInRange(this.stageReach[k], t0, t1);
  }

  get catalogs() {
    return this.surveys.map((s) => s.catalog);
  }
}

function sortIndexBy(values: Float64Array): Uint32Array {
  const idx = new Uint32Array(values.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  // Stable tiebreak on index keeps ordering deterministic for equal times.
  idx.sort((a, b) => values[a] - values[b] || a - b);
  return idx;
}

function gather(values: Float64Array, order: Uint32Array): Float64Array {
  const out = new Float64Array(order.length);
  for (let i = 0; i < order.length; i++) out[i] = values[order[i]];
  return out;
}
