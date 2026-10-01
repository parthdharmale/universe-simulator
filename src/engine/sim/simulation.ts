import { MAX_YEARS, PLANET_FORMATION_DELAY, YEAR_S } from '../core/constants';
import { countInRange, upperBound } from '../core/math';
import { SimTime, addYears, cloneTime, makeTime, timeYears } from '../core/time';
import { planetId, starId } from '../core/names';
import { Universe, UniverseConfig, generateUniverse } from '../gen/galaxy';
import { HABITABLE_THRESHOLD, GalaxySurvey, HAB_COLS } from '../survey/survey';
import { UniverseCatalog, planetKey, starKey } from '../survey/catalog';
import { CivEngine, CivSnapshot, EmittedEvent, SpawnEntry } from '../civ/civEngine';
import { TECH_NAMES, techLevel, totalPopulation } from '../civ/civilization';
import { STAGE_NAMES, Stage } from '../life/life';
import { CIV_STATE_KINDS, INTERVENTION_LABELS, Intervention, InterventionKind, InterventionTarget, OverrideLayer, branchAndAppend } from './interventions';
import { UniverseQueries } from './world';
import { EntityRef, FeedEvent, FeedCategory, Severity, UniverseStats } from './types';
import { hash32 } from '../core/rng';

interface Checkpoint {
  time: number;
  ivCursor: number;
  steps: number;
  civ: CivSnapshot;
}

export const SPEED_PRESETS = [
  { label: '1×', value: 1 },
  { label: '10×', value: 10 },
  { label: '100×', value: 100 },
  { label: '1K×', value: 1e3 },
  { label: '10K×', value: 1e4 },
  { label: '1M×', value: 1e6 },
  { label: '100M×', value: 1e8 },
  { label: '10B×', value: 1e10 },
  { label: '1T×', value: 1e12 },
  { label: '100T×', value: 1e14 },
  { label: '1Q×', value: 1e15 },
  { label: '10Q×', value: 1e16 },
];

const FEED_CAPACITY = 400;
const CHECKPOINT_MIN_INTERVAL = 2e8; // years
const CHECKPOINT_MAX_STEPS = 3000;
const CHECKPOINT_CAP = 320;
const CHUNK_STEPS = 2500;

export interface AdvanceResult {
  reached: number;
  steps: number;
  lagging: boolean;
}

/**
 * Simulation: the engine facade. Owns time, the civilization engine, the intervention log,
 * checkpoints and the event feed. Independent of React and rendering — fully testable in Node.
 *
 * Time model
 *  - Rendering time: wall-clock frames (variable dt).
 *  - Simulation time: `clock` advances by realDt × speed, but the *state* advances only in
 *    whole civilization steps of state-determined length (fixed, deterministic timesteps).
 *    Everything else (stars, life, climate) is a pure function of time, evaluated on demand.
 *  - If the per-frame work budget is exhausted, simulation time lags behind the requested
 *    time rather than skipping work (determinism over smoothness).
 */
export class Simulation {
  readonly universe: Universe;
  readonly overrides = new OverrideLayer();
  readonly queries: UniverseQueries;
  readonly civs: CivEngine;
  catalog: UniverseCatalog | null = null;

  clock: SimTime = makeTime(0);
  speed = 1e16;
  paused = false;
  direction: 1 | -1 = 1;
  lagging = false;

  interventions: Intervention[] = [];
  private ivCursor = 0;
  private nextInterventionId = 1;

  feed: FeedEvent[] = [];
  private feedId = 1;
  suppressFeed = false;
  feedListeners = new Set<(e: FeedEvent) => void>();

  private checkpoints: Checkpoint[] = [];
  private lastCheckpointSteps = 0;

  /** Rolling metrics for the debug panel. */
  metrics = { stepsLastFrame: 0, stepsPerSecond: 0, advanceMs: 0, lastFrameStepsTimestamp: 0, stepAccumulator: 0 };

  constructor(readonly config: UniverseConfig) {
    this.universe = generateUniverse(config);
    this.queries = new UniverseQueries(this.universe, null, this.overrides);
    this.civs = new CivEngine(this.queries);
  }

  get seed() {
    return this.config.seed;
  }
  now(): number {
    return timeYears(this.clock);
  }
  get ready() {
    return this.catalog !== null;
  }

  /** Attach survey results (from workers or synchronous survey). */
  attachSurveys(surveys: GalaxySurvey[]) {
    this.catalog = new UniverseCatalog(this.universe, surveys);
    this.queries.catalog = this.catalog;
    this.rebuildDerived();
    if (this.checkpoints.length === 0) this.pushCheckpoint();
  }

