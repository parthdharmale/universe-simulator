import { Rng, hash32 } from '../core/rng';
import { clamp, clamp01, DEG, gaussBell, smoothstep, TAU } from '../core/math';
import { M_JUPITER_IN_EARTH, PLANET_FORMATION_DELAY } from '../core/constants';
import { planetId, moonId } from '../core/names';
import {
  OrbitalElements,
  hillRadius,
  mutualHillRadius,
  orbitalPeriodYears,
  rocheLimit,
  secularPrecessionRates,
  tidalLockTimeYears,
} from '../physics/orbits';
import { ClimateResult, retention, solveClimate } from '../physics/climate';
import { SpectralClass, mainSequenceProps } from './star';

/**
 * Planetary system generation.
 *
 * Nothing here assigns a label at random. The pipeline is:
 *   disk (mass ∝ M★ · 10^[Fe/H]) → orbital slots (geometric spacing) → core accretion
 *   (solid surface density with a snow-line jump) → runaway gas accretion if the core
 *   is massive enough before the disk dissipates → dynamical clean-up (giant-impact
 *   merging until adjacent planets are ≥ 9 mutual Hill radii apart, Kirkwood-style belt
 *   where a giant stirs the inner disk, optional hot-Jupiter migration) → bulk physics
 *   (mass–radius relations, density) → spin (tidal locking from Gladman's timescale)
 *   → atmosphere (outgassing × Jeans retention × non-thermal stripping) → climate solve
 *   → classification and habitability from the *derived* quantities.
 */

export type PlanetType = 'gas-giant' | 'ice-giant' | 'terrestrial' | 'ocean' | 'desert' | 'frozen' | 'volcanic' | 'habitable';
export type Composition = 'rocky' | 'icy' | 'gaseous';

export const EARTH_MASS_IN_SUN = 3.003e-6;

export interface Atmosphere {
  /** Surface pressure in bar (1-bar reference level for giants). */
  pressure: number;
  /** Mole fractions. */
  n2: number;
  o2: number;
  co2: number;
  h2o: number;
  ch4: number;
  ar: number;
  h2: number;
  he: number;
}

export interface Resources {
  metals: number;
  rareElements: number;
  silicates: number;
  water: number;
  hydrocarbons: number;
  radioactives: number;
  volatiles: number;
  helium3: number;
}

export interface HabitabilityFactors {
  temperature: number;
  water: number;
  atmosphere: number;
  energy: number;
  geology: number;
  chemistry: number;
  magnetism: number;
}

/** Inputs that user interventions may override; climate is re-solved from these. */
export interface PlanetEnv {
  pN2: number;
  pCO2: number;
  pCH4: number;
  water: number;
  forcing: number;
  co2Locked: boolean;
  resourceBoost: number;
}

export interface Moon {
  index: number;
  id: string;
  massE: number;
  radiusE: number;
  density: number;
  orbit: OrbitalElements;
  kind: 'rocky' | 'icy' | 'volcanic';
  /** Orbital radius in parent-planet radii (for display). */
  aInPlanetRadii: number;
}

export interface Rings {
  inner: number; // planet radii
  outer: number;
  opacity: number;
}

export interface Planet {
  index: number;
  id: string;
  seed: number;
  massE: number;
  radiusE: number;
  density: number;
  composition: Composition;
  ironFraction: number;
  waterMassFraction: number;
  orbit: OrbitalElements;
  axialTilt: number;
  /** Sidereal rotation period (hours). Negative = retrograde. */
  rotationHours: number;
  tidallyLocked: boolean;
  spinOrbitResonance: string | null;
  formation: number;
  insolation: number;
  vEscape: number;
  surfaceGravity: number;
  /** Initial geological vigour 0..1 (decays with age). */
  geology0: number;
  tidalHeating: number;
  magneticField: number;
  env: PlanetEnv;
  climate: ClimateResult;
  atmosphere: Atmosphere;
  type: PlanetType;
  habitability: number;
  habitabilityFactors: HabitabilityFactors;
  resources: Resources;
  rings: Rings | null;
  moons: Moon[];
}

export interface Belt {
  kind: 'asteroid' | 'kuiper';
  inner: number;
  outer: number;
  massE: number;
  estimatedBodies: number;
  /** Semi-major axes (AU) of mean-motion resonances with the perturbing giant (Kirkwood gaps). */
  gaps: number[];
}

