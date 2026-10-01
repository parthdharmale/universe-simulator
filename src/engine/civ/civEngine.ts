import { hash32, mix32 } from '../core/rng';
import { MAX_TECH, CivEvent, CivState, CivWorld, SpawnSpec, applyImpactTo, cloneCiv, createCivilization, stepCivilization, stepLength, techLevel, totalPopulation } from './civilization';

/**
 * CivEngine owns every civilization that has ever existed.
 *
 * Determinism contract:
 *  - Civilizations are independent: a civ's evolution depends only on its own state, its
 *    own RNG stream and the (pure) world environment. So stepping order between civs is
 *    irrelevant, and advancing to T in one call or many calls yields identical state.
 *  - Spawns are processed in a total order (time, then key), so civ ids are reproducible.
 *  - Histories are append-only; snapshots record lengths instead of copying them.
 */

/** Beyond this, routine events only update counters. */
const HISTORY_SOFT_CAP = 400;
/** Beyond this, only defining events are kept (hard memory bound for Gyr-old civilizations). */
const HISTORY_HARD_CAP = 1200;
const MINOR_EVENTS = new Set(['disaster', 'golden-age', 'migration', 'deflection', 'discovery', 'pandemic', 'famine', 'war']);
const DEFINING_EVENTS = new Set(['emergence', 'breakthrough', 'extinction', 'relocation', 'intervention']);

/** Whether an event is stored in history given its current length (a pure function of state). */
export function keepInHistory(len: number, type: string): boolean {
  if (len >= HISTORY_HARD_CAP) return DEFINING_EVENTS.has(type);
  if (len >= HISTORY_SOFT_CAP) return !MINOR_EVENTS.has(type);
  return true;
}

export interface SpawnEntry extends SpawnSpec {
  key: string;
}

export interface CivSnapshot {
  time: number;
  nextId: number;
  spawned: string[];
  alive: CivState[];
  historyLens: number[];
  extinctSpecies: { key: number; t: number }[];
}

export interface CivEngineSerialized {
  time: number;
  civs: CivState[];
  histories: CivEvent[][];
  spawned: string[];
  extinctSpecies: { key: number; t: number }[];
}

export interface EmittedEvent {
  civ: number;
  event: CivEvent;
}

export class CivEngine {
  time = 0;
  civs: CivState[] = [];
  histories: CivEvent[][] = [];
  aliveIds: number[] = [];
  schedule: SpawnEntry[] = [];
  spawned = new Set<string>();
  extinctSpecies: { key: number; t: number }[] = [];
  /** Steps executed since construction (for TPS metrics). */
  totalSteps = 0;

  constructor(private world: CivWorld) {}

  setWorld(world: CivWorld) {
    this.world = world;
  }

