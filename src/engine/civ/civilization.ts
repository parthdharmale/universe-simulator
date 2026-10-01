import { Rng, RngState, hash32 } from '../core/rng';
import { clamp, clamp01 } from '../core/math';
import { civCode, civName, speciesName } from '../core/names';

/**
 * Civilization model.
 *
 * A civilization is a small deterministic state machine advanced in discrete steps.
 *  - Its RNG state is part of its state (snapshot/restore resumes the exact stream).
 *  - The step length depends only on its own state (tech level / era age), never on the
 *    frame rate, so advancing in one jump or a thousand small increments is identical.
 *  - Continuous dynamics use *exact* solutions (logistic growth, exponential relaxation),
 *    so even 1-Myr steps for mature interstellar civilizations are numerically stable.
 *  - Stochastic events are Poisson processes whose rates are functions of the state;
 *    every event mutates state and records before/after values.
 */

export const TECH_NAMES = ['Primitive', 'Agricultural', 'Industrial', 'Digital', 'Spacefaring', 'Interplanetary', 'Interstellar'];
export const MAX_TECH = 6.999;

export type CivEventType =
  | 'emergence'
  | 'discovery'
  | 'breakthrough'
  | 'war'
  | 'famine'
  | 'pandemic'
  | 'migration'
  | 'resource-depletion'
  | 'collapse'
  | 'colonization'
  | 'asteroid-impact'
  | 'disaster'
  | 'extinction'
  | 'space'
  | 'intervention'
  | 'golden-age'
  | 'deflection'
  | 'relocation'
  | 'colony-lost';

export interface CivEvent {
  t: number;
  type: CivEventType;
  title: string;
  detail: string;
  /** Field → [before, after]. */
  effects: Record<string, [number, number]>;
}

export interface Colony {
  kind: 'orbital' | 'moon' | 'planet' | 'star';
  g: number;
  s: number;
  p: number;
  m: number;
  founded: number;
  population: number;
  capacity: number;
}

export interface Transit {
  g: number;
  s: number;
  fromS: number;
  launched: number;
  arrival: number;
}

export interface CivCounters {
  wars: number;
  famines: number;
  pandemics: number;
  migrations: number;
  collapses: number;
  discoveries: number;
  breakthroughs: number;
  impacts: number;
  disasters: number;
  colonies: number;
  depletions: number;
}

export interface CivState {
  id: number;
  code: string;
  name: string;
  species: string;
  seed: number;
  g: number;
  s: number;
  p: number;
  /** Current capital (moves if the home world is lost). p = -1 → artificial habitat. */
  capital: { g: number; s: number; p: number };
  born: number;
  time: number;
  /** Time the current technology level was entered (drives adaptive step length). */
  levelSince: number;
  alive: boolean;
  endedAt: number | null;
  endCause: string | null;
  rng: RngState;
  population: number;
  intelligence: number;
  tech: number;
  stability: number;
  culture: { cohesion: number; militarism: number; curiosity: number; expansionism: number };
  /** Innate cultural disposition the culture mean-reverts toward. */
  culture0: { cohesion: number; militarism: number; curiosity: number; expansionism: number };
  resources: number;
  resourcesMax: number;
  territory: number;
  economy: number;
  energy: number;
  satellites: number;
  colonies: Colony[];
  transits: Transit[];
  counters: CivCounters;
  milestones: Record<string, number>;
  discoveryIndex: number;
  depleted: boolean;
  steps: number;
  source: 'natural' | 'intervention';
}

/** Environment the civilization lives in, evaluated at a given time (pure function of time + interventions). */
export interface HomeEnvironment {
  habitability: number;
  /** Habitable land area relative to Earth's land. */
  area: number;
  geology: number;
  starAlive: boolean;
  impactFactor: number;
  resourceIndex: number;
  hydrocarbons: number;
  moons: number;
  /** Other planets in the system that can host colonies. */
  colonyTargets: { p: number; quality: number }[];
}

export interface CivWorld {
  home(g: number, s: number, p: number, t: number): HomeEnvironment;
  /** Nearest suitable stars (alive at t) in galaxy g from star s, excluding `exclude`. */
  nearestStars(g: number, s: number, k: number, exclude: Set<number>, t: number): { s: number; distLy: number }[];
}