  // ---- derived state from the intervention log ---------------------------------------------

  private rebuildDerived() {
    if (!this.catalog) return;
    const cat = this.catalog;
    this.overrides.rebuild(this.interventions, (g) => cat.surveys[g].catalog.count);
    this.queries.invalidate();
    this.civs.setSchedule(this.buildSpawnSchedule());
  }

  private buildSpawnSchedule(): SpawnEntry[] {
    const cat = this.catalog!;
    const entries: SpawnEntry[] = [];
    const ov = this.overrides;
    for (const rec of cat.life) {
      const key = planetKey(rec.g, rec.s, rec.p);
      if (ov.modifiedPlanets.has(key) || ov.modifiedStars.has(starKey(rec.g, rec.s))) continue;
      const t7 = rec.t[Stage.CIV];
      if (!isFinite(t7) || t7 > MAX_YEARS) continue;
      entries.push({ key: `n:${key}`, id: 0, seed: hash32(this.queries.planetSeed(rec.g, rec.s, rec.p), 0xc17), g: rec.g, s: rec.s, p: rec.p, t: t7, source: 'natural' });
    }
    // Modified planets (and all planets of modified stars, and planets of created stars).
    const recompute = new Set<number>(ov.modifiedPlanets);
    for (const sk of ov.modifiedStars) {
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      const sys = this.queries.getSystem(g, s);
      sys?.planets.forEach((p) => recompute.add(planetKey(g, s, p.index)));
    }
    for (const cs of ov.createdStars) {
      const sys = this.queries.getSystem(cs.g, cs.s);
      sys?.planets.forEach((p) => recompute.add(planetKey(cs.g, cs.s, p.index)));
    }
    for (const key of recompute) {
      const p = key % 32;
      const sk = (key - p) / 32;
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      const tl = this.queries.lifeTimeline(g, s, p);
      const t7 = tl?.stageTimes[Stage.CIV];
      if (t7 !== undefined && isFinite(t7) && t7 <= MAX_YEARS)
        entries.push({ key: `n:${key}`, id: 0, seed: hash32(this.queries.planetSeed(g, s, p), 0xc17), g, s, p, t: t7, source: 'natural' });
    }
    for (const iv of this.interventions) {
      if (iv.kind === 'spawn-civilization' && iv.target.s !== undefined && iv.target.p !== undefined)
        entries.push({ key: `i:${iv.id}`, id: 0, seed: hash32(this.queries.planetSeed(iv.target.g, iv.target.s, iv.target.p), 0x5b, iv.id), g: iv.target.g, s: iv.target.s, p: iv.target.p, t: iv.t, source: 'intervention' });
    }
    return entries;
  }

  // ---- time advancement ------------------------------------------------------------------------

  /** Called once per rendered frame with the wall-clock delta (seconds). */
  update(realDt: number, budgetMs = 8): void {
    if (!this.catalog || this.paused) {
      this.metrics.stepsLastFrame = 0;
      return;
    }
    const dt = Math.min(Math.max(realDt, 0), 0.1);
    const dy = (dt * this.speed) / YEAR_S;
    if (this.direction > 0) {
      const target = addYears(this.clock, dy);
      if (timeYears(target) > MAX_YEARS) {
        this.paused = true;
        return;
      }
      this.advanceClockTo(target, budgetMs);
    } else {
      const t = Math.max(0, this.now() - dy);
      this.seek(t);
      if (t <= 0) this.paused = true;
    }
  }

  /** Advance to the given precise time, within a work budget. */
  advanceClockTo(target: SimTime, budgetMs = Infinity): AdvanceResult {
    const t0 = this.now();
    const targetYears = timeYears(target);
    const res = this.advanceState(targetYears, budgetMs);
    this.lagging = res.lagging;
    this.clock = res.lagging ? makeTime(res.reached) : cloneTime(target);
    if (!this.suppressFeed) this.emitPureEvents(t0, this.now());
    return res;
  }

  advanceTo(targetYears: number, budgetMs = Infinity): AdvanceResult {
    return this.advanceClockTo(makeTime(targetYears), budgetMs);
  }

  private civStateInterventions(): Intervention[] {
    return this.interventions.filter((iv) => CIV_STATE_KINDS.includes(iv.kind));
  }