  setSchedule(entries: SpawnEntry[]) {
    this.schedule = entries.slice().sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Rough work estimate (steps per simulated year) for adaptive chunking. */
  stepsPerYear(): number {
    let s = 0;
    for (const id of this.aliveIds) s += 1 / stepLength(this.civs[id]);
    return s;
  }

  /** Next time anything happens (for single-tick debugging). */
  nextEventTime(): number {
    let t = Infinity;
    for (const id of this.aliveIds) {
      const c = this.civs[id];
      t = Math.min(t, c.time + stepLength(c));
    }
    for (const e of this.schedule) {
      if (!this.spawned.has(e.key)) {
        t = Math.min(t, e.t);
        break;
      }
    }
    return t;
  }

  /** Time of the first not-yet-processed spawn strictly after t (Infinity if none). */
  nextSpawnAfter(t: number): number {
    for (const e of this.schedule) if (e.t > t && !this.spawned.has(e.key)) return e.t;
    return Infinity;
  }

  pendingSpawnsWithin(t0: number, t1: number): number {
    let n = 0;
    for (const e of this.schedule) {
      if (e.t > t1) break;
      if (e.t > t0 && !this.spawned.has(e.key)) n++;
    }
    return n;
  }

  private spawnDue(T: number, out: EmittedEvent[]) {
    for (const e of this.schedule) {
      if (e.t > T) break;
      if (this.spawned.has(e.key)) continue;
      this.spawned.add(e.key);
      const env = this.world.home(e.g, e.s, e.p, e.t);
      // A natural spawn is void if the world was sterilised in the meantime.
      if (e.source === 'natural' && (env.habitability <= 0.02 || !env.starAlive)) continue;
      const { civ, event } = createCivilization({ ...e, id: this.civs.length }, env);
      this.civs.push(civ);
      this.histories.push([event]);
      this.aliveIds.push(civ.id);
      out.push({ civ: civ.id, event });
    }
  }

  /**
   * Advance every civilization to time T (each takes all of its steps that end ≤ T).
   * Returns emitted events sorted by (time, civ id). `budgetSteps` bounds work; if
   * exceeded, the engine stops at a consistent intermediate time and returns `reached < T`.
   */
  advanceTo(T: number, out: EmittedEvent[] = []): EmittedEvent[] {
    if (T < this.time) throw new Error('CivEngine cannot advance backwards; restore a snapshot instead');
    this.spawnDue(T, out);
    let anyDied = false;
    for (const id of this.aliveIds) {
      const c = this.civs[id];
      while (c.alive && c.time + stepLength(c) <= T) {
        const evs = stepCivilization(c, this.world);
        this.totalSteps++;
        const hist = this.histories[id];
        for (const ev of evs) {
          // Bounded memory: once a history is long, routine events only update counters.
          // (Depends only on deterministic state, so replays make the same choice.)
          if (keepInHistory(hist.length, ev.type)) hist.push(ev);
          out.push({ civ: id, event: ev });
          if (ev.type === 'extinction') this.extinctSpecies.push({ key: this.speciesKey(c), t: ev.t });
        }
        if (!c.alive) anyDied = true;
      }
    }
    if (anyDied) this.aliveIds = this.aliveIds.filter((id) => this.civs[id].alive);
    this.time = T;
    out.sort((a, b) => a.event.t - b.event.t || a.civ - b.civ);
    return out;
  }

  speciesKey(c: CivState) {
    return (c.g * 1_000_000 + c.s) * 32 + c.p;
  }

  // ---- interventions -------------------------------------------------------------------------

  advanceTech(id: number, t: number): CivEvent | null {
    const c = this.civs[id];
    if (!c || !c.alive) return null;
    const before = c.tech;
    c.tech = Math.min(MAX_TECH, Math.floor(c.tech) + 1 + (c.tech % 1) * 0.5);
    const key = ['primitive', 'agriculture', 'industry', 'digital', 'spacefaring', 'interplanetary', 'interstellar'][techLevel(c.tech)];
    if (c.milestones[key] === undefined) c.milestones[key] = t;
    c.levelSince = t;
    const ev: CivEvent = {
      t,
      type: 'intervention',
      title: 'Technology uplift (intervention)',
      detail: `An external intervention advances the ${c.name} from level ${techLevel(before)} to level ${techLevel(c.tech)}.`,
      effects: { tech: [before, c.tech] },
    };
    this.histories[id].push(ev);
    return ev;
  }

  addResources(id: number, t: number, boost: number): CivEvent | null {
    const c = this.civs[id];
    if (!c || !c.alive) return null;
    const before = c.resources;
    c.resources = Math.min(c.resourcesMax * 3, c.resources + c.resourcesMax * boost);
    c.depleted = false;
    const ev: CivEvent = { t, type: 'intervention', title: 'Resources introduced (intervention)', detail: `Accessible resource stock increased by ${(boost * 100).toFixed(0)}% of the original endowment.`, effects: { resources: [before, c.resources] } };
    this.histories[id].push(ev);
    return ev;
  }

  impact(id: number, t: number, severity: number): CivEvent[] {
    const c = this.civs[id];
    if (!c || !c.alive) return [];
    const evs = applyImpactTo(c, t, severity);
    for (const ev of evs) {
      this.histories[id].push(ev);
      if (ev.type === 'extinction') this.extinctSpecies.push({ key: this.speciesKey(c), t });
    }
    if (!c.alive) this.aliveIds = this.aliveIds.filter((x) => x !== id);
    return evs;
  }

  remove(id: number, t: number): CivEvent | null {
    const c = this.civs[id];
    if (!c || !c.alive) return null;
    const before = totalPopulation(c);
    c.alive = false;
    c.endedAt = t;
    c.endCause = 'Removed by intervention';
    c.population = 0;
    for (const k of c.colonies) k.population = 0;
    c.transits = [];
    this.aliveIds = this.aliveIds.filter((x) => x !== id);
    this.extinctSpecies.push({ key: this.speciesKey(c), t });
    const ev: CivEvent = { t, type: 'extinction', title: 'Removed by intervention', detail: 'The civilization was erased by an external intervention.', effects: { population: [before, 0] } };
    this.histories[id].push(ev);
    return ev;
  }

  // ---- snapshots ----------------------------------------------------------------------------

  snapshot(): CivSnapshot {
    return {
      time: this.time,
      nextId: this.civs.length,
      spawned: [...this.spawned],
      alive: this.aliveIds.map((id) => cloneCiv(this.civs[id])),
      historyLens: this.histories.map((h) => h.length),
      extinctSpecies: this.extinctSpecies.slice(),
    };
  }

  restore(s: CivSnapshot) {
    this.civs.length = s.nextId;
    this.histories.length = s.nextId;
    for (let id = 0; id < s.nextId; id++) this.histories[id].length = s.historyLens[id];
    for (const c of s.alive) this.civs[c.id] = cloneCiv(c);
    this.aliveIds = s.alive.map((c) => c.id);
    this.spawned = new Set(s.spawned);
    this.extinctSpecies = s.extinctSpecies.slice();
    this.time = s.time;
  }

  serialize(): CivEngineSerialized {
    return {
      time: this.time,
      civs: this.civs.map(cloneCiv),
      histories: this.histories.map((h) => h.slice()),
      spawned: [...this.spawned],
      extinctSpecies: this.extinctSpecies.slice(),
    };
  }

  deserialize(d: CivEngineSerialized) {
    this.time = d.time;
    this.civs = d.civs.map(cloneCiv);
    this.histories = d.histories.map((h) => h.slice());
    this.aliveIds = this.civs.filter((c) => c.alive).map((c) => c.id);
    this.spawned = new Set(d.spawned);
    this.extinctSpecies = d.extinctSpecies.slice();
  }

  /**
   * Exact state hash: folds the IEEE-754 bit patterns of every numeric field, so two
   * engines hash equal iff their states are bit-identical.
   */
  stateHash(): number {
    const f64 = new Float64Array(1);
    const u32 = new Uint32Array(f64.buffer);
    let h = 0x2545f491;
    const num = (x: number) => {
      f64[0] = x;
      h = mix32(h ^ u32[0]);
      h = mix32(h ^ u32[1]);
    };
    num(this.time);
    num(this.civs.length);
    for (const c of this.civs) {
      num(c.id);
      num(c.alive ? 1 : 0);
      num(c.time);
      num(c.population);
      num(c.tech);
      num(c.stability);
      num(c.resources);
      num(c.territory);
      num(c.economy);
      num(c.colonies.length);
      for (const k of c.colonies) {
        num(k.s);
        num(k.population);
      }
      num(c.transits.length);
      for (const r of c.rng) h = mix32(h ^ r);
      num(this.histories[c.id].length);
    }
    return hash32(h, this.extinctSpecies.length);
  }
}
