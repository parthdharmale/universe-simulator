import { hash32 } from '../core/rng';
import { KPC_PER_AU, LY_PER_KPC, MAX_YEARS } from '../core/constants';
import { Vec3 } from '../core/math';
import { visualScale } from '../gen/cosmology';
import { Galaxy, StarCatalog, Universe, galaxyAngle, localToWorldOffset, starSeed } from '../gen/galaxy';
import {
  Atmosphere,
  HabitabilityFactors,
  Planet,
  PlanetEnv,
  PlanetType,
  Resources,
  StarInput,
  StarSystem,
  classify,
  composeAtmosphere,
  generateSystem,
  geologyAt,
  habitabilityFactors,
  habitabilityIndex,
} from '../gen/planets';
import { StarCore, StarPhase, mainSequenceProps, starPhaseAt, starPropsAt, starTimeline } from '../gen/star';
import { ClimateResult, solveClimate } from '../physics/climate';
import { HSegment, LifeState, LifeTimeline, hydrocarbonIndex, integrateLife, lifeGenome, lifeStateAt, oxygenFraction } from '../life/life';
import { StarGrid } from '../spatial/grid';
import { UniverseCatalog, planetKey, starKey } from '../survey/catalog';
import { CivWorld, HomeEnvironment } from '../civ/civilization';
import { OverrideLayer } from './interventions';

export interface PlanetDynamic {
  planet: Planet;
  env: PlanetEnv;
  climate: ClimateResult;
  atmosphere: Atmosphere;
  type: PlanetType;
  habitability: number;
  factors: HabitabilityFactors;
  geology: number;
  life: LifeState;
  timeline: LifeTimeline;
  oxygen: number;
  resources: Resources;
  modified: boolean;
  starPhase: StarPhase;
}

/** Small LRU on top of Map insertion order. */
class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

/**
 * UniverseQueries: lazy, cached, override-aware access to everything below galaxy level.
 * All results are pure functions of (seed, intervention log, time).
 */
export class UniverseQueries implements CivWorld {
  private systems = new LRU<number, StarSystem>(384);
  private timelines = new LRU<string, LifeTimeline>(2048);
  private climates = new LRU<string, { climate: ClimateResult; H: number; factors: HabitabilityFactors; type: PlanetType }>(2048);
  private grids = new Map<number, StarGrid>();
  systemsGenerated = 0;

  constructor(
    readonly universe: Universe,
    public catalog: UniverseCatalog | null,
    readonly overrides: OverrideLayer,
  ) {}

  get galaxies(): Galaxy[] {
    return this.universe.galaxies;
  }

  catalogOf(g: number): StarCatalog | null {
    return this.catalog ? this.catalog.surveys[g].catalog : null;
  }

  starCount(g: number): number {
    return (this.catalogOf(g)?.count ?? 0) + (this.overrides.createdByGalaxy.get(g)?.length ?? 0);
  }

  isCreatedStar(g: number, s: number): boolean {
    const c = this.catalogOf(g);
    return !!c && s >= c.count;
  }

  starInput(g: number, s: number): StarInput | null {
    const cat = this.catalogOf(g);
    if (!cat) return null;
    if (s < cat.count) return { g, s, seed: starSeed(this.universe.galaxies[g].seed, s), mass: cat.mass[s], feh: cat.feh[s], birth: cat.birth[s] };
    const cs = this.overrides.createdStar(g, s);
    return cs ? { g, s, seed: cs.seed, mass: cs.mass, feh: cs.feh, birth: cs.birth } : null;
  }

  starLocal(g: number, s: number): Vec3 | null {
    const cat = this.catalogOf(g);
    if (!cat) return null;
    if (s < cat.count) return [cat.x[s], cat.y[s], cat.z[s]];
    const cs = this.overrides.createdStar(g, s);
    return cs ? [cs.x, cs.y, cs.z] : null;
  }

  destroyedAt(g: number, s: number): number | undefined {
    return this.overrides.destroyedStars.get(starKey(g, s));
  }

  starCore(g: number, s: number): StarCore | null {
    const inp = this.starInput(g, s);
    return inp ? starTimeline(inp.mass, inp.feh, inp.birth) : null;
  }

  starState(g: number, s: number, t: number) {
    const core = this.starCore(g, s);
    if (!core) return null;
    return { core, ...starPropsAt(core, t, this.destroyedAt(g, s)) };
  }