export interface StarInput {
  g: number;
  s: number;
  seed: number;
  mass: number;
  feh: number;
  birth: number;
}

export interface StarSystem {
  g: number;
  s: number;
  seed: number;
  star: StarInput & ReturnType<typeof mainSequenceProps>;
  planets: Planet[];
  belts: Belt[];
  snowLine: number;
  habitableZone: [number, number];
  diskMass: number;
}

interface Slot {
  a: number;
  m: number;
  kind: 'rocky' | 'icy' | 'ice-giant' | 'gas-giant';
  belt?: boolean;
}

const ENERGY_BY_CLASS: Record<SpectralClass, number> = { O: 0.05, B: 0.15, A: 0.5, F: 0.85, G: 1, K: 0.95, M: 0.55 };

/** Reference age at which spin state (tidal locking) is evaluated. */
const SPIN_REFERENCE_AGE = 4e9;

export interface GenerateOptions {
  /** Generate moons (default true). Moons use their own RNG stream, so skipping them never
   * changes the planets — the survey skips them; the detailed system view includes them. */
  moons?: boolean;
  /** Compute secular precession rates (default true). O(n²) quadrature, render-only. */
  dynamics?: boolean;
}

export function generateSystem(star: StarInput, opts: GenerateOptions = {}): StarSystem {
  const ms = mainSequenceProps(star.mass, star.feh);
  const L = ms.luminosity;
  const M = star.mass;
  const rng = new Rng(hash32(star.seed, 0x51a7));

  const snow = 2.7 * Math.sqrt(L);
  const hz: [number, number] = [Math.sqrt(L / 1.107), Math.sqrt(L / 0.356)];
  const aIn = Math.max(0.012, 0.03 * Math.sqrt(L));
  const aOut = Math.max(snow * 3, 40 * M);

  // Disk solids relative to the minimum-mass solar nebula. Metal-rich stars build more
  // planets (planet–metallicity correlation); massive stars photoevaporate their disks.
  let fd = rng.logNormal(1, 0.55) * Math.pow(10, star.feh) * Math.pow(M, 0.7);
  if (M > 3) fd *= 0.25;
  if (M > 10) fd *= 0.1;
  const diskLife = rng.logNormal(3e6, 0.5);

  // ---- 1. orbital slots ------------------------------------------------------------
  const slots: Slot[] = [];
  let a = aIn * rng.logRange(1.5, 10);
  while (a < aOut && slots.length < 10) {
    // Not every slot completes a planet (embryos scattered or ejected).
    slots.push({ a, m: rng.chance(0.3) ? -1 : 0, kind: 'rocky' });
    a *= rng.range(1.5, 2.6);
  }

  // ---- 2. core accretion -----------------------------------------------------------
  for (const sl of slots) {
    if (sl.m < 0) {
      // Failed slot: draw the same number of variates to keep later slots' streams aligned
      // whether or not this slot formed (keeps generation robust to rule tweaks).
      rng.next();
      rng.next();
      rng.next();
      sl.m = 0;
      continue;
    }
    if (sl.a < snow) {
      sl.m = fd * 0.65 * rng.logNormal(1, 0.75) * Math.pow(sl.a / Math.sqrt(L || 1), 0.4) * Math.pow(M, 0.5);
      sl.kind = 'rocky';
    } else {
      const core = fd * 5 * rng.logNormal(1, 0.6) * Math.pow(sl.a / snow, -0.3);
      const tForm = (1e5 * Math.pow(sl.a / snow, 2.5) * rng.logNormal(1, 0.5)) / Math.max(0.05, fd);
      if (core >= 8 && tForm < diskLife * 0.6) {
        sl.m = Math.min(4000, core * rng.logRange(8, 120) * Math.sqrt(fd));
        sl.kind = 'gas-giant';
      } else if (core >= 4 && tForm < diskLife * 3) {
        sl.m = Math.min(55, core * rng.range(1.5, 3));
        sl.kind = 'ice-giant';
      } else {
        sl.m = core * 0.4;
        sl.kind = 'icy';
      }
    }
  }

  // ---- 3. giant perturbations: asteroid belt + stunted neighbour (Mars analogue) ------
  const belts: Belt[] = [];
  const gi = slots.findIndex((x) => x.kind === 'gas-giant' && x.m > 40);
  if (gi > 0) {
    const giant = slots[gi];
    const prev = slots[gi - 1];
    if (prev.a > 0.4 * giant.a) {
      prev.belt = true;
      const inner = prev.a * 0.75;
      const outer = Math.min(prev.a * 1.3, giant.a * 0.75);
      // Kirkwood gaps: a = a_J · (p/q)^(2/3) for the 4:1, 3:1, 5:2, 7:3, 2:1 resonances.
      const gaps = [1 / 4, 1 / 3, 2 / 5, 3 / 7, 1 / 2].map((r) => giant.a * Math.pow(r, 2 / 3)).filter((x) => x > inner && x < outer);
      belts.push({ kind: 'asteroid', inner, outer, massE: 0.0005 * fd, estimatedBodies: Math.round(1.1e6 * fd), gaps });
    }
    if (gi > 1 && slots[gi - 2].a > 0.25 * giant.a) slots[gi - 2].m *= 0.2;
  }

  // ---- 4. hot-Jupiter migration -----------------------------------------------------
  let planetsRaw = slots.filter((x) => !x.belt && x.m >= 0.02);
  const firstGiant = planetsRaw.findIndex((x) => x.kind === 'gas-giant');
  if (firstGiant >= 0 && rng.chance(0.05 * clamp(fd, 0.2, 3))) {
    const gp = planetsRaw[firstGiant];
    const target = rng.logRange(0.03, 0.08) * Math.sqrt(M);
    // Inward migration scatters or accretes everything it sweeps through.
    planetsRaw = planetsRaw.filter((_, k) => k > firstGiant);
    planetsRaw.unshift({ ...gp, a: target });
  }

  // ---- 5. dynamical stability: merge pairs closer than 9 mutual Hill radii ---------
  const Mearth = M / EARTH_MASS_IN_SUN;
  let merged = true;
  while (merged && planetsRaw.length > 1) {
    merged = false;
    planetsRaw.sort((p, q) => p.a - q.a);
    for (let k = 0; k < planetsRaw.length - 1; k++) {
      const p1 = planetsRaw[k];
      const p2 = planetsRaw[k + 1];
      const rh = mutualHillRadius(p1.a, p2.a, p1.m, p2.m, Mearth);
      if ((p2.a - p1.a) / rh < 9) {
        const m = p1.m + p2.m;
        const heavier = p1.m >= p2.m ? p1 : p2;
        planetsRaw.splice(k, 2, { a: (p1.a * p1.m + p2.a * p2.m) / m, m, kind: heavier.kind });
        merged = true;
        break;
      }
    }
  }

  // Kuiper belt beyond the outermost planet for low-mass stars.
  if (planetsRaw.length > 0 && M < 3 && rng.chance(0.7)) {
    const last = planetsRaw[planetsRaw.length - 1].a;
    belts.push({ kind: 'kuiper', inner: last * 1.45, outer: last * 2.6, massE: 0.02 * fd, estimatedBodies: Math.round(1e8 * fd), gaps: [] });
  }

  // ---- 6. per-planet physics (each planet has its own RNG stream) ---------------------
  const planets: Planet[] = planetsRaw.map((sl, idx) => buildPlanet(star, ms, sl, idx, snow, hz, opts));

  // Eccentricity constraint: orbits must not cross (apoapsis < next periapsis with margin).
  for (let k = 0; k < planets.length - 1; k++) {
    const p1 = planets[k].orbit;
    const p2 = planets[k + 1].orbit;
    const limit = (0.9 * (p2.a - p1.a)) / (p2.a + p1.a);
    if (p1.e + p2.e > limit) {
      const f = limit / (p1.e + p2.e);
      p1.e *= f;
      p2.e *= f;
    }
  }

  // Secular apsidal precession from mutual perturbations (Laplace–Lagrange).
  if (planets.length > 1 && opts.dynamics !== false) {
    const rates = secularPrecessionRates(
      planets.map((p) => p.orbit.a),
      planets.map((p) => p.massE * EARTH_MASS_IN_SUN),
      M,
    );
    planets.forEach((p, k) => (p.orbit.precession = rates[k]));
  }

  return { g: star.g, s: star.s, seed: star.seed, star: { ...star, ...ms }, planets, belts, snowLine: snow, habitableZone: hz, diskMass: fd };
}

