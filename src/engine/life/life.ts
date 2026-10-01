import { Rng, hash32, hashFloat } from '../core/rng';
import { clamp, clamp01, smoothstep } from '../core/math';

/**
 * Life model.
 *
 * Evolution is modelled as accumulation of "evolutionary work" at a rate set by the
 * planet's habitability H:   rate = H   (reference-years per year; Earth H≈1).
 * Each stage transition k → k+1 needs BASE_DURATION[k] · luck_k reference-years, and must
 * pass a *gate* (a per-planet fixed random roll compared against a probability that grows
 * with H) — these are the "great filters". Failing a gate is an evolutionary dead end.
 *
 * Because H is piecewise-constant (it only changes when a user intervention changes the
 * planet's environment, or the star dies), stage times are computed *analytically* per
 * segment rather than by stepping. For an unmodified planet there is a single segment,
 * so its whole biological history is closed-form: the survey can evaluate it for every
 * planet in the universe, and the state at any time t is a pure function — which is what
 * makes time travel and universe-wide life statistics O(log n).
 *
 * Mass extinctions arrive as a deterministic Poisson process (own RNG stream) and set back
 * the progress of complex life, delaying intelligence.
 */

export const Stage = { NONE: 0, CHEM: 1, REPL: 2, CELL: 3, MULTI: 4, COMPLEX: 5, INTEL: 6, CIV: 7 } as const;
export const STAGE_NAMES = [
  'Sterile',
  'Chemical complexity',
  'Simple replicators',
  'Single-celled life',
  'Multicellular life',
  'Complex organisms',
  'Intelligent life',
  'Civilization',
];

/** Reference duration (years at H = 1) of the transition from stage k to k+1. Earth-calibrated. */
export const BASE_DURATION = [0, 1.5e8, 2.5e8, 1.6e9, 5.0e8, 5.5e8, 2.0e5];

/** Probability that the transition into stage k is ever achieved, given habitability H. */
export function gateProbability(k: number, H: number): number {
  switch (k) {
    case 2:
      return clamp(1.5 * H * H, 0, 0.95); // abiogenesis
    case 3:
      return 0.9; // cellularity
    case 4:
      return 0.3 + 0.4 * H; // multicellularity (needs O₂ / energy)
    case 5:
      return 0.75;
    case 6:
      return 0.15 + 0.35 * H; // intelligence — the hardest filter
    case 7:
      return 0.85;
    default:
      return 1;
  }
}

/** Minimum habitability below which life cannot persist. */
export const H_MIN = 0.02;
const MASS_EXTINCTION_MEAN_INTERVAL = 1.5e8;

export interface LifeGenome {
  seed: number;
  coolingDelay: number;
  luck: number[];
  gateRoll: number[];
}

export function lifeGenome(planetSeed: number): LifeGenome {
  const rng = new Rng(hash32(planetSeed, 0x11fe));
  const coolingDelay = rng.logRange(2e8, 6e8);
  const luck = [1];
  for (let k = 1; k <= 6; k++) luck.push(rng.logNormal(1, 0.45));
  const gateRoll = [0, 0];
  for (let k = 2; k <= 7; k++) gateRoll.push(rng.next());
  return { seed: hash32(planetSeed, 0x11ff), coolingDelay, luck, gateRoll };
}

export interface HSegment {
  t: number;
  H: number;
}

export type ImpulseKind = 'boost' | 'impact' | 'sterilize';
export interface LifeImpulse {
  t: number;
  kind: ImpulseKind;
  /** Severity 0..1 for impacts. */
  amount: number;
}

export type LifeEventKind = 'oceans' | 'stage' | 'dead-end' | 'mass-extinction' | 'sterilized' | 'star-death' | 'boost' | 'impact';

export interface LifeEvent {
  t: number;
  kind: LifeEventKind;
  stage: number;
  /** Fraction of progress lost (mass extinctions / impacts). */
  severity?: number;
}

