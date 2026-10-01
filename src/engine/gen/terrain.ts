import { hash32 } from '../core/rng';
import { clamp01 } from '../core/math';

/**
 * Planet terrain field, implemented twice — here (for the 2-D civilization map and sea-level
 * calibration) and in GLSL (render/shaders/noise.ts) for the 3-D globe — with the *same*
 * integer lattice hash (uint32 multiply-xorshift, Math.imul ≡ GLSL uint *), so both views
 * show the same continents.
 */

function latticeHash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f) ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = quintic(fx), uy = quintic(fy), uz = quintic(fz);
  const n000 = latticeHash(ix, iy, iz, seed);
  const n100 = latticeHash(ix + 1, iy, iz, seed);
  const n010 = latticeHash(ix, iy + 1, iz, seed);
  const n110 = latticeHash(ix + 1, iy + 1, iz, seed);
  const n001 = latticeHash(ix, iy, iz + 1, seed);
  const n101 = latticeHash(ix + 1, iy, iz + 1, seed);
  const n011 = latticeHash(ix, iy + 1, iz + 1, seed);
  const n111 = latticeHash(ix + 1, iy + 1, iz + 1, seed);
  const x00 = n000 + (n100 - n000) * ux;
  const x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux;
  const x11 = n011 + (n111 - n011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

export function fbm3(x: number, y: number, z: number, seed: number, octaves = 6): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, (seed + o * 1013) >>> 0);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Terrain height in [0,1] at unit-sphere direction (x,y,z). */
export function terrainHeight(x: number, y: number, z: number, seed: number): number {
  const s = 1.7;
  // Domain warp gives continents irregular, organic coastlines.
  const wx = fbm3(x * 1.1 + 5.2, y * 1.1 + 1.3, z * 1.1 + 7.7, seed ^ 0x51, 3);
  const wy = fbm3(x * 1.1 + 2.8, y * 1.1 + 9.1, z * 1.1 + 3.4, seed ^ 0x52, 3);
  const base = fbm3(x * s + (wx - 0.5) * 1.2, y * s + (wy - 0.5) * 1.2, z * s, seed, 6);
  return clamp01((base - 0.5) * 1.6 + 0.5);
}

export interface TerrainParams {
  seed: number;
  seaLevel: number;
  /** |latitude| (radians) beyond which permanent ice caps lie. */
  iceLatitude: number;
}

/**
 * Sea level such that the requested fraction of the sphere lies below it. Computed from a
 * deterministic Fibonacci-sphere sample of the same height field the shader evaluates.
 */
export function seaLevelFor(seed: number, waterFraction: number, samples = 1500): number {
  if (waterFraction <= 0.001) return -1;
  if (waterFraction >= 0.999) return 2;
  const hs = new Float64Array(samples);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    const r = Math.sqrt(1 - y * y);
    const th = ga * i;
    hs[i] = terrainHeight(Math.cos(th) * r, y, Math.sin(th) * r, seed);
  }
  hs.sort();
  return hs[Math.min(samples - 1, Math.floor(waterFraction * samples))];
}

/** Two polar caps covering fraction f of the sphere start at latitude asin(1 − f). */
export const iceLatitudeFor = (iceFraction: number) => Math.asin(Math.max(-1, Math.min(1, 1 - Math.min(1, iceFraction))));

export const terrainSeed = (planetSeed: number) => hash32(planetSeed, 0x7e44) & 0x7fffffff;