  /** Star exists and is still on the main sequence (habitable-zone host) at time t. */
  starAlive(g: number, s: number, t: number): boolean {
    const core = this.starCore(g, s);
    if (!core) return false;
    const d = this.destroyedAt(g, s);
    return t >= core.birth && t < core.msEnd && (d === undefined || t < d);
  }

  getSystem(g: number, s: number): StarSystem | null {
    const key = starKey(g, s);
    const hit = this.systems.get(key);
    if (hit) return hit;
    const inp = this.starInput(g, s);
    if (!inp) return null;
    const sys = generateSystem(inp, { moons: true, dynamics: true });
    this.systemsGenerated++;
    this.systems.set(key, sys);
    return sys;
  }

  get cachedSystems() {
    return this.systems.size;
  }

  invalidate() {
    this.timelines.clear();
    this.climates.clear();
  }

  // ---- planets -------------------------------------------------------------------------------

  envAt(planet: Planet, key: number, t: number): { env: PlanetEnv; patchIndex: number } {
    const patches = this.overrides.envPatches.get(key);
    let env = planet.env;
    let idx = -1;
    if (patches) {
      for (let i = 0; i < patches.length; i++) {
        if (patches[i].t <= t) {
          env = { ...env, ...patches[i].patch };
          idx = i;
        }
      }
    }
    return { env, patchIndex: idx };
  }

  private climateFor(planet: Planet, sys: StarSystem, key: number, env: PlanetEnv, patchIndex: number, insolationScale: number): { climate: ClimateResult; H: number; factors: HabitabilityFactors; type: PlanetType } {
    if (patchIndex < 0 && insolationScale === 1) return { climate: planet.climate, H: planet.habitability, factors: planet.habitabilityFactors, type: planet.type };
    const ck = `${key}:${this.overrides.version}:${patchIndex}:${insolationScale}`;
    const hit = this.climates.get(ck);
    if (hit) return hit;
    const giant = planet.composition === 'gaseous';
    let climate = planet.climate;
    if (!giant) {
      // Continuity: start from the state the planet was in just before this change.
      const prior =
        insolationScale !== 1
          ? this.climateFor(planet, sys, key, env, patchIndex, 1).climate
          : patchIndex > 0
            ? this.climateFor(planet, sys, key, this.envAtPatch(planet, key, patchIndex - 1), patchIndex - 1, 1).climate
            : planet.climate;
      climate = solveClimate({
        insolation: planet.insolation * insolationScale,
        pN2: env.pN2,
        pCO2: env.pCO2,
        pCH4: env.pCH4,
        pO2: 0,
        water: env.water,
        geology: planet.geology0,
        forcing: env.forcing,
        co2Locked: env.co2Locked,
        initialTemp: prior.surfaceTemp,
      });
    }
    const factors = habitabilityFactors(climate, planet.geology0, sys.star.feh, planet.magneticField, sys.star.spectralClass, planet.tidallyLocked, giant);
    const H = insolationScale === 1 ? habitabilityIndex(factors) : 0;
    const kind = planet.type === 'gas-giant' ? 'gas-giant' : planet.type === 'ice-giant' ? 'ice-giant' : planet.composition === 'icy' ? 'icy' : 'rocky';
    const type = classify(kind, climate, planet.geology0, planet.tidalHeating, H);
    const out = { climate, H, factors, type };
    this.climates.set(ck, out);
    return out;
  }

  /** Environment in effect right after patch `i` was applied. */
  private envAtPatch(planet: Planet, key: number, i: number): PlanetEnv {
    const patches = this.overrides.envPatches.get(key) ?? [];
    let env = planet.env;
    for (let k = 0; k <= i && k < patches.length; k++) env = { ...env, ...patches[k].patch };
    return env;
  }