  private advanceState(target: number, budgetMs: number): AdvanceResult {
    const start = performance.now();
    const stepsBefore = this.civs.totalSteps;
    let reached = this.civs.time;
    const civIvs = this.civStateInterventions();
    const emitted: EmittedEvent[] = [];
    let outOfBudget = false;
    while (reached < target && !outOfBudget) {
      const next = civIvs[this.ivCursor];
      const ivPending = next !== undefined && next.t <= target;
      const segEnd = ivPending ? Math.max(reached, next.t) : target;
      while (reached < segEnd) {
        // Chunk so each one is a bounded amount of work: ~CHUNK_STEPS steps of the live
        // civilizations, and never past the next emergence (a newborn civilization would
        // otherwise be simulated through its whole history inside a single unbudgeted chunk).
        const spy = this.civs.stepsPerYear();
        const chunk = spy > 0 ? Math.max(1, CHUNK_STEPS / spy) : Infinity;
        const nextSpawn = this.civs.nextSpawnAfter(reached);
        const tNext = Math.min(segEnd, reached + chunk, nextSpawn);
        this.civs.advanceTo(tNext, emitted);
        reached = tNext;
        const atIv = ivPending && reached === segEnd;
        if (!atIv) this.maybeCheckpoint();
        if (performance.now() - start > budgetMs) {
          outOfBudget = true;
          break;
        }
      }
      // Civ-state interventions are applied exactly when the engine reaches their timestamp.
      // Checkpoints are only taken *after* application, so a checkpoint at time C always
      // includes every intervention with t ≤ C (restore sets the cursor accordingly).
      if (ivPending && reached >= next.t) {
        this.applyCivIntervention(next, emitted);
        this.ivCursor++;
        this.maybeCheckpoint();
      }
    }
    const steps = this.civs.totalSteps - stepsBefore;
    this.metrics.stepsLastFrame = steps;
    this.metrics.advanceMs = performance.now() - start;
    this.metrics.stepAccumulator += steps;
    const nowMs = performance.now();
    if (nowMs - this.metrics.lastFrameStepsTimestamp > 1000) {
      this.metrics.stepsPerSecond = (this.metrics.stepAccumulator * 1000) / Math.max(1, nowMs - this.metrics.lastFrameStepsTimestamp);
      this.metrics.stepAccumulator = 0;
      this.metrics.lastFrameStepsTimestamp = nowMs;
    }
    if (!this.suppressFeed) for (const e of emitted) this.emitCivEvent(e);
    return { reached, steps, lagging: reached < target };
  }

  private applyCivIntervention(iv: Intervention, out: EmittedEvent[]) {
    const id = iv.target.civ;
    switch (iv.kind) {
      case 'advance-tech': {
        if (id === undefined) return;
        const ev = this.civs.advanceTech(id, iv.t);
        if (ev) out.push({ civ: id, event: ev });
        break;
      }
      case 'remove-civilization': {
        if (id === undefined) return;
        const ev = this.civs.remove(id, iv.t);
        if (ev) out.push({ civ: id, event: ev });
        break;
      }
      case 'add-resources': {
        for (const c of this.civsOnPlanet(iv.target)) {
          const ev = this.civs.addResources(c, iv.t, iv.params.boost ?? 0.5);
          if (ev) out.push({ civ: c, event: ev });
        }
        break;
      }
      case 'asteroid-impact': {
        for (const c of this.civsOnPlanet(iv.target)) for (const ev of this.civs.impact(c, iv.t, iv.params.severity ?? 0.5)) out.push({ civ: c, event: ev });
        break;
      }
      case 'spawn-civilization':
        // Spawn entries live in the schedule; process them now.
        this.civs.advanceTo(iv.t, out);
        break;
      default:
        break;
    }
  }

  civsOnPlanet(t: InterventionTarget): number[] {
    return this.civs.aliveIds.filter((id) => {
      const c = this.civs.civs[id];
      return c.capital.g === t.g && c.capital.s === t.s && c.capital.p === t.p;
    });
  }

  /** Incremented by every seek/jump; an in-flight async jump abandons itself when it changes. */
  private jumpToken = 0;
  /** True while an async jump is in progress (UI disables saves/interventions). */
  jumping = false;