// ---- tabulated per-level parameters (index = tech level 0..6) ------------------------------
const AGRI_MULT = [1, 25, 300, 1500, 2500, 3000, 3500];
const GROWTH = [0.0004, 0.002, 0.012, 0.008, 0.005, 0.004, 0.003];
const POWER_PC = [150, 400, 2500, 6000, 15000, 40000, 150000]; // W per capita
const RENEWABLE = [1, 0.92, 0.15, 0.3, 0.6, 0.85, 0.96];
const PRODUCTIVITY = [300, 1200, 8000, 40000, 120000, 400000, 2e6]; // output per capita per year
const LEVEL_DURATION = [180000, 9000, 300, 120, 600, 8000, 1e9];
const REF_POP = [1e6, 5e7, 1e9, 5e9, 8e9, 1e10, 1e11];
const STEP = [500, 50, 5, 2, 5, 20];

const DISCOVERIES: string[][] = [
  ['control of fire', 'stone tools', 'symbolic language', 'cave art', 'the bow', 'domesticated animals'],
  ['writing', 'bronze metallurgy', 'the wheel', 'iron smelting', 'mathematics', 'astronomy', 'philosophy', 'the printing press', 'optics'],
  ['the steam engine', 'electricity', 'germ theory', 'the telegraph', 'powered flight', 'radio', 'antibiotics', 'relativity'],
  ['nuclear fission', 'the transistor', 'global networks', 'genetic engineering', 'machine intelligence', 'quantum computing'],
  ['nuclear fusion', 'orbital manufacturing', 'a space elevator', 'closed-loop habitats', 'asteroid mining'],
  ['antimatter containment', 'planetary terraforming', 'fusion torch drives', 'mind–machine interfaces', 'solar-scale engineering'],
  ['relativistic propulsion', 'stellar engineering', 'post-biological minds', 'Dyson swarms', 'wormhole theory'],
];
const LEVEL_UP_TITLE = [
  '',
  'Agricultural revolution',
  'Industrial revolution',
  'Digital revolution',
  'Became a spacefaring civilization',
  'Became an interplanetary civilization',
  'Became an interstellar civilization',
];

const interp = (table: number[], tech: number) => {
  const l = Math.min(6, Math.floor(tech));
  const f = tech - l;
  const a = table[l];
  const b = table[Math.min(6, l + 1)];
  return a + (b - a) * clamp01(f);
};

export const techLevel = (tech: number) => Math.min(6, Math.floor(tech));

/**
 * Step length in years — a function of state only. Each era has a base resolution; a
 * civilization that lingers in an era (stagnation, or a mature interstellar polity) gets
 * progressively coarser steps, so long-lived civilizations cost O(log age) steps per era
 * instead of O(age). Exact-solution dynamics keep large steps stable.
 */
export function stepLength(c: CivState): number {
  const L = techLevel(c.tech);
  const since = Math.max(0, c.time - c.levelSince);
  if (L < 6) return clamp(Math.floor(since / 400), STEP[L], 200_000);
  return clamp(Math.floor(since / 25), 50, 10_000_000);
}

export interface SpawnSpec {
  id: number;
  seed: number;
  g: number;
  s: number;
  p: number;
  t: number;
  source: 'natural' | 'intervention';
}

export function createCivilization(spec: SpawnSpec, env: HomeEnvironment): { civ: CivState; event: CivEvent } {
  const rng = new Rng(hash32(spec.seed, 0xc1f));
  const species = speciesName(spec.seed);
  const name = civName(spec.seed, species);
  const resourcesMax = 1.5e23 * Math.max(0.05, env.resourceIndex) * Math.sqrt(Math.max(0.05, env.area)) * (1 + env.hydrocarbons);
  const civ: CivState = {
    id: spec.id,
    code: civCode(spec.seed, spec.id),
    name,
    species,
    seed: spec.seed,
    g: spec.g,
    s: spec.s,
    p: spec.p,
    capital: { g: spec.g, s: spec.s, p: spec.p },
    born: spec.t,
    time: spec.t,
    levelSince: spec.t,
    alive: true,
    endedAt: null,
    endCause: null,
    rng: [0, 0, 0, 0],
    population: 1e5 * rng.range(0.5, 2),
    intelligence: clamp(rng.logNormal(1, 0.15), 0.6, 1.6),
    tech: 0,
    stability: rng.range(0.5, 0.7),
    culture: { cohesion: 0, militarism: 0, curiosity: 0, expansionism: 0 },
    culture0: { cohesion: rng.range(0.25, 0.8), militarism: rng.range(0.15, 0.75), curiosity: rng.range(0.25, 0.9), expansionism: rng.range(0.2, 0.9) },
    resources: resourcesMax,
    resourcesMax,
    territory: 0.04,
    economy: 0,
    energy: 0,
    satellites: 0,
    colonies: [],
    transits: [],
    counters: { wars: 0, famines: 0, pandemics: 0, migrations: 0, collapses: 0, discoveries: 0, breakthroughs: 0, impacts: 0, disasters: 0, colonies: 0, depletions: 0 },
    milestones: { emergence: spec.t },
    discoveryIndex: 0,
    depleted: false,
    steps: 0,
    source: spec.source,
  };
  civ.culture = { ...civ.culture0 };
  civ.rng = rng.getState();
  const event: CivEvent = {
    t: spec.t,
    type: 'emergence',
    title: spec.source === 'intervention' ? `${species} civilization seeded by intervention` : `${species} civilization emerges`,
    detail: `The ${species} form their first permanent societies. Founding population ≈ ${Math.round(civ.population).toLocaleString('en-US')}.`,
    effects: { population: [0, civ.population] },
  };
  return { civ, event };
}

