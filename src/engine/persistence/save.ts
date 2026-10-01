import { SimTime } from '../core/time';
import { UniverseConfig } from '../gen/galaxy';
import { CivEngineSerialized } from '../civ/civEngine';
import { Intervention, InterventionKind, INTERVENTION_LABELS } from '../sim/interventions';
import { Simulation } from '../sim/simulation';
import { EntityRef, FeedEvent } from '../sim/types';

/**
 * Persistence.
 *
 * The universe itself is never stored: stars, planets and biospheres are regenerated from
 * the seed. A save contains only what cannot be regenerated cheaply:
 *   - config (seed, galaxy count, density) and the simulation time,
 *   - the intervention log (the only source of divergence from the pristine universe),
 *   - a civilization-engine snapshot (fast load without replaying history),
 *   - recent feed events (UI continuity), the camera focus,
 *   - a state hash so a load can be *verified* by deterministic replay.
 * A typical save is tens of kilobytes.
 */

export const SAVE_FORMAT = 'universe-simulator-save';
export const SAVE_VERSION = 1;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  savedAt: string;
  name: string;
  config: UniverseConfig;
  time: SimTime;
  speed: number;
  interventions: Intervention[];
  civ: CivEngineSerialized;
  feed: FeedEvent[];
  focus: EntityRef | null;
  stateHash: number;
}

export function createSave(sim: Simulation, name: string, focus: EntityRef | null): SaveFile {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    name,
    config: { ...sim.config },
    time: { ...sim.clock },
    speed: sim.speed,
    interventions: sim.interventions.map((iv) => ({ ...iv, target: { ...iv.target }, params: { ...iv.params } })),
    civ: sim.civs.serialize(),
    feed: sim.feed.slice(-120),
    focus,
    stateHash: sim.civs.stateHash(),
  };
}

export class SaveValidationError extends Error {}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const KINDS = new Set(Object.keys(INTERVENTION_LABELS));

/** Structural validation of untrusted input (imported files, localStorage). */
export function validateSave(data: unknown): SaveFile {
  const fail = (msg: string): never => {
    throw new SaveValidationError(msg);
  };
  if (!data || typeof data !== 'object') fail('Not a save file (expected a JSON object).');
  const d = data as Record<string, unknown>;
  if (d.format !== SAVE_FORMAT) fail('Unrecognised file format.');
  if (!isNum(d.version) || d.version > SAVE_VERSION) fail(`Unsupported save version ${String(d.version)} (this build reads ≤ ${SAVE_VERSION}).`);
  const cfg = d.config as Record<string, unknown> | undefined;
  if (!cfg || !isNum(cfg.seed) || !isNum(cfg.galaxyCount) || !isNum(cfg.starDensity)) fail('Missing or invalid universe configuration.');
  if ((cfg!.galaxyCount as number) < 1 || (cfg!.galaxyCount as number) > 1000) fail('Galaxy count out of range.');
  if ((cfg!.starDensity as number) <= 0 || (cfg!.starDensity as number) > 8) fail('Star density out of range.');
  const time = d.time as Record<string, unknown> | undefined;
  if (!time || !isNum(time.whole) || !isNum(time.frac) || time.frac < 0 || time.frac >= 1 || time.whole < 0) fail('Invalid simulation time.');
  if (!Array.isArray(d.interventions)) fail('Invalid intervention log.');
  for (const iv of d.interventions as unknown[]) {
    const x = iv as Record<string, unknown>;
    if (!isNum(x.id) || !isNum(x.t) || typeof x.kind !== 'string' || !KINDS.has(x.kind)) fail('Corrupt intervention entry.');
    const tg = x.target as Record<string, unknown> | undefined;
    if (!tg || !isNum(tg.g)) fail('Corrupt intervention target.');
    if (!x.params || typeof x.params !== 'object') fail('Corrupt intervention parameters.');
    for (const v of Object.values(x.params as object)) if (!isNum(v)) fail('Non-numeric intervention parameter.');
  }
  const civ = d.civ as Record<string, unknown> | undefined;
  if (!civ || !Array.isArray(civ.civs) || !Array.isArray(civ.histories) || civ.civs.length !== civ.histories.length || !isNum(civ.time)) fail('Corrupt civilization snapshot.');
  for (const c of civ!.civs as unknown[]) {
    const x = c as Record<string, unknown>;
    if (!isNum(x.id) || !isNum(x.population) || !isNum(x.tech) || !Array.isArray(x.rng) || x.rng.length !== 4) fail('Corrupt civilization record.');
  }
  return {
    format: SAVE_FORMAT,
    version: d.version as number,
    savedAt: String(d.savedAt ?? ''),
    name: String(d.name ?? 'Imported universe'),
    config: { seed: cfg!.seed as number, galaxyCount: cfg!.galaxyCount as number, starDensity: cfg!.starDensity as number },
    time: { whole: time!.whole as number, frac: time!.frac as number },
    speed: isNum(d.speed) ? d.speed : 1e14,
    interventions: (d.interventions as Intervention[]).map((iv) => ({
      ...iv,
      kind: iv.kind as InterventionKind,
      label: String(iv.label ?? INTERVENTION_LABELS[iv.kind as InterventionKind]),
      previous: String(iv.previous ?? ''),
      next: String(iv.next ?? ''),
    })),
    civ: civ as unknown as CivEngineSerialized,
    feed: Array.isArray(d.feed) ? (d.feed as FeedEvent[]).slice(-120) : [],
    focus: (d.focus as EntityRef) ?? null,
    stateHash: isNum(d.stateHash) ? d.stateHash : 0,
  };
}