export interface LifeTimeline {
  events: LifeEvent[];
  /** First-reach time of each stage in the *latest* continuous run of life (Infinity if never). */
  stageTimes: number[];
  /** Time life (latest run) ended; Infinity if it persists past `until`. */
  end: number;
  oceans: number;
}

export interface LifeInputs {
  formation: number;
  windowEnd: number;
  segments: HSegment[];
  impulses?: LifeImpulse[];
  until: number;
  /** If false, mass extinctions are not listed (still applied) — saves memory in the survey. */
  recordExtinctions?: boolean;
}

export function integrateLife(gen: LifeGenome, inp: LifeInputs): LifeTimeline {
  const events: LifeEvent[] = [];
  const stageTimes = new Array(8).fill(Infinity);
  const oceans = inp.formation + gen.coolingDelay;
  const until = Math.min(inp.until, inp.windowEnd);
  let end = Infinity;

  // Breakpoints: H changes, impulses, window start/end. Mass extinctions are generated lazily.
  const segs = inp.segments.slice().sort((a, b) => a.t - b.t);
  const imps = (inp.impulses ?? []).slice().sort((a, b) => a.t - b.t);
  const extRng = new Rng(gen.seed);
  let nextExt = oceans + extRng.exponential(MASS_EXTINCTION_MEAN_INTERVAL);
  let extN = 0;

  const Hat = (t: number) => {
    let h = segs.length ? segs[0].H : 0;
    for (const s of segs) if (s.t <= t) h = s.H;
    return h;
  };

  let t = oceans;
  let stage = 0;
  let work = 0;
  let stuck = false;
  if (t >= until) return { events, stageTimes, end, oceans };
  events.push({ t: oceans, kind: 'oceans', stage: 0 });

  let segIdx = segs.findIndex((s) => s.t > t);
  if (segIdx < 0) segIdx = segs.length;
  let impIdx = imps.findIndex((s) => s.t >= t);
  if (impIdx < 0) impIdx = imps.length;

  const startChemistry = (at: number) => {
    stage = Stage.CHEM;
    work = 0;
    stuck = false;
    stageTimes.fill(Infinity);
    stageTimes[Stage.CHEM] = at;
    end = Infinity;
    events.push({ t: at, kind: 'stage', stage: Stage.CHEM });
  };
  const sterilize = (at: number, kind: LifeEventKind) => {
    if (stage > 0) {
      events.push({ t: at, kind, stage: 0 });
      end = at;
    }
    stage = 0;
    work = 0;
    stuck = false;
  };

  let H = Hat(t);
  if (H > H_MIN) startChemistry(t);

  let guard = 0;
  while (t < until && guard++ < 10000) {
    // Nothing further can change: no pending H changes/impulses and evolution has halted.
    if ((stuck || stage === Stage.CIV || stage === 0) && segIdx >= segs.length && impIdx >= imps.length) break;
    const nextSeg = segIdx < segs.length ? segs[segIdx].t : Infinity;
    const nextImp = impIdx < imps.length ? imps[impIdx].t : Infinity;
    const nextBreak = Math.min(nextSeg, nextImp, nextExt, until);
    const rate = H > H_MIN ? H : 0;

    // Advance through stage transitions inside [t, nextBreak).
    while (stage >= 1 && stage < Stage.CIV && !stuck && rate > 0) {
      const need = BASE_DURATION[stage] * gen.luck[stage] - work;
      const tReach = t + need / rate;
      if (tReach > nextBreak) {
        work += rate * (nextBreak - t);
        break;
      }
      t = tReach;
      work = 0;
      const k = stage + 1;
      if (gen.gateRoll[k] < gateProbability(k, H)) {
        stage = k;
        stageTimes[k] = t;
        events.push({ t, kind: 'stage', stage: k });
      } else {
        stuck = true;
        events.push({ t, kind: 'dead-end', stage });
      }
    }
    if (nextBreak === Infinity || nextBreak >= until) {
      t = until;
      break;
    }
    t = nextBreak;

    if (t === nextExt) {
      // Mass extinction: severity from a per-event hash (independent of current stage, so
      // the sequence is identical across interventions).
      const sev = 0.03 + 0.25 * Math.pow(hashFloat(gen.seed, extN), 3);
      extN++;
      nextExt = t + extRng.exponential(MASS_EXTINCTION_MEAN_INTERVAL);
      if (stage >= Stage.MULTI && stage < Stage.INTEL) {
        work = Math.max(0, work - BASE_DURATION[Stage.COMPLEX] * sev);
        if (inp.recordExtinctions !== false) events.push({ t, kind: 'mass-extinction', stage, severity: sev });
      }
    }
    while (segIdx < segs.length && segs[segIdx].t <= t) {
      H = segs[segIdx].H;
      segIdx++;
      if (H <= H_MIN && stage > 0) sterilize(t, 'sterilized');
      else if (H > H_MIN && stage === 0) startChemistry(t);
    }
    while (impIdx < imps.length && imps[impIdx].t <= t) {
      const imp = imps[impIdx++];
      if (imp.kind === 'boost') {
        if (stage === 0 && H > H_MIN) startChemistry(t);
        else if (stage >= 1 && stage < Stage.CIV) {
          stage++;
          stageTimes[stage] = t;
          work = 0;
          stuck = false;
          events.push({ t, kind: 'boost', stage });
        }
      } else if (imp.kind === 'sterilize') {
        sterilize(t, 'sterilized');
      } else if (imp.kind === 'impact') {
        if (imp.amount > 0.92 && stage >= 1) sterilize(t, 'impact');
        else if (stage >= Stage.MULTI) {
          events.push({ t, kind: 'impact', stage, severity: imp.amount });
          work = Math.max(0, work - BASE_DURATION[Math.min(stage, 6)] * gen.luck[Math.min(stage, 6)] * imp.amount);
        }
      }
    }
  }
  if (inp.windowEnd <= inp.until && stage > 0) {
    events.push({ t: inp.windowEnd, kind: 'star-death', stage: 0 });
    end = inp.windowEnd;
  }
  return { events, stageTimes, end, oceans };
}