  /** Jump (backwards or forwards) to an exact time, synchronously. */
  seek(target: number) {
    this.jumpToken++;
    target = Math.max(0, Math.min(MAX_YEARS, target));
    const prevSuppress = this.suppressFeed;
    if (target < this.civs.time) {
      const cp = this.checkpointAtOrBefore(target);
      this.civs.restore(cp.civ);
      this.ivCursor = cp.ivCursor;
      this.lastCheckpointSteps = this.civs.totalSteps;
      this.feed = this.feed.filter((e) => e.t <= target);
      this.suppressFeed = true;
      this.advanceState(target, Infinity);
      this.suppressFeed = prevSuppress;
      this.clock = makeTime(target);
      this.lagging = false;
    } else {
      this.suppressFeed = true;
      this.advanceTo(target);
      this.suppressFeed = prevSuppress;
    }
  }

  /** Long jumps without freezing the UI: time-sliced, with progress callbacks. */
  async jumpTo(target: number, onProgress?: (f: number) => void, sliceMs = 24): Promise<boolean> {
    const token = ++this.jumpToken;
    target = Math.max(0, Math.min(MAX_YEARS, target));
    const from = this.now();
    if (target < this.civs.time) {
      const cp = this.checkpointAtOrBefore(target);
      this.civs.restore(cp.civ);
      this.ivCursor = cp.ivCursor;
      this.lastCheckpointSteps = this.civs.totalSteps;
      this.clock = makeTime(cp.time);
      this.feed = this.feed.filter((e) => e.t <= target);
    }
    const startT = this.now();
    this.suppressFeed = true;
    this.jumping = true;
    try {
      while (this.now() < target) {
        // A newer jump or seek superseded this one: stop without touching state further.
        if (token !== this.jumpToken) return false;
        this.advanceTo(target, sliceMs);
        onProgress?.(target > startT ? (this.now() - startT) / (target - startT) : 1);
        if (this.now() < target) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      if (token === this.jumpToken) {
        this.suppressFeed = false;
        this.jumping = false;
      }
    }
    if (token !== this.jumpToken) return false;
    this.clock = makeTime(target);
    this.lagging = false;
    this.pushFeed({
      t: target,
      category: 'system',
      title: 'Time machine',
      body: `Jumped from year ${Math.floor(from).toLocaleString('en-US')} to year ${Math.floor(target).toLocaleString('en-US')}.`,
      severity: 'info',
    });
    return true;
  }

  /** Debug: advance to the next moment at which simulation state changes. */
  tick() {
    const next = this.civs.nextEventTime();
    const t = isFinite(next) ? next : this.now() + 1e6;
    this.advanceTo(Math.max(t, this.now() + 1e-6));
  }

  // ---- checkpoints -----------------------------------------------------------------------------

  /**
   * Checkpoints are kept sorted by time. Replays of earlier periods (after loading a save or
   * after rewinding past old checkpoints) insert new checkpoints in the middle, so subsequent
   * scrubbing over that period is cheap.
   */
  private pushCheckpoint() {
    const civ = this.civs.snapshot();
    const cp = { time: this.civs.time, ivCursor: this.ivCursor, steps: this.civs.totalSteps, civ };
    let i = this.checkpoints.length;
    while (i > 0 && this.checkpoints[i - 1].time > cp.time) i--;
    if (i > 0 && this.checkpoints[i - 1].time === cp.time) this.checkpoints[i - 1] = cp;
    else this.checkpoints.splice(i, 0, cp);
    this.lastCheckpointSteps = this.civs.totalSteps;
    if (this.checkpoints.length > CHECKPOINT_CAP) {
      // Thin the older half (keep the first checkpoint — the origin of time).
      const half = Math.floor(this.checkpoints.length / 2);
      this.checkpoints = [this.checkpoints[0], ...this.checkpoints.slice(1, half).filter((_, i) => i % 2 === 1), ...this.checkpoints.slice(half)];
    }
  }

  private lastPassedCheckpoint: Checkpoint | null = null;

  private maybeCheckpoint() {
    // Compare against the nearest checkpoint at or before *now* (not the latest overall), so
    // replays of earlier periods also lay down checkpoints. Passing an existing checkpoint
    // counts as having just taken one, so already-covered periods are not duplicated.
    const t = this.civs.time;
    const prev = this.checkpointAtOrBefore(t);
    if (prev !== this.lastPassedCheckpoint) {
      this.lastPassedCheckpoint = prev;
      this.lastCheckpointSteps = this.civs.totalSteps;
    }
    if (t <= prev.time) return;
    if (t - prev.time >= CHECKPOINT_MIN_INTERVAL || this.civs.totalSteps - this.lastCheckpointSteps >= CHECKPOINT_MAX_STEPS) {
      this.pushCheckpoint();
      this.lastPassedCheckpoint = this.checkpointAtOrBefore(t);
    }
  }

  private checkpointAtOrBefore(t: number): Checkpoint {
    // Binary search (checkpoints are sorted by time).
    let lo = 0, hi = this.checkpoints.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.checkpoints[mid].time <= t) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return this.checkpoints[best];
  }