export const totalPopulation = (c: CivState) => c.population + c.colonies.reduce((s, k) => s + k.population, 0);

interface StepCtx {
  c: CivState;
  rng: Rng;
  t: number;
  events: CivEvent[];
}

function record(ctx: StepCtx, type: CivEventType, title: string, detail: string, effects: Record<string, [number, number]>) {
  ctx.events.push({ t: ctx.t, type, title, detail, effects });
}

/**
 * Advance a civilization by one step of its natural length. Returns emitted events.
 * Mutates `c` in place.
 */
export function stepCivilization(c: CivState, world: CivWorld): CivEvent[] {
  if (!c.alive) return [];
  const dt = stepLength(c);
  const t = c.time + dt;
  const rng = Rng.fromState(c.rng);
  const ctx: StepCtx = { c, rng, t, events: [] };
  const L0 = techLevel(c.tech);

  // ---- 0. home viability ---------------------------------------------------------------
  const cap = c.capital;
  const env: HomeEnvironment =
    cap.p >= 0
      ? world.home(cap.g, cap.s, cap.p, t)
      : { habitability: 0.55, area: 0.6, geology: 0, starAlive: true, impactFactor: 0, resourceIndex: 0.4, hydrocarbons: 0, moons: 0, colonyTargets: [] };
  if (!env.starAlive) {
    const refuge = c.colonies.filter((k) => k.kind === 'star').sort((a, b) => b.population - a.population)[0];
    if (refuge) {
      const before = c.population;
      c.capital = { g: refuge.g, s: refuge.s, p: -1 };
      c.population = Math.max(c.population * 0.05, refuge.population);
      c.colonies = c.colonies.filter((k) => k !== refuge && !(k.s === cap.s && k.g === cap.g));
      record(ctx, 'relocation', 'Home system lost — capital relocated', `The home star has died. Survivors regroup at colony G${refuge.g}-S${refuge.s}.`, {
        population: [before, c.population],
      });
    } else {
      extinguish(ctx, 'Host star died', 'The home star left the main sequence; with no refuge beyond the system, the civilization perishes.');
      return finish(ctx, L0);
    }
  }

  // ---- 1. carrying capacity & population (exact logistic) --------------------------------
  const resFrac = c.resourcesMax > 0 ? clamp01(c.resources / c.resourcesMax) : 0;
  const offworld = c.colonies.length > 0 ? Math.min(0.6, 0.05 * c.colonies.length) : 0;
  const access = Math.min(1.2, 0.25 + 0.75 * Math.min(1, resFrac * 2.5) + offworld);
  const K =
    5e6 * Math.max(0.01, env.area) * Math.max(0.02, env.habitability) * interp(AGRI_MULT, c.tech) * (0.3 + 0.7 * c.territory) * (0.35 + 0.65 * Math.sqrt(Math.min(1, access)));
  const r = GROWTH[L0] * (0.5 + c.stability);
  const P0 = Math.max(1, c.population);
  c.population = K / (1 + ((K - P0) / P0) * Math.exp(-r * dt));

  // Colonies grow logistically toward their own capacity.
  for (const k of c.colonies) {
    const p0 = Math.max(1, k.population);
    k.population = k.capacity / (1 + ((k.capacity - p0) / p0) * Math.exp(-0.02 * dt));
  }

  // ---- 2. energy, resources, economy ----------------------------------------------------
  const pop = totalPopulation(c);
  c.energy = pop * interp(POWER_PC, c.tech);
  const use = c.energy * (1 - interp(RENEWABLE, c.tech)) * 3.156e7 * dt * 0.5;
  const income =
    c.tech >= 4.5 ? (c.colonies.length + env.moons * 0.5 + 1) * 2e20 * (c.tech - 4.5) * dt * Math.min(1, offworld * 4 + 0.25) : 0;
  c.resources = clamp(c.resources - use + income, 0, c.resourcesMax * 3);
  const resAfter = c.resourcesMax > 0 ? c.resources / c.resourcesMax : 0;
  if (!c.depleted && resAfter < 0.2 && L0 >= 2) {
    c.depleted = true;
    c.counters.depletions++;
    const before = c.stability;
    c.stability = clamp01(c.stability - 0.12);
    record(ctx, 'resource-depletion', 'Resource depletion', 'Accessible fossil fuels and high-grade ores are exhausted. Output contracts until substitutes or off-world supply arrive.', {
      resources: [resFrac * 100, resAfter * 100],
      stability: [before, c.stability],
    });
  } else if (c.depleted && resAfter > 0.4) c.depleted = false;

  const access2 = Math.min(1.2, 0.25 + 0.75 * Math.min(1, resAfter * 2.5) + offworld);
  c.economy = pop * interp(PRODUCTIVITY, c.tech) * Math.min(1, access2) * (0.35 + 0.65 * c.stability);

  // ---- 3. technology --------------------------------------------------------------------
  const popFactor = clamp(Math.log10(Math.max(10, pop)) / Math.log10(REF_POP[L0]), 0.2, 1.5);
  const techRate = (1 / LEVEL_DURATION[L0]) * c.intelligence * (0.5 + c.culture.curiosity) * popFactor * Math.pow(c.stability, 1.2) * Math.sqrt(Math.min(1, access2));
  const techBefore = c.tech;
  c.tech = Math.min(MAX_TECH, c.tech + techRate * dt);
  checkLevelUp(ctx, techBefore);

  // ---- 4. stability (exact relaxation) & culture drift ----------------------------------
  const overshoot = Math.max(0, c.population / Math.max(1, K) - 0.95);
  const target = clamp(0.45 + 0.3 * c.culture.cohesion + 0.25 * (Math.min(1, access2) - 0.5) - 0.25 * overshoot - 0.15 * c.culture.militarism + (L0 >= 6 ? 0.12 : 0), 0.05, 0.98);
  c.stability = target + (c.stability - target) * Math.exp(-dt / 40);
  // Culture: Ornstein–Uhlenbeck process around the innate disposition, updated with its
  // exact transition density so any step length is valid (τ = 3 kyr, stationary σ = 0.1).
  const decay = Math.exp(-dt / 3000);
  const ouSd = 0.1 * Math.sqrt(1 - decay * decay);
  for (const key of ['cohesion', 'militarism', 'curiosity', 'expansionism'] as const) {
    const mu = c.culture0[key];
    c.culture[key] = clamp(mu + (c.culture[key] - mu) * decay + rng.gaussian(0, ouSd), 0.02, 0.98);
  }

  // ---- 5. stochastic events (fixed order → deterministic) -------------------------------
  const occur = (ratePerYear: number) => Math.min(3, rng.poisson(Math.max(0, ratePerYear) * dt));
  const L = techLevel(c.tech);
  const crowd = c.population / Math.max(1, K);

  // Rates are per year for *civilization-scale* events. Mature interstellar civilizations
  // (L6, steps up to 1 Myr) are immune to planet-scale hazards.
  const PANDEMIC = [0.00005, 0.0015, 0.002, 0.001, 0.0002, 0, 0];
  const WAR = [0.0002, 0.003, 0.003, 0.002, 0.0015, 0.0005, 0];
  for (let n = occur(L <= 3 && crowd > 0.85 ? 0.0008 * (crowd - 0.85) * 10 + 0.0004 * (1 - Math.min(1, access2)) : 0); n > 0; n--) famine(ctx, L);
  for (let n = occur(WAR[L] * (0.2 + c.culture.militarism) * (1.3 - c.stability)); n > 0; n--) war(ctx, L);
  for (let n = occur(PANDEMIC[L] * Math.min(2, c.population / 1e9 + 0.3)); n > 0; n--) pandemic(ctx, L);
  for (let n = occur(L <= 4 && c.territory < 1 ? 0.002 * (crowd > 0.85 ? 1 : 0.2) : 0); n > 0; n--) migration(ctx);
  for (let n = occur(L < 6 ? 0.02 * Math.max(0, 0.3 - c.stability) : 0); n > 0; n--) collapse(ctx);
  // ~8 named discoveries per technological era; each contributes a fraction of the era's progress.
  for (let n = occur(L < 6 ? (8 / LEVEL_DURATION[L]) * (0.3 + c.culture.curiosity) : 1e-8); n > 0; n--) discovery(ctx);
  for (let n = occur(L >= 1 && L < 6 ? 0.0015 * c.stability : 0); n > 0; n--) goldenAge(ctx);
  for (let n = occur(2e-7 * env.impactFactor); n > 0; n--) asteroidImpact(ctx, L);
  for (let n = occur(L <= 4 ? 0.0015 * env.geology : 0); n > 0; n--) disaster(ctx);
  // Self-destruction filter: the dangerous window between industrial weapons and off-world safety.
  if (c.alive && L >= 3 && L <= 4 && occur(2e-3 * (0.3 + c.culture.militarism) * (1.1 - c.stability)) > 0) selfDestruction(ctx);
  // Even galactic civilizations are not eternal: a slow hazard of decline (mean ≈ 2.5 Gyr).
  if (c.alive && L === 6 && occur(4e-10 * (1.5 - c.stability)) > 0) decline(ctx);

  // ---- 6. space programme & expansion ---------------------------------------------------
  if (c.alive) space(ctx, env, world, dt);

  if (c.alive && c.population < 5000 && !c.colonies.some(isRefuge)) extinguish(ctx, 'Population collapse', 'The population fell below a viable size and the civilization vanished.');
  return finish(ctx, L0);
}