/**
 * Restore a save into a simulation that was constructed with the same config and has its
 * survey attached. Fast path: install the snapshot directly.
 */
export function applySave(sim: Simulation, save: SaveFile) {
  if (sim.config.seed !== save.config.seed || sim.config.galaxyCount !== save.config.galaxyCount || sim.config.starDensity !== save.config.starDensity)
    throw new SaveValidationError('Save does not match this universe configuration.');
  validateTargets(sim, save);
  sim.setInterventions(save.interventions);
  sim.civs.deserialize(save.civ);
  // Everything up to the saved time is already applied in the snapshot.
  sim.restoreAt(save.time, save.feed);
  sim.speed = save.speed;
}

/**
 * Semantic validation that needs the regenerated universe: every intervention must point at
 * an object that exists (structural validation cannot know catalog sizes). A corrupt or
 * hostile file is rejected instead of crashing the engine later.
 */
export function validateTargets(sim: Simulation, save: SaveFile) {
  const G = sim.universe.galaxies.length;
  const created = new Map<number, number>();
  const civCount = save.civ.civs.length;
  for (const iv of save.interventions.slice().sort((a, b) => a.t - b.t || a.id - b.id)) {
    const { g, s, p, civ } = iv.target;
    if (!Number.isInteger(g) || g < 0 || g >= G) throw new SaveValidationError(`Intervention ${iv.id} targets a galaxy that does not exist.`);
    const stars = (sim.catalog?.surveys[g].catalog.count ?? 0) + (created.get(g) ?? 0);
    if (s !== undefined && (!Number.isInteger(s) || s < 0 || s >= stars)) throw new SaveValidationError(`Intervention ${iv.id} targets a star that does not exist.`);
    if (p !== undefined && (!Number.isInteger(p) || p < 0 || p > 31)) throw new SaveValidationError(`Intervention ${iv.id} targets an invalid planet.`);
    if (civ !== undefined && (!Number.isInteger(civ) || civ < 0 || civ >= civCount)) throw new SaveValidationError(`Intervention ${iv.id} targets an unknown civilization.`);
    if (iv.t < 0 || iv.t > save.time.whole + 1) throw new SaveValidationError(`Intervention ${iv.id} lies outside the saved timeline.`);
    if (iv.kind === 'create-star') {
      const m = iv.params.mass;
      if (!(m >= 0.08 && m <= 150)) throw new SaveValidationError(`Intervention ${iv.id} creates a star of impossible mass.`);
      created.set(g, (created.get(g) ?? 0) + 1);
    }
  }
}

/**
 * Verification path: rebuild the civilization state purely from (seed, interventions, time)
 * and compare its hash with the saved one. Used by tests and the "verify" button.
 */
export function replayHash(sim: Simulation, save: SaveFile): number {
  sim.setInterventions(save.interventions);
  sim.seek(save.time.whole + save.time.frac);
  return sim.civs.stateHash();
}

export const LOCAL_PREFIX = 'universe-sim:save:';

export function listLocalSaves(): { key: string; name: string; savedAt: string; seed: number; years: number }[] {
  const out: { key: string; name: string; savedAt: string; seed: number; years: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LOCAL_PREFIX)) continue;
      try {
        const s = JSON.parse(localStorage.getItem(key) ?? '');
        out.push({ key, name: s.name, savedAt: s.savedAt, seed: s.config?.seed, years: (s.time?.whole ?? 0) + (s.time?.frac ?? 0) });
      } catch {
        /* skip corrupt entries */
      }
    }
  } catch {
    /* storage unavailable */
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function writeLocalSave(save: SaveFile): string {
  const key = `${LOCAL_PREFIX}${save.name.replace(/[^\w\- ]/g, '').slice(0, 40) || 'universe'}`;
  localStorage.setItem(key, JSON.stringify(save));
  return key;
}

export function readLocalSave(key: string): SaveFile {
  const raw = localStorage.getItem(key);
  if (!raw) throw new SaveValidationError('Save not found.');
  return validateSave(JSON.parse(raw));
}