  get checkpointCount() {
    return this.checkpoints.length;
  }

  // ---- interventions ------------------------------------------------------------------------

  /**
   * Apply a user intervention at the current time. Branches the timeline (drops any later
   * interventions), records the log entry, rebuilds derived layers and emits an event.
   */
  intervene(kind: InterventionKind, target: InterventionTarget, params: Record<string, number>, previous: string, next: string): Intervention {
    if (this.jumping) throw new Error('Cannot intervene during a time-machine jump');
    const t = this.now();
    // Bring civilization state exactly to t first.
    if (this.civs.time < t) this.advanceState(t, Infinity);
    const iv: Intervention = { id: this.nextInterventionId++, t, kind, target, params, label: INTERVENTION_LABELS[kind], previous, next };
    const dropped = branchAndAppend(this.interventions, iv);
    // Checkpoints at or after t were computed without this intervention.
    this.checkpoints = this.checkpoints.filter((cp) => cp.time < t || cp === this.checkpoints[0]);
    if (this.checkpoints.length === 0) this.pushCheckpoint();
    this.rebuildDerived();
    const civIvs = this.civStateInterventions();
    this.ivCursor = civIvs.filter((x) => x.t < t || (x.t === t && x.id < iv.id)).length;
    const emitted: EmittedEvent[] = [];
    if (CIV_STATE_KINDS.includes(kind)) {
      this.applyCivIntervention(iv, emitted);
      this.ivCursor++;
    }
    this.civs.advanceTo(t, emitted);
    for (const e of emitted) this.emitCivEvent(e);
    this.pushFeed({
      t,
      category: 'intervention',
      title: '⚠ UNIVERSE MODIFIED',
      body: `${iv.label} — ${this.describeTarget(target)}. Previous: ${previous}. New: ${next}.${dropped.length ? ` Timeline branched: ${dropped.length} future intervention(s) discarded.` : ''}`,
      ref: this.targetRef(target),
      severity: 'warning',
    });
    return iv;
  }

  describeTarget(t: InterventionTarget): string {
    if (t.civ !== undefined) return `Civilization ${this.civs.civs[t.civ]?.code ?? t.civ}`;
    if (t.p !== undefined && t.s !== undefined) return `Planet ${planetId(t.g, t.s, t.p)}`;
    if (t.s !== undefined) return `Star ${starId(t.g, t.s)}`;
    return `Galaxy ${this.universe.galaxies[t.g]?.name ?? t.g}`;
  }

  targetRef(t: InterventionTarget): EntityRef {
    if (t.civ !== undefined) return { kind: 'civ', civ: t.civ };
    if (t.p !== undefined) return { kind: 'planet', g: t.g, s: t.s, p: t.p };
    if (t.s !== undefined) return { kind: 'star', g: t.g, s: t.s };
    return { kind: 'galaxy', g: t.g };
  }

  /** Restore an intervention log (load / replay). */
  setInterventions(log: Intervention[]) {
    this.interventions = log.slice().sort((a, b) => a.t - b.t || a.id - b.id);
    this.nextInterventionId = this.interventions.reduce((m, iv) => Math.max(m, iv.id), 0) + 1;
    this.ivCursor = 0;
    this.rebuildDerived();
  }

  /**
   * Install a loaded state: the civ engine has already been deserialized at `time`.
   * Keeps the t=0 checkpoint (so rewinding before the load point replays from the Big Bang)
   * and adds one at the load point.
   */
  restoreAt(time: SimTime, feed: FeedEvent[]) {
    this.clock = cloneTime(time);
    this.civs.time = timeYears(time);
    this.feed = feed.slice();
    this.feedId = feed.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.ivCursor = this.civStateInterventions().filter((iv) => iv.t <= this.civs.time).length;
    this.checkpoints = this.checkpoints.slice(0, 1);
    this.pushCheckpoint();
    this.lagging = false;
  }

  /** Reset to the Big Bang (keeps the intervention log, which replays on the way forward). */
  resetTime() {
    const cp = this.checkpoints[0];
    if (cp) {
      this.civs.restore(cp.civ);
      this.ivCursor = cp.ivCursor;
    }
    this.clock = makeTime(0);
    this.feed = [];
  }

