import { Rng, hash32 } from '../core/rng';
import { Vec3, basisFromNormal, clamp, TAU, vNorm } from '../core/math';
import { MAX_YEARS, PRESENT_YEARS } from '../core/constants';
import { galaxyName, galaxyId } from '../core/names';
import { GIANT_FRACTION, lifetimeFromMass, luminosityFromMass, radiusFromMass, sampleKroupaMass, temperatureFrom } from './star';

/**
 * Universe → galaxies → star catalogs.
 *
 * Galaxies are few (~100) and generated eagerly as plain objects.
 * Stars are many (10⁵–10⁶) and stored per galaxy as a structure-of-arrays of typed arrays
 * (`StarCatalog`), ~52 bytes per star, never as individual JS objects. A star's identity is
 * (galaxy index, catalog index); its RNG seed is hash32(galaxy.seed, index), so any star
 * can be regenerated independently. Planetary systems are not stored at all — they are a
 * pure function of the star seed and are generated lazily (and cached) when needed.
 */

export type GalaxyType = 'spiral' | 'elliptical' | 'irregular';

export interface UniverseConfig {
  seed: number;
  galaxyCount: number;
  /** Multiplier on catalog stars per galaxy (1 = default ≈ 3.5k average). */
  starDensity: number;
}

export const DEFAULT_CONFIG: UniverseConfig = { seed: 847291, galaxyCount: 128, starDensity: 1 };

export interface Clump {
  x: number;
  z: number;
  sigma: number;
  weight: number;
}

export interface Galaxy {
  index: number;
  id: string;
  name: string;
  seed: number;
  type: GalaxyType;
  environment: 'cluster' | 'filament' | 'field';
  /** Comoving position (kpc); physical position = position × a(t). */
  position: Vec3;
  /** Unit normal of the galactic plane and in-plane basis (local x → u, y → normal, z → v). */
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  radius: number; // kpc
  mass: number; // M☉ (stellar)
  starCount: number;
  formation: number; // years since Big Bang
  metallicity: number; // [Fe/H] of present-day stars
  arms: number;
  pitch: number; // rad
  armWidth: number;
  bulgeFraction: number;
  barLength: number; // kpc, 0 if unbarred
  axisRatios: [number, number]; // ellipticals
  clumps: Clump[]; // irregulars
  /** Pattern rotation rate (rad/yr). Density-wave approximation: the star pattern rotates rigidly. */
  patternSpeed: number;
  phase0: number;
  sfTau: number;
}