function buildPlanet(
  star: StarInput,
  ms: ReturnType<typeof mainSequenceProps>,
  sl: Slot,
  idx: number,
  snow: number,
  hz: [number, number],
  opts: GenerateOptions,
): Planet {
  const seed = hash32(star.seed, 1000 + idx);
  const rng = new Rng(seed);
  const M = star.mass;
  const L = ms.luminosity;
  const m = sl.m;
  const isGiant = sl.kind === 'gas-giant' || sl.kind === 'ice-giant';

  // ---- composition & bulk ------------------------------------------------------------
  const ironFraction = clamp(0.32 + 0.1 * star.feh + rng.gaussian(0, 0.07), 0.08, 0.7);
  let wmf: number;
  const zoneRatio = sl.a / snow;
  if (sl.kind === 'icy') wmf = rng.range(0.2, 0.5);
  else if (zoneRatio < 0.7) wmf = rng.logRange(0.00003, 0.002);
  else if (zoneRatio < 1) wmf = rng.logRange(0.0005, 0.03);
  else wmf = rng.range(0.1, 0.45);

  let radius: number;
  let composition: Composition;
  if (sl.kind === 'gas-giant') {
    radius = m < M_JUPITER_IN_EARTH ? 11.2 * Math.pow(m / M_JUPITER_IN_EARTH, 0.14) : 11.2 * Math.pow(m / M_JUPITER_IN_EARTH, -0.04);
    composition = 'gaseous';
  } else if (sl.kind === 'ice-giant') {
    radius = 3.9 * Math.pow(m / 17, 0.25);
    composition = 'gaseous';
  } else {
    radius = Math.pow(m, 0.27) * (1 - 0.2 * (ironFraction - 0.32)) * (1 + 0.6 * Math.sqrt(wmf));
    composition = wmf > 0.08 ? 'icy' : 'rocky';
  }

  const insolation = L / (sl.a * sl.a);
  const teq0 = 278.6 * Math.pow(insolation, 0.25);
  if (sl.kind === 'gas-giant' && teq0 > 1000) radius *= 1 + 0.3 * smoothstep(1000, 2000, teq0); // inflated hot Jupiters
  const density = (5.51 * m) / (radius * radius * radius);
  const vEscape = 11.19 * Math.sqrt(m / radius);
  const surfaceGravity = m / (radius * radius);

  // ---- orbit ----------------------------------------------------------------------------
  const e = Math.min(0.6, sl.a < 0.1 && isGiant ? rng.rayleigh(0.01) : rng.rayleigh(isGiant ? 0.06 : 0.035));
  const orbit: OrbitalElements = {
    a: sl.a,
    e,
    i: rng.rayleigh(1.5 * DEG),
    node: rng.range(0, TAU),
    argPeri: rng.range(0, TAU),
    M0: rng.range(0, TAU),
    period: orbitalPeriodYears(sl.a, M + m * EARTH_MASS_IN_SUN),
    precession: 0,
  };

  // ---- spin -----------------------------------------------------------------------------
  let rotationHours = isGiant ? rng.logNormal(10, 0.3) : rng.logNormal(20, 0.6);
  let axialTilt: number;
  const tiltRoll = rng.next();
  if (tiltRoll < 0.75) axialTilt = Math.abs(rng.gaussian(0, 22)) * DEG;
  else if (tiltRoll < 0.93) axialTilt = rng.range(0, 90) * DEG;
  else axialTilt = rng.range(90, 180) * DEG;
  const retrogradeSpin = !isGiant && rng.chance(0.08);
  if (retrogradeSpin) {
    rotationHours = rng.logNormal(2000, 0.8);
    axialTilt = rng.range(170, 180) * DEG;
  }
  const tLock = tidalLockTimeYears(sl.a, Math.abs(rotationHours), m, radius, M);
  let tidallyLocked = false;
  let spinOrbitResonance: string | null = null;
  if (tLock < SPIN_REFERENCE_AGE) {
    const orbitalHours = orbit.period * 365.25 * 24;
    if (orbit.e > 0.15) {
      rotationHours = (orbitalHours * 2) / 3; // Mercury-like 3:2 capture
      spinOrbitResonance = '3:2';
    } else {
      rotationHours = orbitalHours;
      tidallyLocked = true;
      spinOrbitResonance = '1:1';
    }
    axialTilt = rng.range(0, 2) * DEG;
  }

  // ---- interior --------------------------------------------------------------------------
  const tidalHeating = clamp((orbit.e * 0.04) / Math.pow(Math.max(0.005, sl.a), 1.5) * Math.sqrt(M), 0, 1);
  const geology0 = isGiant ? 0 : clamp(0.45 * Math.sqrt(m) * rng.logNormal(1, 0.35) + tidalHeating, 0, 1);
  let magneticField: number;
  if (sl.kind === 'gas-giant') magneticField = 14 * Math.pow(m / M_JUPITER_IN_EARTH, 0.8) * Math.pow(10 / rotationHours, 0.5);
  else if (sl.kind === 'ice-giant') magneticField = rng.range(0.3, 1.0);
  else {
    const spinFactor = Math.pow(24 / clamp(Math.abs(rotationHours), 4, 20000), 0.3);
    magneticField = clamp(Math.pow(m, 0.7) * spinFactor * (ironFraction / 0.32) * geology0 * 1.8, 0, 5);
  }

  // ---- atmosphere & climate ------------------------------------------------------------
  const exoT = teq0 * 4;
  const env: PlanetEnv = { pN2: 0, pCO2: 0, pCH4: 0, water: 0, forcing: 0, co2Locked: false, resourceBoost: 0 };
  let climate: ClimateResult;
  let atmosphere: Atmosphere;
  if (isGiant) {
    const tInt = sl.kind === 'gas-giant' ? 100 * Math.pow(m / M_JUPITER_IN_EARTH, 0.3) : 40;
    const ts = Math.pow(Math.pow(teq0 * 0.84, 4) + Math.pow(tInt, 4), 0.25);
    climate = {
      surfaceTemp: ts,
      equilibriumTemp: teq0 * 0.84,
      albedo: 0.34,
      greenhouseK: ts - teq0 * 0.84,
      pressure: 1,
      liquidWater: 0,
      ice: 0,
      clouds: 0.9,
      pCO2: 0,
      h2o: 0,
      boilingPoint: 373,
    };
    const iceGiant = sl.kind === 'ice-giant';
    atmosphere = { pressure: 1, n2: 0, o2: 0, co2: 0, h2o: 0.001, ch4: iceGiant ? 0.023 : 0.003, ar: 0, h2: iceGiant ? 0.8 : 0.86, he: iceGiant ? 0.176 : 0.136 };
  } else {
    const nonThermal = Math.exp((-0.02 * Math.sqrt(insolation)) / (Math.pow(m, 1.5) * (magneticField + 0.1)));
    const rN2 = retention(vEscape, exoT, 28) * nonThermal;
    const rCO2 = retention(vEscape, exoT, 44) * nonThermal;
    const rH2O = retention(vEscape, exoT, 18) * nonThermal;
    env.pN2 = Math.pow(m, 1.0) * rng.logNormal(0.8, 0.5) * rN2;
    env.pCO2 = Math.pow(m, 1.3) * rng.logNormal(60, 0.8) * (0.3 + geology0) * rCO2 * (composition === 'icy' ? 0.15 : 1);
    env.pCH4 = env.pN2 * 1e-6;
    env.water = (wmf / 0.00023) * m * rH2O;
    climate = solveClimate({ insolation, ...env, pO2: 0, geology: geology0 });
    // Runaway / moist greenhouse: water above the boiling point is photolysed and lost,
    // fastest without a magnetic field. Re-solve with the depleted inventory.
    if (climate.surfaceTemp > climate.boilingPoint && env.water > 0) {
      env.water *= magneticField > 0.5 ? 0.05 : 0.005;
      climate = solveClimate({ insolation, ...env, pO2: 0, geology: geology0 });
    }
    atmosphere = composeAtmosphere(env.pN2, climate, env.pCH4, 0);
  }

  // ---- classification & habitability -----------------------------------------------------
  const factors = habitabilityFactors(climate, geology0, star.feh, magneticField, ms.spectralClass, tidallyLocked, isGiant);
  const habitability = habitabilityIndex(factors);
  const type = classify(sl.kind, climate, geology0, tidalHeating, habitability);

  const resources = baseResources(rng, composition, sl.kind, density, star.feh, geology0, env.water, isGiant);

  const rings = isGiant && rng.chance(sl.kind === 'gas-giant' ? 0.35 : 0.5) ? { inner: 1.25, outer: rng.range(1.8, 2.4), opacity: rng.range(0.25, 0.85) } : null;

  const planet: Planet = {
    index: idx,
    id: planetId(star.g, star.s, idx),
    seed,
    massE: m,
    radiusE: radius,
    density,
    composition,
    ironFraction,
    waterMassFraction: wmf,
    orbit,
    axialTilt,
    rotationHours: retrogradeSpin && !tidallyLocked ? -rotationHours : rotationHours,
    tidallyLocked,
    spinOrbitResonance,
    formation: star.birth + PLANET_FORMATION_DELAY,
    insolation,
    vEscape,
    surfaceGravity,
    geology0,
    tidalHeating,
    magneticField,
    env,
    climate,
    atmosphere,
    type,
    habitability,
    habitabilityFactors: factors,
    resources,
    rings,
    moons: [],
  };
  void hz;
  if (opts.moons !== false) planet.moons = generateMoons(planet, star, snow);
  return planet;
}

