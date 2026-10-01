import { clamp, clamp01 } from '../engine/core/math';
import { hash32 } from '../engine/core/rng';
import { Stage } from '../engine/life/life';
import { PlanetDynamic } from '../engine/sim/world';
import { iceLatitudeFor, seaLevelFor, terrainSeed } from '../engine/gen/terrain';
import { Moon } from '../engine/gen/planets';

export type RGB = [number, number, number];

/** Every visual parameter is derived from simulated state — no per-type canned textures. */
export interface PlanetLook {
  kind: 0 | 1 | 2;
  seed: number;
  seaLevel: number;
  iceLat: number;
  deep: RGB;
  shallow: RGB;
  low: RGB;
  high: RGB;
  peak: RGB;
  vegetation: number;
  lava: number;
  band1: RGB;
  band2: RGB;
  band3: RGB;
  storm: number;
  atmo: RGB;
  atmoStrength: number;
  clouds: number;
  cloudTint: RGB;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const seaCache = new Map<string, number>();
function cachedSeaLevel(seed: number, water: number): number {
  const q = Math.round(water * 200) / 200; // quantise so small changes reuse the computation
  const key = `${seed}:${q}`;
  let v = seaCache.get(key);
  if (v === undefined) {
    v = seaLevelFor(seed, q);
    if (seaCache.size > 512) seaCache.clear();
    seaCache.set(key, v);
  }
  return v;
}

export function planetLook(d: PlanetDynamic): PlanetLook {
  const p = d.planet;
  const seed = terrainSeed(p.seed);
  const T = d.climate.surfaceTemp;
  const look: PlanetLook = {
    kind: p.type === 'gas-giant' ? 1 : p.type === 'ice-giant' ? 2 : 0,
    seed,
    seaLevel: -1,
    iceLat: Math.PI,
    deep: [0.02, 0.06, 0.18],
    shallow: [0.05, 0.27, 0.42],
    low: [0.42, 0.38, 0.33],
    high: [0.52, 0.47, 0.41],
    peak: [0.72, 0.7, 0.68],
    vegetation: 0,
    lava: 0,
    band1: [0.8, 0.7, 0.55],
    band2: [0.6, 0.45, 0.32],
    band3: [0.95, 0.92, 0.85],
    storm: 0,
    atmo: [0.35, 0.6, 1],
    atmoStrength: 0,
    clouds: 0,
    cloudTint: [1, 1, 1],
  };

  if (look.kind === 1) {
    if (T > 900) {
      look.band1 = [0.35, 0.18, 0.12];
      look.band2 = [0.2, 0.1, 0.08];
      look.band3 = [0.55, 0.3, 0.18];
      look.atmo = [1, 0.5, 0.25];
    } else if (T > 250) {
      look.band1 = [0.72, 0.62, 0.48];
      look.band2 = [0.55, 0.42, 0.3];
      look.band3 = [0.9, 0.86, 0.78];
      look.atmo = [0.8, 0.7, 0.55];
    } else if (T > 110) {
      look.band1 = [0.86, 0.76, 0.58];
      look.band2 = [0.7, 0.55, 0.38];
      look.band3 = [0.96, 0.93, 0.85];
      look.atmo = [0.85, 0.75, 0.55];
    } else {
      look.band1 = [0.86, 0.8, 0.62];
      look.band2 = [0.78, 0.7, 0.52];
      look.band3 = [0.95, 0.92, 0.82];
      look.atmo = [0.9, 0.85, 0.65];
    }
    look.storm = (hash32(p.seed, 0x5704) % 100) / 100 > 0.45 ? 1 : 0;
    look.atmoStrength = 0.5;
    return look;
  }
  if (look.kind === 2) {
    const m = clamp01((T - 40) / 60);
    look.band1 = mix([0.5, 0.78, 0.86], [0.32, 0.55, 0.88], m);
    look.band2 = mix([0.42, 0.7, 0.8], [0.25, 0.45, 0.8], m);
    look.band3 = [0.7, 0.88, 0.92];
    look.atmo = [0.45, 0.8, 0.95];
    look.atmoStrength = 0.55;
    return look;
  }

  // ---- rocky worlds ------------------------------------------------------------------------
  const water = d.climate.liquidWater + d.climate.ice * 0.6;
  look.seaLevel = d.climate.liquidWater > 0.01 ? cachedSeaLevel(seed, Math.min(0.995, d.climate.liquidWater)) : -1;
  look.iceLat = d.climate.ice > 0.004 ? iceLatitudeFor(d.climate.ice) : Math.PI;
  if (d.climate.liquidWater < 0.01 && d.climate.ice > 0.3) look.iceLat = iceLatitudeFor(Math.min(1, d.climate.ice));

  const iron = p.ironFraction;
  if (d.type === 'volcanic' || T > 700) {
    look.low = [0.13, 0.11, 0.1];
    look.high = [0.2, 0.16, 0.15];
    look.peak = [0.32, 0.27, 0.25];
    look.lava = clamp01(Math.max(d.geology, (T - 600) / 600));
  } else if (T > 330 || d.type === 'desert') {
    const rust = clamp01((iron - 0.25) * 3 + (T < 260 ? 0.5 : 0));
    look.low = mix([0.66, 0.52, 0.34], [0.62, 0.34, 0.2], rust);
    look.high = mix([0.58, 0.42, 0.27], [0.5, 0.27, 0.17], rust);
    look.peak = mix([0.78, 0.68, 0.55], [0.7, 0.5, 0.4], rust);
  } else if (T < 235 || d.type === 'frozen') {
    look.low = [0.62, 0.66, 0.72];
    look.high = [0.7, 0.73, 0.78];
    look.peak = [0.88, 0.9, 0.94];
  } else {
    look.low = [0.42, 0.37, 0.3];
    look.high = [0.48, 0.42, 0.35];
    look.peak = [0.7, 0.68, 0.66];
  }
  // Biology paints the surface: microbial mats tint shallow seas; land plants green the continents.
  const stage = d.life.stage;
  look.vegetation = stage >= Stage.COMPLEX ? 1 : stage >= Stage.MULTI ? 0.55 : stage >= Stage.CELL ? 0.12 : 0;
  if (stage >= Stage.CELL) look.shallow = mix(look.shallow, [0.07, 0.32, 0.36], 0.4);
  if (T > 320 && water > 0) look.shallow = mix(look.shallow, [0.12, 0.35, 0.32], 0.3);

  const P = d.climate.pressure;
  const a = d.atmosphere;
  look.atmoStrength = P < 0.003 ? 0 : clamp(0.25 + 0.3 * Math.log10(P * 10 + 1), 0.08, 1.2);
  if (a.co2 > 0.5 && P > 3) {
    look.atmo = [0.95, 0.78, 0.48];
    look.cloudTint = [0.95, 0.88, 0.7];
  } else if (a.ch4 > 0.01) look.atmo = [0.45, 0.85, 0.9];
  else if (P < 0.05) look.atmo = [0.75, 0.55, 0.45];
  else look.atmo = [0.33, 0.58, 1];
  look.clouds = P > 0.05 ? clamp(d.climate.clouds, 0, 0.95) : 0;
  return look;
}

export function moonColor(m: Moon): RGB {
  if (m.kind === 'volcanic') return [0.85, 0.72, 0.3];
  if (m.kind === 'icy') return [0.82, 0.85, 0.9];
  return [0.55, 0.53, 0.5];
}