  lifeTimeline(g: number, s: number, p: number): LifeTimeline | null {
    const sys = this.getSystem(g, s);
    const planet = sys?.planets[p];
    if (!sys || !planet) return null;
    const key = planetKey(g, s, p);
    const tk = `${key}:${this.overrides.version}`;
    const hit = this.timelines.get(tk);
    if (hit) return hit;
    const segments: HSegment[] = [{ t: planet.formation, H: planet.habitability }];
    const patches = this.overrides.envPatches.get(key);
    if (patches) {
      patches.forEach((pt, i) => {
        const { env } = this.envAt(planet, key, pt.t);
        segments.push({ t: pt.t, H: this.climateFor(planet, sys, key, env, i, 1).H });
      });
    }
    const core = starTimeline(sys.star.mass, sys.star.feh, sys.star.birth);
    const destroyed = this.destroyedAt(g, s);
    const tl = integrateLife(lifeGenome(planet.seed), {
      formation: planet.formation,
      windowEnd: Math.min(core.msEnd, destroyed ?? Infinity),
      segments,
      impulses: this.overrides.lifeImpulses.get(key),
      until: MAX_YEARS,
      recordExtinctions: true,
    });
    this.timelines.set(tk, tl);
    return tl;
  }

  planetAt(g: number, s: number, p: number, t: number): PlanetDynamic | null {
    const sys = this.getSystem(g, s);
    const planet = sys?.planets[p];
    if (!sys || !planet) return null;
    const key = planetKey(g, s, p);
    const { env, patchIndex } = this.envAt(planet, key, t);
    const core = starTimeline(sys.star.mass, sys.star.feh, sys.star.birth);
    const phase = starPhaseAt(core, t, this.destroyedAt(g, s));
    // Post-main-sequence: a red giant scorches the system; remnants leave it frozen.
    const insolScale = phase === 'red-giant' ? 150 : phase === 'main-sequence' || phase === 'protostar' || phase === 'unborn' ? 1 : 1e-4;
    const c = this.climateFor(planet, sys, key, env, patchIndex, insolScale);
    const timeline = this.lifeTimeline(g, s, p)!;
    const life = lifeStateAt(timeline, t);
    const oxygen = oxygenFraction(timeline, t);
    const pO2 = c.climate.pressure * oxygen;
    const atmosphere = planet.composition === 'gaseous' ? planet.atmosphere : composeAtmosphere(env.pN2, c.climate, env.pCH4 * (life.stage >= 3 ? 50 : 1), pO2);
    const resources: Resources = {
      ...planet.resources,
      hydrocarbons: Math.min(1, hydrocarbonIndex(timeline, t) + (planet.composition === 'gaseous' ? planet.resources.hydrocarbons : 0)),
    };
    if (env.resourceBoost > 0) {
      resources.metals = Math.min(1, resources.metals + env.resourceBoost * 0.3);
      resources.rareElements = Math.min(1, resources.rareElements + env.resourceBoost * 0.3);
      resources.radioactives = Math.min(1, resources.radioactives + env.resourceBoost * 0.2);
    }
    return {
      planet,
      env,
      climate: c.climate,
      atmosphere,
      type: c.type,
      habitability: c.H,
      factors: c.factors,
      geology: geologyAt(planet, t),
      life,
      timeline,
      oxygen,
      resources,
      modified: this.overrides.modifiedPlanets.has(key) || this.overrides.modifiedStars.has(starKey(g, s)) || patchIndex >= 0,
      starPhase: phase,
    };
  }

  planetSeed(g: number, s: number, p: number): number {
    const inp = this.starInput(g, s);
    return hash32(inp ? inp.seed : 0, 1000 + p);
  }

  // ---- CivWorld --------------------------------------------------------------------------------

  private homeCache = new LRU<string, HomeEnvironment>(1024);

  /**
   * Home environment for civilizations. Slowly-varying parts are evaluated at a *canonical*
   * time — the start of the 10-Myr bucket containing t, or the latest intervention patch if
   * later — so the cached value is a pure function of t (never of which caller filled the
   * cache first). Star viability is evaluated exactly on every call.
   */
  home(g: number, s: number, p: number, t: number): HomeEnvironment {
    const sys = this.getSystem(g, s);
    const planet = sys?.planets[p];
    if (!planet) return this.computeHome(g, s, p, t);
    const pk = planetKey(g, s, p);
    const { patchIndex } = this.envAt(planet, pk, t);
    const patchT = patchIndex >= 0 ? this.overrides.envPatches.get(pk)![patchIndex].t : -Infinity;
    const tCanon = Math.max(Math.floor(t / 1e7) * 1e7, patchT);
    const key = `${pk}:${this.overrides.version}:${tCanon}`;
    let base = this.homeCache.get(key);
    if (!base) {
      base = this.computeHome(g, s, p, tCanon);
      this.homeCache.set(key, base);
    }
    const alive = this.starAlive(g, s, t);
    return alive === base.starAlive ? base : { ...base, starAlive: alive };
  }