  // ---- event feed ------------------------------------------------------------------------------

  pushFeed(e: Omit<FeedEvent, 'id' | 'wall'>) {
    const ev: FeedEvent = { ...e, id: this.feedId++, wall: Date.now() };
    this.feed.push(ev);
    if (this.feed.length > FEED_CAPACITY) this.feed.splice(0, this.feed.length - FEED_CAPACITY);
    for (const l of this.feedListeners) l(ev);
  }

  private emitCivEvent(e: EmittedEvent) {
    const c = this.civs.civs[e.civ];
    const ev = e.event;
    const sev: Severity =
      ev.type === 'extinction' ? 'critical' : ev.type === 'war' || ev.type === 'collapse' || ev.type === 'asteroid-impact' || ev.type === 'famine' || ev.type === 'pandemic' ? 'warning' : ev.type === 'breakthrough' || ev.type === 'colonization' || ev.type === 'space' || ev.type === 'emergence' ? 'notable' : 'info';
    // The feed shows significant events only; minor ones stay in the civ's history.
    if (ev.type === 'disaster' || ev.type === 'migration' || ev.type === 'golden-age' || ev.type === 'deflection') return;
    if (ev.type === 'discovery' && techLevel(c.tech) < 3) return;
    this.pushFeed({ t: ev.t, category: 'civ', title: `Civilization ${c.code}`, body: `${c.name}: ${ev.title.charAt(0).toLowerCase() + ev.title.slice(1)}.`, ref: { kind: 'civ', civ: c.id }, severity: sev });
  }

  /** Events implied by pure-function state transitions in (t0, t1]. */
  private emitPureEvents(t0: number, t1: number) {
    const cat = this.catalog;
    if (!cat || t1 <= t0) return;
    const push = (category: FeedCategory, title: string, body: string, t: number, ref: EntityRef | undefined, severity: Severity) =>
      this.pushFeed({ category, title, body, t, ref, severity });

    // Galaxies forming.
    for (const gal of this.universe.galaxies) {
      if (gal.formation > t0 && gal.formation <= t1) push('galaxy', `Galaxy ${gal.name}`, `A ${gal.type} galaxy has assembled from merging protogalactic clouds.`, gal.formation, { kind: 'galaxy', g: gal.index }, 'notable');
    }
    // First light.
    const firstStar = cat.births[0];
    if (firstStar > t0 && firstStar <= t1) push('cosmic', 'Cosmic dawn', 'The first stars ignite. The cosmic dark ages are over.', firstStar, undefined, 'notable');

    // Stellar evolution: red giants & deaths (sampled; aggregated if numerous).
    const lo = upperBound(cat.msEndSorted, t0), hi = upperBound(cat.msEndSorted, t1);
    const giants = hi - lo;
    for (let k = lo; k < Math.min(hi, lo + 1); k++) {
      const [g, s] = cat.globalToLocal(cat.msEndOrder[k]);
      push('star', `Star ${starId(g, s)}`, `has exhausted its core hydrogen and entered the red giant phase.`, cat.msEndSorted[k], { kind: 'star', g, s }, 'info');
    }
    const dlo = upperBound(cat.deathSorted, t0), dhi = upperBound(cat.deathSorted, t1);
    let sn = 0;
    for (let k = dlo; k < dhi && sn < 2; k++) {
      const [g, s] = cat.globalToLocal(cat.deathOrder[k]);
      const m = cat.surveys[g].catalog.mass[s];
      if (m >= 8) {
        sn++;
        push('star', `Supernova ${starId(g, s)}`, `A ${m.toFixed(1)} M☉ star has exploded as a core-collapse supernova, leaving a ${m >= 25 ? 'black hole' : 'neutron star'}.`, cat.deathSorted[k], { kind: 'star', g, s }, 'notable');
      } else if (sn === 0 && k === dlo) {
        push('star', `Star ${starId(g, s)}`, `has shed its envelope as a planetary nebula; a white dwarf remains.`, cat.deathSorted[k], { kind: 'star', g, s }, 'info');
      }
    }
    const deaths = dhi - dlo;
    if (deaths + giants > 25) push('cosmic', 'Stellar evolution', `${deaths.toLocaleString('en-US')} stars died and ${giants.toLocaleString('en-US')} became red giants in this interval.`, t1, undefined, 'info');

    // Biology (unmodified planets from the catalog; modified ones from their own timelines).
    const lifeStages: [number, string, Severity][] = [
      [Stage.REPL, 'Life has emerged', 'notable'],
      [Stage.MULTI, 'Multicellular life has evolved', 'info'],
      [Stage.COMPLEX, 'Complex organisms have appeared', 'info'],
      [Stage.INTEL, 'An intelligent species has arisen', 'notable'],
    ];
    for (const [k, text, sev] of lifeStages) {
      const arr = cat.stageReach[k];
      const a = upperBound(arr, t0), b = upperBound(arr, t1);
      for (let i = a; i < Math.min(b, a + 2); i++) {
        const rec = cat.life[cat.stageOrder[k][i]];
        if (this.overrides.modifiedPlanets.has(planetKey(rec.g, rec.s, rec.p))) continue;
        push('life', `Planet ${planetId(rec.g, rec.s, rec.p)}`, `${text}.`, arr[i], { kind: 'planet', g: rec.g, s: rec.s, p: rec.p }, sev);
      }
      if (b - a > 2 && k === Stage.REPL) push('life', 'Biosphere census', `${(b - a).toLocaleString('en-US')} worlds developed life in this interval.`, t1, undefined, 'info');
    }
    for (const key of this.overrides.modifiedPlanets) {
      const p = key % 32, sk = (key - p) / 32;
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      const tl = this.queries.lifeTimeline(g, s, p);
      if (!tl) continue;
      for (const e of tl.events) {
        if (e.t <= t0 || e.t > t1) continue;
        if (e.kind === 'stage' && e.stage >= 2) push('life', `Planet ${planetId(g, s, p)}`, `${STAGE_NAMES[e.stage]} reached.`, e.t, { kind: 'planet', g, s, p }, 'notable');
        if (e.kind === 'sterilized' || e.kind === 'impact') push('life', `Planet ${planetId(g, s, p)}`, e.kind === 'impact' && e.stage > 0 ? 'has experienced a mass extinction.' : 'has been sterilized; its biosphere is gone.', e.t, { kind: 'planet', g, s, p }, 'critical');
      }
    }
  }