/** Mole fractions from partial pressures. Biogenic O₂ is added on top of the abiotic column. */
export function composeAtmosphere(pN2: number, climate: ClimateResult, pCH4: number, pO2: number): Atmosphere {
  const P = climate.pressure + pO2;
  if (P <= 1e-9) return { pressure: 0, n2: 0, o2: 0, co2: 0, h2o: 0, ch4: 0, ar: 0, h2: 0, he: 0 };
  const h2o = climate.h2o;
  const dry = 1 - h2o;
  return {
    pressure: P,
    n2: (dry * pN2 * 0.988) / P,
    ar: (dry * pN2 * 0.012) / P,
    o2: (dry * pO2) / P,
    co2: (dry * climate.pCO2) / P,
    ch4: (dry * pCH4) / P,
    h2o,
    h2: 0,
    he: 0,
  };
}

export function habitabilityFactors(
  c: ClimateResult,
  geology: number,
  feh: number,
  magneticField: number,
  spectralClass: SpectralClass,
  locked: boolean,
  giant: boolean,
): HabitabilityFactors {
  if (giant) return { temperature: 0, water: 0, atmosphere: 0, energy: 0, geology: 0, chemistry: 0, magnetism: 0 };
  const T = c.surfaceTemp;
  const temperature = T < 240 || T > 365 ? 0 : gaussBell(T, 292, 28);
  const l = c.liquidWater;
  const water = l < 0.03 ? 0 : Math.min(1, l / 0.25) * (l > 0.92 ? 0.65 : 1);
  const P = c.pressure;
  const atmosphere = P < 0.05 ? 0 : Math.exp(-0.5 * (Math.log(P) / 1.6) ** 2);
  const energy = ENERGY_BY_CLASS[spectralClass] * (locked ? 0.75 : 1);
  const geo = clamp(1 - Math.abs(geology - 0.5) * 1.4, 0.15, 1);
  const chemistry = clamp(0.55 + 0.45 * Math.tanh(3 * (feh + 0.5)), 0.1, 1);
  const magnetism = 0.55 + 0.45 * Math.min(1, magneticField);
  return { temperature, water, atmosphere, energy, geology: geo, chemistry, magnetism };
}