function finish(ctx: StepCtx, levelBefore: number): CivEvent[] {
  if (techLevel(ctx.c.tech) !== levelBefore) ctx.c.levelSince = ctx.t;
  ctx.c.time = ctx.t;
  ctx.c.steps++;
  ctx.c.rng = ctx.rng.getState();
  return ctx.events;
}

function checkLevelUp(ctx: StepCtx, before: number) {
  const c = ctx.c;
  const a = techLevel(before);
  const b = techLevel(c.tech);
  for (let L = a + 1; L <= b; L++) {
    c.counters.breakthroughs++;
    const key = ['primitive', 'agriculture', 'industry', 'digital', 'spacefaring', 'interplanetary', 'interstellar'][L];
    if (c.milestones[key] === undefined) c.milestones[key] = ctx.t;
    record(ctx, 'breakthrough', LEVEL_UP_TITLE[L], `Technology level ${L - 1} → ${L} (${TECH_NAMES[L]}).`, { techLevel: [L - 1, L] });
  }
}

function extinguish(ctx: StepCtx, cause: string, detail: string) {
  const c = ctx.c;
  const before = totalPopulation(c);
  c.alive = false;
  c.endedAt = ctx.t;
  c.endCause = cause;
  c.population = 0;
  for (const k of c.colonies) k.population = 0;
  c.transits = [];
  record(ctx, 'extinction', `Extinction: ${cause}`, detail, { population: [before, 0] });
}