  // ---- statistics -----------------------------------------------------------------------------

  /** Universe statistics at time t — every number derived from simulation state. */
  stats(t = this.now()): UniverseStats {
    const cat = this.catalog;
    const civAlive = (id: number) => {
      const c = this.civs.civs[id];
      return c.born <= t && (c.endedAt === null || c.endedAt > t);
    };
    const empty: UniverseStats = { t, galaxies: 0, stars: 0, remnants: 0, planets: 0, moonsEstimate: 0, habitable: 0, lifeBearing: 0, complexLife: 0, intelligent: 0, civilizations: 0, spacefaring: 0, interstellar: 0, population: 0, colonies: 0, civsEver: 0, extinctCivs: 0 };
    if (!cat) return { ...empty, galaxies: this.universe.galaxies.filter((g) => g.formation <= t).length };

    let stars = cat.starsShining(t);
    let planets = cat.planetsFormed(t);
    let habitable = cat.habitable(t);
    let life = cat.atStage(Stage.REPL, t);
    let complex = cat.atStage(Stage.COMPLEX, t);
    let intelligent = cat.atStage(Stage.INTEL, t);
    const ov = this.overrides;

    // Corrections for created/destroyed stars and modified planets.
    for (const cs of ov.createdStars) {
      const core = this.queries.starCore(cs.g, cs.s);
      if (core && core.birth <= t && t < core.death && !(ov.destroyedStars.get(starKey(cs.g, cs.s))! <= t)) stars++;
      const sys = this.queries.getSystem(cs.g, cs.s);
      if (sys && cs.birth + PLANET_FORMATION_DELAY <= t) planets += sys.planets.length;
    }
    for (const [sk, td] of ov.destroyedStars) {
      if (td > t) continue;
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      if (this.queries.isCreatedStar(g, s)) {
        // created then destroyed: counted above only while alive
        continue;
      }
      const c = cat.surveys[g].catalog;
      if (c.birth[s] <= t && t < c.death[s]) stars--;
    }
    const affected = new Set<number>(ov.modifiedPlanets);
    for (const sk of ov.modifiedStars) {
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      this.queries.getSystem(g, s)?.planets.forEach((p) => affected.add(planetKey(g, s, p.index)));
    }
    for (const cs of ov.createdStars) this.queries.getSystem(cs.g, cs.s)?.planets.forEach((p) => affected.add(planetKey(cs.g, cs.s, p.index)));
    for (const key of affected) {
      const p = key % 32, sk = (key - p) / 32;
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      const created = this.queries.isCreatedStar(g, s);
      // Remove the survey's (base) contribution…
      if (!created) {
        const hab = cat.surveys[g].habitable;
        for (let r = 0; r < hab.length; r += HAB_COLS) if (hab[r] === s && hab[r + 1] === p && hab[r + 2] <= t && t < hab[r + 3]) habitable--;
        const rec = cat.lifeByKey.get(key);
        if (rec) {
          if (rec.t[Stage.REPL] <= t && t < rec.end) life--;
          if (rec.t[Stage.COMPLEX] <= t && t < rec.end) complex--;
          if (rec.t[Stage.INTEL] <= t && t < rec.end) intelligent--;
        }
      }
      // …and add the actual one.
      const d = this.queries.planetAt(g, s, p, t);
      if (!d || d.planet.formation > t) continue;
      if (d.habitability >= HABITABLE_THRESHOLD && this.queries.starAlive(g, s, t)) habitable++;
      if (d.life.stage >= Stage.REPL) life++;
      if (d.life.stage >= Stage.COMPLEX) complex++;
      if (d.life.stage >= Stage.INTEL) intelligent++;
    }
    // Species lost with their civilizations.
    for (const x of this.civs.extinctSpecies) {
      if (x.t > t) continue;
      const p = x.key % 32, sk = (x.key - p) / 32;
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      const d = affected.has(x.key) ? this.queries.planetAt(g, s, p, t)?.life.stage ?? 0 : (() => {
        const rec = cat.lifeByKey.get(x.key);
        return rec && rec.t[Stage.INTEL] <= t && t < rec.end ? Stage.INTEL : 0;
      })();
      if (d >= Stage.INTEL) intelligent--;
    }

    let civilizations = 0, spacefaring = 0, interstellar = 0, population = 0, colonies = 0, extinct = 0;
    for (const c of this.civs.civs) {
      if (c.born > t) continue;
      if (c.endedAt !== null && c.endedAt <= t) {
        extinct++;
        continue;
      }
      if (!civAlive(c.id)) continue;
      civilizations++;
      // Detailed figures are only exact at the engine's current time.
      if (Math.abs(t - this.civs.time) < 1e-3 || t >= this.civs.time) {
        const L = techLevel(c.tech);
        if (L >= 4) spacefaring++;
        if (L >= 6) interstellar++;
        population += totalPopulation(c);
        colonies += c.colonies.length;
      }
    }
    return {
      t,
      galaxies: cat.galaxiesFormed(t),
      stars: Math.max(0, stars),
      remnants: cat.remnants(t),
      planets,
      moonsEstimate: Math.round(planets * 1.6),
      habitable: Math.max(0, habitable),
      lifeBearing: Math.max(0, life),
      complexLife: Math.max(0, complex),
      intelligent: Math.max(0, intelligent),
      civilizations,
      spacefaring,
      interstellar,
      population,
      colonies,
      civsEver: this.civs.civs.filter((c) => c.born <= t).length,
      extinctCivs: extinct,
    };
  }