export interface StarCatalog {
  galaxy: number;
  count: number;
  /** Galaxy-local position (kpc). Plane = x–z, y = along the normal. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  mass: Float32Array;
  feh: Float32Array;
  birth: Float64Array;
  msEnd: Float64Array;
  death: Float64Array;
  lum: Float32Array;
  temp: Float32Array;
}

export interface Universe {
  config: UniverseConfig;
  galaxies: Galaxy[];
  totalStars: number;
}

export const starSeed = (galaxySeed: number, index: number) => hash32(galaxySeed, index, 0x5ad);

export function generateUniverse(config: UniverseConfig): Universe {
  const rng = new Rng(hash32(config.seed, 0xc05));
  // ---- cosmic web skeleton: clusters joined by filaments ----
  const clusterCount = 5 + rng.int(0, 4);
  const clusters: Vec3[] = [];
  for (let k = 0; k < clusterCount; k++) clusters.push(randomInSphere(rng, 2000));
  // Each cluster connects to its two nearest neighbours (deduplicated).
  const filaments: [Vec3, Vec3][] = [];
  const seen = new Set<string>();
  for (let k = 0; k < clusters.length; k++) {
    const others = clusters
      .map((c, j) => ({ j, d: dist(c, clusters[k]) }))
      .filter((o) => o.j !== k)
      .sort((p, q) => p.d - q.d);
    for (const o of others.slice(0, 2)) {
      const key = k < o.j ? `${k}-${o.j}` : `${o.j}-${k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filaments.push([clusters[k], clusters[o.j]]);
    }
  }

  const galaxies: Galaxy[] = [];
  let totalStars = 0;
  for (let i = 0; i < config.galaxyCount; i++) {
    const seed = hash32(config.seed, 0x6a1, i);
    const g = new Rng(seed);
    const envRoll = g.next();
    const environment: Galaxy['environment'] = envRoll < 0.35 ? 'cluster' : envRoll < 0.8 ? 'filament' : 'field';
    const typeWeights =
      environment === 'cluster' ? [0.3, 0.5, 0.2] : environment === 'filament' ? [0.6, 0.2, 0.2] : [0.55, 0.15, 0.3];
    const type = g.weighted<GalaxyType>(['spiral', 'elliptical', 'irregular'], typeWeights);

    const mass =
      type === 'spiral' ? g.logRange(8e9, 6e11) : type === 'elliptical' ? g.logRange(2e9, 3e12) : g.logRange(1e8, 1.5e10);
    const radius =
      type === 'spiral'
        ? 15 * Math.pow(mass / 1e11, 0.33) * g.range(0.8, 1.2)
        : type === 'elliptical'
          ? 10 * Math.pow(mass / 1e11, 0.4) * g.range(0.8, 1.2)
          : 4 * Math.pow(mass / 1e9, 0.3) * g.range(0.7, 1.3);

    // Position: rejection-sample against overlaps.
    let position: Vec3 = [0, 0, 0];
    for (let tries = 0; tries < 40; tries++) {
      if (environment === 'cluster') {
        const c = clusters[g.int(0, clusters.length - 1)];
        position = [c[0] + g.gaussian(0, 220), c[1] + g.gaussian(0, 220), c[2] + g.gaussian(0, 220)];
      } else if (environment === 'filament' && filaments.length > 0) {
        const [a, b] = filaments[g.int(0, filaments.length - 1)];
        const t = g.next();
        position = [a[0] + (b[0] - a[0]) * t + g.gaussian(0, 110), a[1] + (b[1] - a[1]) * t + g.gaussian(0, 110), a[2] + (b[2] - a[2]) * t + g.gaussian(0, 110)];
      } else {
        position = randomInSphere(g, 2600);
      }
      if (galaxies.every((o) => dist(o.position, position) > (o.radius + radius) * 2.5)) break;
    }

    const normal = vNorm([g.gaussian(), g.gaussian(), g.gaussian()]);
    const { u, v } = basisFromNormal(normal);
    const formation =
      type === 'elliptical' ? g.range(4e8, 1.5e9) : type === 'spiral' ? g.range(6e8, 3e9) : g.range(1e9, 6e9);
    const metallicity = clamp(-0.55 + 0.3 * Math.log10(mass / 1e10) + (type === 'elliptical' ? 0.15 : 0) + g.gaussian(0, 0.1), -1.6, 0.45);
    const starCount = Math.round(clamp(3500 * Math.pow(mass / 5e10, 0.3) * g.range(0.85, 1.15), 1200, 11000) * config.starDensity);
    totalStars += starCount;

    const arms = type === 'spiral' ? g.weighted([2, 3, 4], [0.55, 0.25, 0.2]) : 0;
    const clumps: Clump[] = [];
    if (type === 'irregular') {
      const n = g.int(3, 7);
      for (let k = 0; k < n; k++)
        clumps.push({ x: g.gaussian(0, radius * 0.35), z: g.gaussian(0, radius * 0.35), sigma: radius * g.range(0.08, 0.28), weight: g.range(0.3, 1) });
    }
    galaxies.push({
      index: i,
      id: galaxyId(i),
      name: galaxyName(seed, type),
      seed,
      type,
      environment,
      position,
      normal,
      u,
      v,
      radius,
      mass,
      starCount,
      formation,
      metallicity,
      arms,
      pitch: g.range(11, 28) * (Math.PI / 180),
      armWidth: g.range(0.18, 0.4),
      bulgeFraction: type === 'spiral' ? g.range(0.08, 0.3) : 0,
      barLength: type === 'spiral' && g.chance(0.4) ? radius * g.range(0.12, 0.3) : 0,
      axisRatios: type === 'elliptical' ? [g.range(0.55, 1), g.range(0.45, 1)] : [1, 1],
      clumps,
      patternSpeed: (type === 'spiral' ? -TAU / g.range(2e8, 4e8) : type === 'elliptical' ? -TAU / g.range(8e8, 2e9) : -TAU / g.range(4e8, 8e8)) * (g.chance(0.5) ? 1 : -1),
      phase0: g.range(0, TAU),
      sfTau: type === 'elliptical' ? g.range(5e8, 1e9) : type === 'spiral' ? g.range(5e9, 9e9) : g.range(2.5e9, 5e9),
    });
  }
  return { config, galaxies, totalStars };
}

function randomInSphere(rng: Rng, r: number): Vec3 {
  for (;;) {
    const p: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= 1) return [p[0] * r, p[1] * r, p[2] * r];
  }
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Truncated exponential star-formation history on [t0, t1]. */
function sampleBirth(rng: Rng, t0: number, t1: number, tau: number): number {
  const span = t1 - t0;
  const u = rng.next();
  return t0 - tau * Math.log(1 - u * (1 - Math.exp(-span / tau)));
}

/**
 * Generate the full star catalog for one galaxy. Each star uses its own RNG stream
 * (seeded from galaxy seed + index), so catalog generation is order-independent and
 * parallelisable across workers.
 */
export function generateStarCatalog(gal: Galaxy): StarCatalog {
  const n = gal.starCount;
  const cat: StarCatalog = {
    galaxy: gal.index,
    count: n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    mass: new Float32Array(n),
    feh: new Float32Array(n),
    birth: new Float64Array(n),
    msEnd: new Float64Array(n),
    death: new Float64Array(n),
    lum: new Float32Array(n),
    temp: new Float32Array(n),
  };
  const R = gal.radius;
  const totalClumpW = gal.clumps.reduce((s, c) => s + c.weight, 0);
  for (let i = 0; i < n; i++) {
    const rng = new Rng(starSeed(gal.seed, i));
    let x = 0, y = 0, z = 0;
    let birth: number;
    if (gal.type === 'spiral') {
      const roll = rng.next();
      if (roll < gal.bulgeFraction) {
        // Hernquist-like bulge of old stars.
        birth = sampleBirth(rng, gal.formation, MAX_YEARS, 1.2e9);
        const a = 0.07 * R;
        const s = Math.sqrt(rng.next());
        const r = Math.min(R * 0.5, (a * s) / Math.max(0.02, 1 - s));
        const d = randomDir(rng);
        x = d[0] * r;
        y = d[1] * r * 0.6;
        z = d[2] * r;
      } else if (gal.barLength > 0 && roll < gal.bulgeFraction + 0.08) {
        birth = sampleBirth(rng, gal.formation, MAX_YEARS, gal.sfTau * 0.6);
        x = rng.range(-gal.barLength, gal.barLength);
        z = rng.gaussian(0, gal.barLength * 0.13);
        y = rng.gaussian(0, 0.15 * (R / 15));
      } else {
        birth = sampleBirth(rng, gal.formation + 3e8, MAX_YEARS, gal.sfTau);
        // Exponential disk: radius ~ Gamma(2, Rd).
        const Rd = R / 3.4;
        const r = Math.min(R * 1.25, -Rd * Math.log(Math.max(1e-9, rng.next() * rng.next())));
        // Young stars trace the arms tightly (density-wave star formation).
        const ageAtPresent = PRESENT_YEARS - birth;
        const armProb = 0.55 + 0.4 * Math.exp(-Math.max(0, ageAtPresent) / 2e9);
        let theta: number;
        if (rng.next() < armProb && r > gal.barLength * 0.8) {
          const k = rng.int(0, gal.arms - 1);
          const r0 = Math.max(0.5, gal.barLength || R * 0.08);
          const spread = gal.armWidth * (ageAtPresent < 3e8 ? 0.45 : 1);
          theta = (TAU * k) / gal.arms + Math.log(Math.max(r, r0) / r0) / Math.tan(gal.pitch) + rng.gaussian(0, spread);
        } else {
          theta = rng.range(0, TAU);
        }
        x = r * Math.cos(theta);
        z = r * Math.sin(theta);
        const h = 0.22 * (R / 15) * (1 + r / R) * (ageAtPresent < 1e9 ? 0.5 : 1);
        y = rng.gaussian(0, h);
      }
    } else if (gal.type === 'elliptical') {
      birth = sampleBirth(rng, gal.formation, MAX_YEARS, gal.sfTau);
      // Plummer sphere, stretched into a triaxial ellipsoid.
      const a = R / 3;
      const u = Math.max(1e-6, rng.next());
      const r = Math.min(R * 1.4, a / Math.sqrt(Math.pow(u, -2 / 3) - 1));
      const d = randomDir(rng);
      x = d[0] * r;
      y = d[1] * r * gal.axisRatios[1];
      z = d[2] * r * gal.axisRatios[0];
    } else {
      const bursty = rng.chance(0.2);
      birth = bursty
        ? sampleBirth(rng, Math.max(gal.formation, PRESENT_YEARS - 2e9), MAX_YEARS, 1.5e9)
        : sampleBirth(rng, gal.formation, MAX_YEARS, gal.sfTau);
      if (rng.chance(0.7) && gal.clumps.length) {
        let w = rng.next() * totalClumpW;
        let c = gal.clumps[0];
        for (const cl of gal.clumps) {
          w -= cl.weight;
          if (w < 0) {
            c = cl;
            break;
          }
        }
        x = c.x + rng.gaussian(0, c.sigma);
        z = c.z + rng.gaussian(0, c.sigma);
        y = rng.gaussian(0, c.sigma * 0.5);
      } else {
        x = rng.gaussian(0, R * 0.45);
        z = rng.gaussian(0, R * 0.45);
        y = rng.gaussian(0, R * 0.2);
      }
    }
    const mass = sampleKroupaMass(rng);
    // Chemical enrichment: later generations are more metal-rich; disks have a radial gradient.
    const r2d = Math.hypot(x, z);
    const feh = clamp(
      gal.metallicity - 0.7 * Math.exp(-(birth - gal.formation) / 3e9) + 0.25 - (gal.type === 'spiral' ? 0.04 * (r2d - R * 0.3) : 0) + rng.gaussian(0, 0.15),
      -2.5,
      0.6,
    );
    const L = luminosityFromMass(mass, feh);
    const life = lifetimeFromMass(mass, feh);
    cat.x[i] = x;
    cat.y[i] = y;
    cat.z[i] = z;
    cat.mass[i] = mass;
    cat.feh[i] = feh;
    cat.birth[i] = birth;
    cat.msEnd[i] = birth + life;
    cat.death[i] = birth + life * (1 + GIANT_FRACTION);
    cat.lum[i] = L;
    cat.temp[i] = temperatureFrom(L, radiusFromMass(mass));
  }
  return cat;
}

function randomDir(rng: Rng): Vec3 {
  const z = rng.range(-1, 1);
  const t = rng.range(0, TAU);
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), z, s * Math.sin(t)];
}

/** Galaxy pattern rotation angle at time t (rad, wrapped). */
export function galaxyAngle(gal: Galaxy, t: number): number {
  const a = gal.phase0 + gal.patternSpeed * Math.max(0, t - gal.formation);
  return a - TAU * Math.floor(a / TAU);
}

/** Galaxy-local → world-offset (kpc) at rotation angle `ang` (rotation about the local y axis). */
export function localToWorldOffset(gal: Galaxy, lx: number, ly: number, lz: number, ang: number, out: Vec3): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const rx = lx * c - lz * s;
  const rz = lx * s + lz * c;
  out[0] = gal.u[0] * rx + gal.normal[0] * ly + gal.v[0] * rz;
  out[1] = gal.u[1] * rx + gal.normal[1] * ly + gal.v[1] * rz;
  out[2] = gal.u[2] * rx + gal.normal[2] * ly + gal.v[2] * rz;
  return out;
}