function famine(ctx: StepCtx, L: number) {
  const c = ctx.c;
  const loss = ctx.rng.range(0.03, 0.2) * (L >= 3 ? 0.4 : 1);
  const p0 = c.population, s0 = c.stability;
  c.population *= 1 - loss;
  c.stability = clamp01(c.stability - 0.08);
  c.counters.famines++;
  record(ctx, 'famine', 'Famine', `Harvest failures exceed food reserves; ${(loss * 100).toFixed(1)}% of the population perishes.`, {
    population: [p0, c.population],
    stability: [s0, c.stability],
  });
}

function war(ctx: StepCtx, L: number) {
  const c = ctx.c;
  const nuclear = L >= 3 && L <= 4 && ctx.rng.chance(0.05);
  const popLoss = nuclear ? ctx.rng.range(0.25, 0.65) : ctx.rng.range(0.005, 0.06) * (L === 0 ? 0.5 : 1);
  // Industrial warfare consumes far more of the resource base than pre-industrial conflict.
  const resLoss = ctx.rng.range(0.03, 0.12) * (nuclear ? 2.5 : 1) * (L === 0 ? 0.03 : L === 1 ? 0.15 : 1);
  const p0 = c.population, r0 = c.resources, s0 = c.stability, t0 = c.tech;
  c.population *= 1 - popLoss;
  c.resources *= 1 - resLoss;
  c.stability = clamp01(c.stability - (nuclear ? 0.35 : 0.1));
  c.tech = nuclear ? Math.max(Math.floor(c.tech) - 0.6, c.tech - 0.4, 0) : Math.min(MAX_TECH, c.tech + 0.01);
  c.counters.wars++;
  record(
    ctx,
    'war',
    nuclear ? 'Nuclear war' : 'War',
    nuclear
      ? `A nuclear exchange devastates cities; ${(popLoss * 100).toFixed(0)}% killed and industrial capacity shattered.`
      : `Armed conflict consumes ${(resLoss * 100).toFixed(1)}% of resources and ${(popLoss * 100).toFixed(1)}% of the population.`,
    { population: [p0, c.population], resources: [r0, c.resources], stability: [s0, c.stability], tech: [t0, c.tech] },
  );
}