  /** Cheap time series for charts (pure-function parts only + civ registry). */
  statsSeries(samples = 120, until = this.now()): { t: number; stars: number; life: number; civs: number; habitable: number }[] {
    const cat = this.catalog;
    if (!cat || until <= 0) return [];
    const out = [];
    for (let i = 1; i <= samples; i++) {
      const t = (until * i) / samples;
      let civs = 0;
      for (const c of this.civs.civs) if (c.born <= t && (c.endedAt === null || c.endedAt > t)) civs++;
      out.push({ t, stars: cat.starsShining(t), life: cat.atStage(Stage.REPL, t), habitable: cat.habitable(t), civs });
    }
    return out;
  }

  get stepsTotal() {
    return this.civs.totalSteps;
  }

  techName(level: number) {
    return TECH_NAMES[level];
  }

  pendingEventCount(windowYears = 1e6): number {
    const t = this.now();
    const ivs = this.interventions.filter((iv) => iv.t > t).length;
    const transits = this.civs.aliveIds.reduce((s, id) => s + this.civs.civs[id].transits.length, 0);
    const cat = this.catalog;
    const stellar = cat ? countInRange(cat.deathSorted, t, t + windowYears) + countInRange(cat.msEndSorted, t, t + windowYears) : 0;
    return ivs + transits + this.civs.pendingSpawnsWithin(t, t + windowYears) + stellar;
  }
}
