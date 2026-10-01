import { Rng } from '../core/rng';
import { T_SUN } from '../core/constants';
import { clamp } from '../core/math';

/**
 * Main-sequence stellar relations, all in solar units, derived from mass alone
 * (with a mild metallicity correction). Standard textbook fits:
 *
 *   L ∝ M^2.3 (M<0.43), M^4 (<2), 1.4·M^3.5 (<55), 32000·M (≥55)
 *   R ∝ M^0.8 (M<1), M^0.57 (M≥1)
 *   T = T☉ · (L / R²)^¼                      (Stefan–Boltzmann)
 *   t_MS = 10 Gyr · M / L                     (fuel ∝ M, burn rate ∝ L)
 *
 * So a 10 M☉ B star burns ~3000× brighter and dies after ~30 Myr, while a 0.2 M☉
 * M dwarf outlives the present universe by orders of magnitude.
 */

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';
export const SPECTRAL_CLASSES: SpectralClass[] = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];

export function luminosityFromMass(m: number, feh = 0): number {
  let l: number;
  if (m < 0.43) l = 0.23 * Math.pow(m, 2.3);
  else if (m < 2) l = Math.pow(m, 4);
  else if (m < 55) l = 1.4 * Math.pow(m, 3.5);
  else l = 32000 * m;
  // Metal-poor stars are slightly hotter/brighter at fixed mass (lower opacity).
  return l * Math.pow(10, -0.1 * feh);
}

export function radiusFromMass(m: number): number {
  return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
}

export function temperatureFrom(l: number, r: number): number {
  return T_SUN * Math.pow(l / (r * r), 0.25);
}

/** Main-sequence lifetime in years. */
export function lifetimeFromMass(m: number, feh = 0): number {
  return 1e10 * m / luminosityFromMass(m, feh);
}

export function spectralClassFromTemp(t: number): SpectralClass {
  if (t >= 30000) return 'O';
  if (t >= 10000) return 'B';
  if (t >= 7500) return 'A';
  if (t >= 6000) return 'F';
  if (t >= 5200) return 'G';
  if (t >= 3700) return 'K';
  return 'M';
}

const CLASS_RANGES: Record<SpectralClass, [number, number]> = {
  O: [30000, 52000],
  B: [10000, 30000],
  A: [7500, 10000],
  F: [6000, 7500],
  G: [5200, 6000],
  K: [3700, 5200],
  M: [2300, 3700],
};

/** Full designation, e.g. "G2V". Subclass 0 = hottest within the class. */
export function spectralType(t: number): string {
  const c = spectralClassFromTemp(t);
  const [lo, hi] = CLASS_RANGES[c];
  const sub = clamp(Math.floor(((hi - t) / (hi - lo)) * 10), 0, 9);
  return `${c}${sub}V`;
}

/**
 * Kroupa (2001) IMF by inverse-transform sampling of a broken power law:
 *   dN/dM ∝ M^-1.3 for 0.08–0.5 M☉, M^-2.3 for 0.5–100 M☉.
 */
export function sampleKroupaMass(rng: Rng): number {
  const m0 = 0.08, m1 = 0.5, m2 = 100;
  const a1 = 1.3, a2 = 2.3;
  // Integrals of each segment (continuity factor m1^(a2-a1) on the upper segment).
  const k2 = Math.pow(m1, a2 - a1);
  const I1 = (Math.pow(m1, 1 - a1) - Math.pow(m0, 1 - a1)) / (1 - a1);
  const I2 = (k2 * (Math.pow(m2, 1 - a2) - Math.pow(m1, 1 - a2))) / (1 - a2);
  const u = rng.next() * (I1 + I2);
  if (u < I1) {
    return Math.pow(Math.pow(m0, 1 - a1) + u * (1 - a1), 1 / (1 - a1));
  }
  const u2 = (u - I1) / k2;
  return Math.pow(Math.pow(m1, 1 - a2) + u2 * (1 - a2), 1 / (1 - a2));
}

export type StarPhase = 'unborn' | 'protostar' | 'main-sequence' | 'red-giant' | 'white-dwarf' | 'neutron-star' | 'black-hole' | 'destroyed';

/** Fraction of the MS lifetime spent as a giant after leaving the main sequence. */
export const GIANT_FRACTION = 0.1;