/** Essential factors multiply directly; supporting factors enter with weaker (√) weight. */
export function habitabilityIndex(f: HabitabilityFactors): number {
  return clamp01(
    f.temperature * Math.sqrt(f.water) * Math.sqrt(f.atmosphere) * f.energy * Math.sqrt(f.geology) * Math.sqrt(f.chemistry) * Math.sqrt(f.magnetism),
  );
}

export function classify(kind: Slot['kind'], c: ClimateResult, geology0: number, tidalHeating: number, habitability: number): PlanetType {
  if (kind === 'gas-giant') return 'gas-giant';
  if (kind === 'ice-giant') return 'ice-giant';
  const T = c.surfaceTemp;
  if (T > 900 || (T > 260 && (geology0 > 0.85 || tidalHeating > 0.3) && c.liquidWater < 0.3)) return 'volcanic';
  if (habitability >= 0.4 && c.liquidWater < 0.92) return 'habitable';
  if (c.liquidWater > 0.85) return 'ocean';
  if (T < 235 || c.ice > 0.6) return 'frozen';
  if (c.liquidWater < 0.05) return 'desert';
  return 'terrestrial';
}

function baseResources(
  rng: Rng,
  composition: Composition,
  kind: Slot['kind'],
  density: number,
  feh: number,
  geology: number,
  water: number,
  giant: boolean,
): Resources {
  const metalRich = Math.pow(10, feh);
  if (giant) {
    return {
      metals: 0.05,
      rareElements: 0.02,
      silicates: 0.05,
      water: kind === 'ice-giant' ? 0.6 : 0.2,
      hydrocarbons: 0.4,
      radioactives: 0.02,
      volatiles: 1,
      helium3: kind === 'gas-giant' ? 0.9 : 0.6,
    };
  }
  return {
    metals: clamp01(0.25 + (density - 4) / 5 + 0.25 * Math.log10(metalRich + 0.1) + rng.gaussian(0, 0.08)),
    rareElements: clamp01(0.15 + 0.5 * geology * metalRich + rng.gaussian(0, 0.08)),
    silicates: composition === 'icy' ? 0.35 : clamp01(0.75 + rng.gaussian(0, 0.1)),
    water: clamp01(1 - Math.exp(-water)),
    hydrocarbons: 0, // biological origin — accrues with the duration of complex life (see life.ts)
    radioactives: clamp01(0.2 * metalRich + 0.2 * geology + rng.gaussian(0, 0.05)),
    volatiles: clamp01(composition === 'icy' ? 0.8 : 0.2 + rng.gaussian(0, 0.05)),
    helium3: clamp01(0.05 + rng.gaussian(0, 0.02)),
  };
}