export interface LifeState {
  stage: number;
  stageName: string;
  /** Progress toward next stage 0..1 (approximate, for display). */
  progress: number;
  since: number;
  alive: boolean;
  oceansFormed: boolean;
}

/** Biological state at time t from a precomputed timeline. */
export function lifeStateAt(tl: LifeTimeline, t: number): LifeState {
  let stage = 0;
  let since = tl.oceans;
  for (const e of tl.events) {
    if (e.t > t) break;
    if (e.kind === 'stage' || e.kind === 'boost') {
      stage = e.stage;
      since = e.t;
    } else if (e.kind === 'sterilized' || e.kind === 'star-death' || (e.kind === 'impact' && e.stage === 0)) {
      stage = 0;
      since = e.t;
    }
  }
  let progress = 0;
  if (stage >= 1 && stage < Stage.CIV) {
    const next = tl.stageTimes[stage + 1];
    if (isFinite(next) && next > since) progress = clamp01((t - since) / (next - since));
  }
  return { stage, stageName: STAGE_NAMES[stage], progress, since, alive: stage >= Stage.REPL, oceansFormed: t >= tl.oceans };
}

/** Atmospheric O₂ partial-pressure fraction produced by photosynthesis (Great Oxidation analogue). */
export function oxygenFraction(tl: LifeTimeline, t: number): number {
  const t3 = tl.stageTimes[Stage.CELL];
  if (!isFinite(t3) || t < t3 || (isFinite(tl.end) && t >= tl.end)) return 0;
  return 0.21 * smoothstep(t3 + 1.0e9, t3 + 2.8e9, t);
}

/** Fossil hydrocarbons accumulate while multicellular life has existed (0..1). */
export function hydrocarbonIndex(tl: LifeTimeline, t: number): number {
  const t4 = tl.stageTimes[Stage.MULTI];
  if (!isFinite(t4) || t < t4) return 0;
  return clamp01((t - t4) / 1.5e9) * 0.9;
}