function pandemic(ctx: StepCtx, L: number) {
  const c = ctx.c;
  // Heavy-tailed severity: most outbreaks are mild; a few are Black-Death scale.
  const loss = 0.01 + (L < 2 ? 0.3 : L < 3 ? 0.15 : 0.06) * Math.pow(ctx.rng.next(), 3);
  const p0 = c.population, s0 = c.stability;
  c.population *= 1 - loss;
  c.stability = clamp01(c.stability - 0.05);
  c.counters.pandemics++;
  record(ctx, 'pandemic', 'Pandemic', `A novel pathogen spreads through dense settlements, killing ${(loss * 100).toFixed(1)}%.`, {
    population: [p0, c.population],
    stability: [s0, c.stability],
  });
}

function migration(ctx: StepCtx) {
  const c = ctx.c;
  const t0 = c.territory, s0 = c.stability;
  c.territory = clamp01(c.territory + ctx.rng.range(0.03, 0.12));
  c.stability = clamp01(c.stability - 0.02);
  c.counters.migrations++;
  record(ctx, 'migration', 'Great migration', `Population pressure drives settlement of new lands. Territory ${(t0 * 100).toFixed(0)}% → ${(c.territory * 100).toFixed(0)}% of habitable land.`, {
    territory: [t0, c.territory],
    stability: [s0, c.stability],
  });
}

function collapse(ctx: StepCtx) {
  const c = ctx.c;
  const t0 = c.tech, p0 = c.population, s0 = c.stability, k0 = c.colonies.length;
  c.tech = Math.max(0, c.tech - ctx.rng.range(0.05, 0.35) * (c.tech >= 2 ? 1 : 0.5));
  c.population *= ctx.rng.range(0.7, 0.95);
  c.stability = 0.45;
  c.colonies = c.colonies.filter((k) => k.kind !== 'star' || ctx.rng.next() > 0.3);
  c.counters.collapses++;
  record(ctx, 'collapse', 'Political collapse', `Central authority disintegrates into a dark age; knowledge is lost${k0 !== c.colonies.length ? ' and distant colonies break away' : ''}.`, {
    tech: [t0, c.tech],
    population: [p0, c.population],
    stability: [s0, c.stability],
    colonies: [k0, c.colonies.length],
  });
}

function decline(ctx: StepCtx) {
  const c = ctx.c;
  const t0 = c.tech, k0 = c.colonies.length, p0 = totalPopulation(c);
  const keep = ctx.rng.range(0, 0.4);
  c.colonies = c.colonies.filter((k) => k.kind !== 'star' || ctx.rng.next() < keep);
  c.transits = [];
  c.tech = ctx.rng.range(3.2, 5.5);
  c.stability = 0.35;
  c.counters.collapses++;
  record(ctx, 'collapse', 'Galactic decline', 'The interstellar polity fragments; most distant colonies fall silent and the civilization retreats toward its home system.', {
    tech: [t0, c.tech],
    colonies: [k0, c.colonies.length],
    population: [p0, totalPopulation(c)],
  });
}

function discovery(ctx: StepCtx) {
  const c = ctx.c;
  const L = techLevel(c.tech);
  const list = DISCOVERIES[L];
  const name = list[c.discoveryIndex % list.length];
  c.discoveryIndex++;
  const t0 = c.tech;
  c.tech = Math.min(MAX_TECH, c.tech + ctx.rng.range(0.005, 0.02));
  c.counters.discoveries++;
  record(ctx, 'discovery', `Discovery: ${name}`, `Scholars of the ${c.name} master ${name}, accelerating technological progress.`, { tech: [t0, c.tech] });
  checkLevelUp(ctx, t0);
}

function goldenAge(ctx: StepCtx) {
  const c = ctx.c;
  const s0 = c.stability;
  c.stability = clamp01(c.stability + 0.1);
  c.culture.curiosity = clamp(c.culture.curiosity + 0.05, 0.02, 0.98);
  record(ctx, 'golden-age', 'Golden age', 'A period of peace, prosperity and cultural flourishing.', { stability: [s0, c.stability] });
}

function asteroidImpact(ctx: StepCtx, L: number) {
  if (L >= 5) {
    record(ctx, 'deflection', 'Asteroid deflected', 'Planetary defence intercepts an impactor on a collision course.', {});
    return;
  }
  const sev = Math.pow(ctx.rng.next(), 3);
  applyImpact(ctx, sev);
}

/** Shared by natural impacts and the user's "trigger asteroid impact" intervention. */
export function applyImpactTo(c: CivState, t: number, severity: number): CivEvent[] {
  const rng = Rng.fromState(c.rng);
  const ctx: StepCtx = { c, rng, t, events: [] };
  applyImpact(ctx, severity);
  c.rng = rng.getState();
  return ctx.events;
}