  private computeHome(g: number, s: number, p: number, t: number): HomeEnvironment {
    const d = this.planetAt(g, s, p, t);
    const sys = this.getSystem(g, s);
    if (!d || !sys) return { habitability: 0, area: 0, geology: 0, starAlive: false, impactFactor: 0, resourceIndex: 0, hydrocarbons: 0, moons: 0, colonyTargets: [] };
    const pl = d.planet;
    const land = Math.max(0.03, 1 - d.climate.liquidWater - d.climate.ice);
    const area = (pl.radiusE * pl.radiusE * land) / 0.29;
    const r = d.resources;
    const resourceIndex = (r.metals + r.rareElements * 0.6 + r.silicates * 0.3 + r.radioactives * 0.4 + r.water * 0.3) / 1.4 + d.env.resourceBoost;
    const beltMass = sys.belts.reduce((a, b) => a + b.massE, 0);
    const colonyTargets = sys.planets
      .filter((x) => x.index !== p && x.composition !== 'gaseous')
      .map((x) => ({ p: x.index, quality: Math.min(1, 0.15 + x.habitability + x.resources.metals * 0.3) }))
      .sort((a, b) => b.quality - a.quality || a.p - b.p);
    return {
      habitability: d.habitability,
      area,
      geology: d.geology,
      starAlive: this.starAlive(g, s, t),
      impactFactor: 1 + beltMass * 2000,
      resourceIndex,
      hydrocarbons: r.hydrocarbons,
      moons: pl.moons.length,
      colonyTargets,
    };
  }

  grid(g: number): StarGrid | null {
    const cat = this.catalogOf(g);
    if (!cat) return null;
    let gr = this.grids.get(g);
    if (!gr) {
      gr = new StarGrid(cat.x, cat.y, cat.z);
      this.grids.set(g, gr);
    }
    return gr;
  }

  /** Per-star cached neighbour lists (pure geometry, independent of time and state). */
  private neighbourCache = new LRU<number, number[]>(8192);

  nearestStars(g: number, s: number, k: number, exclude: Set<number>, t: number): { s: number; distLy: number }[] {
    const cat = this.catalogOf(g);
    const gr = this.grid(g);
    if (!cat || !gr || s >= cat.count) return [];
    const ok = (i: number) => i !== s && !exclude.has(i) && cat.birth[i] <= t && t < cat.msEnd[i] && this.destroyedAt(g, i) === undefined;
    const ck = starKey(g, s);
    let near = this.neighbourCache.get(ck);
    if (!near) {
      near = gr.nearest(cat.x[s], cat.y[s], cat.z[s], 24, (i) => i !== s);
      this.neighbourCache.set(ck, near);
    }
    // The cached list is the geometric k-NN; filter it, falling back to a full query only
    // when every cached neighbour is excluded (results are identical either way).
    let ids = near.filter(ok).slice(0, k);
    if (ids.length < k) ids = gr.nearest(cat.x[s], cat.y[s], cat.z[s], k, ok);
    return ids.map((i) => ({ s: i, distLy: Math.hypot(cat.x[i] - cat.x[s], cat.y[i] - cat.y[s], cat.z[i] - cat.z[s]) * LY_PER_KPC }));
  }

  // ---- positions (kpc, float64) ------------------------------------------------------------------

  galaxyWorld(g: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const gal = this.universe.galaxies[g];
    const a = visualScale(t);
    out[0] = gal.position[0] * a;
    out[1] = gal.position[1] * a;
    out[2] = gal.position[2] * a;
    return out;
  }

  starWorld(g: number, s: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const gal = this.universe.galaxies[g];
    const loc = this.starLocal(g, s) ?? [0, 0, 0];
    const tmp: Vec3 = [0, 0, 0];
    localToWorldOffset(gal, loc[0], loc[1], loc[2], galaxyAngle(gal, t), tmp);
    this.galaxyWorld(g, t, out);
    out[0] += tmp[0];
    out[1] += tmp[1];
    out[2] += tmp[2];
    return out;
  }

  static auToKpc(v: Vec3): Vec3 {
    return [v[0] * KPC_PER_AU, v[1] * KPC_PER_AU, v[2] * KPC_PER_AU];
  }

  mainSequence(g: number, s: number) {
    const inp = this.starInput(g, s);
    return inp ? mainSequenceProps(inp.mass, inp.feh) : null;
  }
}
