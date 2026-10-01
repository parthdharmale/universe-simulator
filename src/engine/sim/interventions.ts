import { hash32 } from '../core/rng';
import { PlanetEnv } from '../gen/planets';
import { LifeImpulse } from '../life/life';
import { planetKey, starKey } from '../survey/catalog';

/**
 * User interventions are event-sourced. The intervention log is part of the universe's
 * definition (alongside the seed): every derived quantity is a function of
 * (seed, log, time). This makes save files tiny, replays exact, and time travel coherent:
 *  - jumping back before an intervention and forward again re-applies it at its timestamp;
 *  - making a *new* intervention while in the past branches the timeline — later
 *    interventions are discarded (they belonged to the abandoned future).
 */

export type InterventionKind =
  | 'create-star'
  | 'destroy-star'
  | 'set-atmosphere'
  | 'set-water'
  | 'set-temperature'
  | 'accelerate-evolution'
  | 'add-resources'
  | 'asteroid-impact'
  | 'advance-tech'
  | 'spawn-civilization'
  | 'remove-civilization';

export interface InterventionTarget {
  g: number;
  s?: number;
  p?: number;
  civ?: number;
}

export interface Intervention {
  id: number;
  t: number;
  kind: InterventionKind;
  target: InterventionTarget;
  params: Record<string, number>;
  /** Human-readable before/after, recorded at application time for the "UNIVERSE MODIFIED" notice. */
  label: string;
  previous: string;
  next: string;
}

export const INTERVENTION_LABELS: Record<InterventionKind, string> = {
  'create-star': 'Star created',
  'destroy-star': 'Star destroyed',
  'set-atmosphere': 'Atmospheric composition changed',
  'set-water': 'Surface water changed',
  'set-temperature': 'Planetary temperature forced',
  'accelerate-evolution': 'Evolution accelerated',
  'add-resources': 'Resources introduced',
  'asteroid-impact': 'Asteroid impact triggered',
  'advance-tech': 'Civilization technology advanced',
  'spawn-civilization': 'Civilization spawned',
  'remove-civilization': 'Civilization removed',
};

/** Interventions that act on civilization *state* (applied by the civ engine at their timestamp). */
export const CIV_STATE_KINDS: InterventionKind[] = ['advance-tech', 'remove-civilization', 'spawn-civilization', 'add-resources', 'asteroid-impact'];

export interface CreatedStar {
  g: number;
  s: number;
  seed: number;
  mass: number;
  feh: number;
  birth: number;
  x: number;
  y: number;
  z: number;
  interventionId: number;
}

export interface EnvPatch {
  t: number;
  patch: Partial<PlanetEnv>;
}

/** Derived, query-friendly view of the intervention log for the pure-function layers. */
export class OverrideLayer {
  version = 0;
  destroyedStars = new Map<number, number>();
  createdStars: CreatedStar[] = [];
  createdByGalaxy = new Map<number, CreatedStar[]>();
  envPatches = new Map<number, EnvPatch[]>();
  lifeImpulses = new Map<number, LifeImpulse[]>();
  /** Planet keys whose biology/climate deviate from the survey (need individual evaluation). */
  modifiedPlanets = new Set<number>();
  /** Star keys whose planets are all affected (destroyed stars). */
  modifiedStars = new Set<number>();

  rebuild(log: readonly Intervention[], catalogCounts: (g: number) => number) {
    this.version++;
    this.destroyedStars.clear();
    this.createdStars = [];
    this.createdByGalaxy.clear();
    this.envPatches.clear();
    this.lifeImpulses.clear();
    this.modifiedPlanets.clear();
    this.modifiedStars.clear();
    for (const iv of log) {
      const { g, s, p } = iv.target;
      switch (iv.kind) {
        case 'create-star': {
          const list = this.createdByGalaxy.get(g) ?? [];
          const cs: CreatedStar = {
            g,
            s: catalogCounts(g) + list.length,
            seed: hash32(0x57a4, iv.id, Math.floor(iv.t)),
            mass: iv.params.mass,
            feh: iv.params.feh ?? 0,
            birth: iv.t,
            x: iv.params.x,
            y: iv.params.y,
            z: iv.params.z,
            interventionId: iv.id,
          };
          list.push(cs);
          this.createdByGalaxy.set(g, list);
          this.createdStars.push(cs);
          break;
        }
        case 'destroy-star':
          if (s !== undefined && !this.destroyedStars.has(starKey(g, s))) {
            this.destroyedStars.set(starKey(g, s), iv.t);
            this.modifiedStars.add(starKey(g, s));
          }
          break;
        case 'set-atmosphere':
        case 'set-water':
        case 'set-temperature':
        case 'add-resources': {
          if (s === undefined || p === undefined) break;
          const key = planetKey(g, s, p);
          const patch: Partial<PlanetEnv> = {};
          if (iv.kind === 'set-atmosphere') {
            patch.pN2 = iv.params.pN2;
            patch.pCO2 = iv.params.pCO2;
            patch.co2Locked = true;
          } else if (iv.kind === 'set-water') patch.water = iv.params.water;
          else if (iv.kind === 'set-temperature') patch.forcing = iv.params.forcing;
          else patch.resourceBoost = iv.params.boost;
          const list = this.envPatches.get(key) ?? [];
          list.push({ t: iv.t, patch });
          this.envPatches.set(key, list);
          if (iv.kind !== 'add-resources') this.modifiedPlanets.add(key);
          break;
        }
        case 'accelerate-evolution':
        case 'asteroid-impact': {
          if (s === undefined || p === undefined) break;
          const key = planetKey(g, s, p);
          const list = this.lifeImpulses.get(key) ?? [];
          list.push(iv.kind === 'accelerate-evolution' ? { t: iv.t, kind: 'boost', amount: 1 } : { t: iv.t, kind: 'impact', amount: iv.params.severity ?? 0.5 });
          this.lifeImpulses.set(key, list);
          this.modifiedPlanets.add(key);
          break;
        }
        default:
          break;
      }
    }
  }

  createdStar(g: number, s: number): CreatedStar | undefined {
    return this.createdByGalaxy.get(g)?.find((c) => c.s === s);
  }
}

/** Timeline-branching insert: drops every intervention strictly after `t`. Returns the dropped ones. */
export function branchAndAppend(log: Intervention[], iv: Intervention): Intervention[] {
  const dropped = log.filter((x) => x.t > iv.t);
  const kept = log.filter((x) => x.t <= iv.t);
  log.length = 0;
  log.push(...kept, iv);
  return dropped;
}