function applyImpact(ctx: StepCtx, sev: number) {
  const c = ctx.c;
  const p0 = c.population, s0 = c.stability, r0 = c.resources;
  c.population *= 1 - 0.6 * sev;
  c.stability = clamp01(c.stability - 0.3 * sev);
  c.resources *= 1 - 0.1 * sev;
  c.counters.impacts++;
  record(ctx, 'asteroid-impact', 'Asteroid impact', `An impactor strikes the home world (severity ${(sev * 100).toFixed(0)}%), triggering firestorms and an impact winter.`, {
    population: [p0, c.population],
    stability: [s0, c.stability],
    resources: [r0, c.resources],
  });
  if (sev > 0.97 && techLevel(c.tech) < 4 && !c.colonies.some(isRefuge)) extinguish(ctx, 'Impact winter', 'The impact winter collapses the biosphere the civilization depends on.');
}

function disaster(ctx: StepCtx) {
  const c = ctx.c;
  const loss = ctx.rng.range(0.0005, 0.01);
  const p0 = c.population, e0 = c.economy, s0 = c.stability;
  c.population *= 1 - loss;
  c.economy *= 0.97;
  c.stability = clamp01(c.stability - 0.01);
  c.counters.disasters++;
  const kind = ctx.rng.pick(['Earthquake', 'Volcanic eruption', 'Tsunami', 'Super-storm', 'Flood']);
  record(ctx, 'disaster', kind, `A major ${kind.toLowerCase()} strikes populated regions.`, {
    population: [p0, c.population],
    economy: [e0, c.economy],
    stability: [s0, c.stability],
  });
}

/** Self-sufficient off-world settlements that can outlive the home world. */
const isRefuge = (k: Colony) => k.kind === 'planet' || k.kind === 'star';

function selfDestruction(ctx: StepCtx) {
  const c = ctx.c;
  const cause = ctx.rng.pick(['Global thermonuclear war', 'Runaway machine intelligence', 'Engineered pandemic', 'Runaway climate change']);
  if (c.colonies.some(isRefuge)) {
    const p0 = c.population, t0 = c.tech;
    c.population *= 0.1;
    c.tech = Math.max(2, c.tech - 1);
    c.stability = 0.3;
    c.counters.collapses++;
    record(ctx, 'collapse', cause, 'The home world is devastated; off-world colonies preserve a remnant of the civilization.', {
      population: [p0, c.population],
      tech: [t0, c.tech],
    });
  } else {
    extinguish(ctx, cause, 'A self-inflicted catastrophe during the technological adolescence ends the civilization.');
  }
}

function addColony(ctx: StepCtx, k: Colony, title: string, detail: string) {
  const c = ctx.c;
  const n0 = c.colonies.length;
  c.colonies.push(k);
  c.counters.colonies++;
  record(ctx, 'colonization', title, detail, { colonies: [n0, c.colonies.length] });
}