export function generateMoons(p: Planet, star: StarInput, snow: number): Moon[] {
  const rng = new Rng(hash32(p.seed, 0x300a));
  const giant = p.composition === 'gaseous';
  let n: number;
  if (p.massE > 50) n = rng.int(2, 3) + rng.poisson(Math.log10(p.massE));
  else if (giant) n = rng.int(1, 4);
  else if (p.massE > 0.3) n = rng.chance(0.45) ? (rng.chance(0.3) ? 2 : 1) : 0;
  else n = rng.chance(0.25) ? 1 : 0;
  n = Math.min(n, 8);
  if (n === 0) return [];

  const planetMassSun = p.massE * EARTH_MASS_IN_SUN;
  const hill = hillRadius(p.orbit.a, p.orbit.e, planetMassSun, star.mass); // AU
  const rpAU = (p.radiusE * 6.371e6) / 1.495978707e11;
  const icy = p.orbit.a > snow;
  const moonDensity = icy ? 1.9 : 3.3;
  const roche = rocheLimit(rpAU, p.density, moonDensity);
  const rMin = Math.max(roche * 1.5, rpAU * 2.5);
  const rMax = hill * 0.4;
  if (rMax <= rMin * 1.4) return [];

  const as: number[] = [];
  let a = rMin * rng.logRange(1, 3);
  for (let k = 0; k < n && a < rMax; k++) {
    as.push(a);
    a *= rng.range(1.35, 2.4);
  }
  return as.map((am, k) => {
    const mm = giant ? p.massE * rng.logRange(2e-6, 8e-5) : p.massE * rng.logRange(1e-3, 0.015);
    const radius = Math.cbrt(mm / (moonDensity / 5.51));
    const aRp = am / rpAU;
    const kind: Moon['kind'] = giant && k === 0 && aRp < 8 ? 'volcanic' : icy ? 'icy' : 'rocky';
    const orbit: OrbitalElements = {
      a: am,
      e: rng.range(0, 0.04),
      i: rng.rayleigh(2 * DEG),
      node: rng.range(0, TAU),
      argPeri: rng.range(0, TAU),
      M0: rng.range(0, TAU),
      period: orbitalPeriodYears(am, planetMassSun + mm * EARTH_MASS_IN_SUN),
      precession: 0,
    };
    return { index: k, id: moonId(star.g, star.s, p.index, k), massE: mm, radiusE: radius, density: moonDensity, orbit, kind, aInPlanetRadii: aRp };
  });
}

/** Geological activity at time t: primordial + radiogenic heat decays; tidal heating persists. */
export function geologyAt(p: Planet, t: number): number {
  const age = Math.max(0, t - p.formation);
  const tau = 4e9 * Math.sqrt(Math.max(0.05, p.massE));
  return clamp01(Math.max(p.tidalHeating, (p.geology0 - p.tidalHeating) * Math.exp(-age / tau) + p.tidalHeating));
}