export interface StarCore {
  mass: number;
  feh: number;
  birth: number;
  /** End of the main sequence (years since Big Bang). */
  msEnd: number;
  /** End of the giant phase → remnant. */
  death: number;
}

export function starTimeline(mass: number, feh: number, birth: number): StarCore {
  const life = lifetimeFromMass(mass, feh);
  return { mass, feh, birth, msEnd: birth + life, death: birth + life * (1 + GIANT_FRACTION) };
}

export function remnantType(mass: number): StarPhase {
  if (mass >= 25) return 'black-hole';
  if (mass >= 8) return 'neutron-star';
  return 'white-dwarf';
}

export function starPhaseAt(core: StarCore, t: number, destroyedAt?: number): StarPhase {
  if (destroyedAt !== undefined && t >= destroyedAt) return 'destroyed';
  if (t < core.birth) return 'unborn';
  if (t < core.birth + 1e6 * Math.max(0.05, 1 / core.mass)) return 'protostar';
  if (t < core.msEnd) return 'main-sequence';
  if (t < core.death) return 'red-giant';
  return remnantType(core.mass);
}

export interface StarProps {
  luminosity: number;
  radius: number;
  temperature: number;
  spectral: string;
  spectralClass: SpectralClass;
  lifetime: number;
}

export function mainSequenceProps(mass: number, feh: number): StarProps {
  const luminosity = luminosityFromMass(mass, feh);
  const radius = radiusFromMass(mass);
  const temperature = temperatureFrom(luminosity, radius);
  return {
    luminosity,
    radius,
    temperature,
    spectral: spectralType(temperature),
    spectralClass: spectralClassFromTemp(temperature),
    lifetime: lifetimeFromMass(mass, feh),
  };
}

/** Observable properties at time t, including post-main-sequence evolution. */
export function starPropsAt(core: StarCore, t: number, destroyedAt?: number): StarProps & { phase: StarPhase } {
  const ms = mainSequenceProps(core.mass, core.feh);
  const phase = starPhaseAt(core, t, destroyedAt);
  if (phase === 'main-sequence' || phase === 'unborn') {
    // Main-sequence brightening: L grows ~40% over the MS lifetime (the young Sun was dimmer).
    // Centred so the time-average equals the fit luminosity, which is what planetary
    // climate uses (see planets.ts: climate is solved for time-averaged insolation).
    const f = clamp((t - core.birth) / (core.msEnd - core.birth), 0, 1);
    const l = ms.luminosity * (0.8 + 0.4 * f);
    const r = ms.radius * (0.9 + 0.15 * f);
    const temp = temperatureFrom(l, r);
    return { ...ms, luminosity: l, radius: r, temperature: temp, spectral: spectralType(temp), phase };
  }
  if (phase === 'protostar') {
    return { ...ms, luminosity: ms.luminosity * 3, radius: ms.radius * 2.5, temperature: ms.temperature * 0.75, phase };
  }
  if (phase === 'red-giant') {
    const f = clamp((t - core.msEnd) / (core.death - core.msEnd), 0, 1);
    const l = ms.luminosity * (10 + 1000 * f * f) * Math.min(1, 3 / core.mass + 0.2);
    const r = ms.radius * (10 + 140 * f);
    const temp = temperatureFrom(l, r);
    return { ...ms, luminosity: l, radius: r, temperature: temp, spectral: spectralType(temp).replace('V', 'III'), phase };
  }
  if (phase === 'white-dwarf') {
    const cool = Math.max(1, (t - core.death) / 1e8);
    const temp = 25000 / Math.pow(cool, 0.35) + 3000;
    return { ...ms, luminosity: 0.01 / cool, radius: 0.012, temperature: temp, spectral: 'DA', phase };
  }
  if (phase === 'neutron-star') return { ...ms, luminosity: 1e-4, radius: 1.6e-5, temperature: 600000, spectral: 'NS', phase };
  if (phase === 'black-hole') return { ...ms, luminosity: 0, radius: 3e-5 * core.mass, temperature: 0, spectral: 'BH', phase };
  return { ...ms, luminosity: 0, radius: 0, temperature: 0, spectral: '—', phase };
}

/** Approximate blackbody → sRGB for star colouring (Tanner Helland fit). */
export function blackbodyRGB(tempK: number): [number, number, number] {
  const t = clamp(tempK, 1000, 40000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
}