function space(ctx: StepCtx, env: HomeEnvironment, world: CivWorld, dt: number) {
  const c = ctx.c;
  const m = c.milestones;
  const T = c.tech;
  const at = (key: string, threshold: number) => T >= threshold && m[key] === undefined;
  const home = c.capital;

  if (at('satellite', 3.55)) {
    m.satellite = ctx.t;
    record(ctx, 'space', 'First artificial satellite launched', 'Orbital spaceflight begins.', { satellites: [0, 1] });
  }
  // Orbital infrastructure scales with technology (decays after collapses as tech falls).
  c.satellites = T >= 3.55 ? Math.round(Math.min(60000, Math.pow(10, (T - 3.5) * 3.2))) : 0;
  if (at('crewed', 3.8)) {
    m.crewed = ctx.t;
    record(ctx, 'space', 'First crewed spaceflight', `A member of the ${c.species} species reaches orbit.`, {});
  }
  if (home.p >= 0 && at('orbital', 4.0)) {
    m.orbital = ctx.t;
    addColony(ctx, { kind: 'orbital', g: home.g, s: home.s, p: home.p, m: -1, founded: ctx.t, population: 1000, capacity: 5e7 }, 'First orbital colony', 'A permanent habitat is established in orbit.');
  }
  if (home.p >= 0 && at('moonbase', 4.3)) {
    m.moonbase = ctx.t;
    if (env.moons > 0) addColony(ctx, { kind: 'moon', g: home.g, s: home.s, p: home.p, m: 0, founded: ctx.t, population: 500, capacity: 2e8 }, 'Lunar base founded', 'The first settlement on a natural satellite.');
  }
  if (at('interplanetary', 4.7)) {
    m.interplanetary = ctx.t;
    const target = env.colonyTargets.filter((x) => !c.colonies.some((k) => k.kind === 'planet' && k.p === x.p && k.s === home.s))[0];
    if (target)
      addColony(ctx, { kind: 'planet', g: home.g, s: home.s, p: target.p, m: -1, founded: ctx.t, population: 200, capacity: 1e8 + 2e9 * target.quality }, 'First interplanetary colony', `Settlers land on planet ${String.fromCharCode(98 + target.p)} of the home system.`);
  }
  // Ongoing in-system expansion at interplanetary tech.
  if (T >= 5 && techLevel(T) < 7) {
    const remaining = env.colonyTargets.filter((x) => !c.colonies.some((k) => k.kind === 'planet' && k.p === x.p && k.s === home.s));
    if (remaining.length && ctx.rng.next() < 1 - Math.exp(-0.01 * c.culture.expansionism * dt)) {
      const tg = remaining[0];
      addColony(ctx, { kind: 'planet', g: home.g, s: home.s, p: tg.p, m: -1, founded: ctx.t, population: 200, capacity: 1e8 + 2e9 * tg.quality }, 'New planetary colony', `Planet ${String.fromCharCode(98 + tg.p)} is settled.`);
    }
  }
  if (at('probe', 5.6)) {
    m.probe = ctx.t;
    record(ctx, 'space', 'First interstellar probe launched', 'An uncrewed probe departs toward a neighbouring star.', {});
  }
  // Interstellar colonisation wave.
  if (T >= 6) {
    const starColonies = c.colonies.filter((k) => k.kind === 'star');
    const cap = 150;
    const launches = Math.min(4, ctx.rng.poisson(0.002 * (0.5 + c.culture.expansionism) * dt * Math.sqrt(1 + starColonies.length)));
    if (starColonies.length + c.transits.length < cap) {
      for (let n = 0; n < launches; n++) {
        const origins = [home.s, ...starColonies.map((k) => k.s)];
        const from = origins[Math.floor(ctx.rng.next() * origins.length)];
        const exclude = new Set<number>([home.s, ...starColonies.map((k) => k.s), ...c.transits.map((x) => x.s)]);
        const near = world.nearestStars(home.g, from, 1, exclude, ctx.t);
        if (!near.length) break;
        const speed = 0.02 + 0.08 * clamp01(T - 6); // fraction of c
        c.transits.push({ g: home.g, s: near[0].s, fromS: from, launched: ctx.t, arrival: ctx.t + near[0].distLy / speed });
      }
    }
    const arrived = c.transits.filter((x) => x.arrival <= ctx.t);
    if (arrived.length) {
      c.transits = c.transits.filter((x) => x.arrival > ctx.t);
      for (const x of arrived) {
        addColony(ctx, { kind: 'star', g: x.g, s: x.s, p: -1, m: -1, founded: ctx.t, population: 1e4, capacity: 2e9 }, 'Interstellar colony founded', `A colony ship arrives at star G${x.g}-S${x.s} after ${Math.round(x.arrival - x.launched).toLocaleString('en-US')} years in transit.`);
      }
    }
  }
}

/** Snapshot-safe deep clone of a civilization's mutable state. */
export function cloneCiv(c: CivState): CivState {
  return {
    ...c,
    capital: { ...c.capital },
    rng: [c.rng[0], c.rng[1], c.rng[2], c.rng[3]],
    culture: { ...c.culture },
    culture0: { ...c.culture0 },
    colonies: c.colonies.map((k) => ({ ...k })),
    transits: c.transits.map((x) => ({ ...x })),
    counters: { ...c.counters },
    milestones: { ...c.milestones },
  };
}

/** Qualitative extinction risk used by the Observer summary and the inspector. */
export function extinctionRisk(c: CivState): { score: number; label: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' } {
  if (!c.alive) return { score: 1, label: 'CRITICAL' };
  const L = techLevel(c.tech);
  let s = 0.15;
  s += (1 - c.stability) * 0.35;
  s += c.resourcesMax > 0 && c.resources / c.resourcesMax < 0.25 ? 0.15 : 0;
  s += L >= 3 && L <= 4 ? 0.15 * (0.3 + c.culture.militarism) : 0;
  s -= c.colonies.filter((k) => k.kind === 'star').length > 0 ? 0.3 : 0;
  s -= c.colonies.length > 0 ? 0.1 : 0;
  s += c.population < 1e6 ? 0.2 : 0;
  s = clamp01(s);
  return { score: s, label: s < 0.25 ? 'LOW' : s < 0.45 ? 'MODERATE' : s < 0.65 ? 'HIGH' : 'CRITICAL' };
}
