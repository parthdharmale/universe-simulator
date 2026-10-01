import { Rng, hash32 } from '../core/rng';
import { Vec3, clamp } from '../core/math';
import { terrainHeight } from '../gen/terrain';
import { CivState, techLevel, totalPopulation } from './civilization';

/**
 * Geography of a civilization on its home world, derived from (planet terrain, civ seed,
 * civ state). Site *positions* are deterministic per civilization; how many sites are
 * active, how large they are, how many nations exist and what infrastructure stands are
 * functions of the current population, technology, stability and resources.
 */

export interface CitySite {
  dir: Vec3;
  lat: number;
  lon: number;
  coastal: boolean;
  score: number;
}

export interface City extends CitySite {
  index: number;
  size: number; // 0..1
  population: number;
  capital: boolean;
  nation: number;
  spaceport: boolean;
}

export interface Deposit {
  dir: Vec3;
  lat: number;
  lon: number;
  kind: 'metals' | 'hydrocarbons' | 'radioactives' | 'rare';
  richness: number;
}

export interface Infrastructure {
  kind: 'mill' | 'coal' | 'fission' | 'solar' | 'fusion' | 'beam';
  dir: Vec3;
  lat: number;
  lon: number;
}

export interface CivGeography {
  cities: City[];
  roads: [number, number][];
  nations: number;
  deposits: Deposit[];
  depletion: number;
  infrastructure: Infrastructure[];
}

const dirFromLatLon = (lat: number, lon: number): Vec3 => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];

/** Candidate settlement sites ranked by desirability (temperate, coastal, lowland). */
export function citySites(terrainSeed: number, seaLevel: number, civSeed: number, max = 64): CitySite[] {
  const rng = new Rng(hash32(civSeed, 0xc171));
  const out: CitySite[] = [];
  for (let tries = 0; tries < 900 && out.length < max * 3; tries++) {
    const lat = Math.asin(rng.range(-0.92, 0.92));
    const lon = rng.range(-Math.PI, Math.PI);
    const d = dirFromLatLon(lat, lon);
    const h = terrainHeight(d[0], d[1], d[2], terrainSeed);
    if (h <= seaLevel + 0.005) continue;
    // Coastal if any nearby sample is ocean.
    let coastal = false;
    for (let k = 0; k < 4 && !coastal; k++) {
      const dl = 0.06 * Math.cos((k * Math.PI) / 2), dn = 0.06 * Math.sin((k * Math.PI) / 2);
      const q = dirFromLatLon(lat + dl, lon + dn);
      if (terrainHeight(q[0], q[1], q[2], terrainSeed) < seaLevel) coastal = true;
    }
    const elev = (h - seaLevel) / Math.max(0.05, 1 - seaLevel);
    const score = (1 - Math.abs(lat) / 1.3) * 1.2 + (coastal ? 0.8 : 0) - elev * 1.5 + rng.next() * 0.4;
    // Keep sites apart.
    if (out.some((o) => o.dir[0] * d[0] + o.dir[1] * d[1] + o.dir[2] * d[2] > Math.cos(0.12))) continue;
    out.push({ dir: d, lat, lon, coastal, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

export function activeCityCount(c: CivState): number {
  const L = techLevel(c.tech);
  const pop = Math.max(1, c.population);
  const base = [2, 6, 14, 24, 32, 32, 32][L];
  return clamp(Math.round(base * clamp(Math.log10(pop) / 9.5, 0.35, 1.2) * (0.4 + 0.6 * c.territory)), 1, 32);
}

export function nationCount(c: CivState): number {
  const L = techLevel(c.tech);
  const rng = new Rng(hash32(c.seed, 0x7a7, L));
  if (L >= 4 && c.stability > 0.5) return 1;
  const range = [
    [4, 8],
    [4, 8],
    [3, 7],
    [2, 5],
    [1, 3],
    [1, 2],
    [1, 1],
  ][L];
  return rng.int(range[0], range[1]);
}

export function civGeography(c: CivState, sites: CitySite[], terrainSeed: number, seaLevel: number): CivGeography {
  const L = techLevel(c.tech);
  const n = Math.min(sites.length, activeCityCount(c));
  const nations = Math.min(n, nationCount(c));
  const pop = totalPopulation(c) > 0 ? c.population : 0;
  let zipf = 0;
  for (let i = 0; i < n; i++) zipf += 1 / (i + 1);
  const cities: City[] = [];
  for (let i = 0; i < n; i++) {
    const share = 1 / (i + 1) / zipf;
    cities.push({ ...sites[i], index: i, size: clamp(0.25 + Math.log10(Math.max(1, pop * share)) / 12, 0.15, 1), population: pop * share, capital: i < nations, nation: i < nations ? i : -1, spaceport: false });
  }
  // Each non-capital city belongs to the nearest capital (great-circle).
  for (const city of cities) {
    if (city.capital) continue;
    let best = 0, bd = -2;
    for (let k = 0; k < nations; k++) {
      const cap = cities[k];
      const dot = cap.dir[0] * city.dir[0] + cap.dir[1] * city.dir[1] + cap.dir[2] * city.dir[2];
      if (dot > bd) {
        bd = dot;
        best = k;
      }
    }
    city.nation = best;
  }
  // Roads: minimum spanning tree (Prim), plus redundant links once industrialised.
  const roads: [number, number][] = [];
  if (n > 1 && L >= 1) {
    const inTree = new Array(n).fill(false);
    const best = new Array(n).fill(Infinity);
    const parent = new Array(n).fill(-1);
    best[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v] < best[u])) u = v;
      inTree[u] = true;
      if (parent[u] >= 0) roads.push([parent[u], u]);
      for (let v = 0; v < n; v++) {
        if (inTree[v]) continue;
        const d = Math.acos(clamp(cities[u].dir[0] * cities[v].dir[0] + cities[u].dir[1] * cities[v].dir[1] + cities[u].dir[2] * cities[v].dir[2], -1, 1));
        if (d < best[v]) {
          best[v] = d;
          parent[v] = u;
        }
      }
    }
    if (L >= 2) for (let i = 2; i < n; i += 3) roads.push([i, Math.max(0, i - 2)]);
  }
  if (L >= 4) {
    const eq = cities
      .map((c2, i) => ({ i, lat: Math.abs(c2.lat) }))
      .sort((a, b) => a.lat - b.lat)
      .slice(0, Math.min(5, 1 + L - 4 + Math.floor(n / 10)));
    for (const e of eq) cities[e.i].spaceport = true;
  }

  // Resource deposits are a property of the planet (terrain seed), not the civ.
  const drng = new Rng(hash32(terrainSeed, 0xde9));
  const deposits: Deposit[] = [];
  for (let tries = 0; tries < 400 && deposits.length < 18; tries++) {
    const lat = Math.asin(drng.range(-0.95, 0.95));
    const lon = drng.range(-Math.PI, Math.PI);
    const d = dirFromLatLon(lat, lon);
    if (terrainHeight(d[0], d[1], d[2], terrainSeed) <= seaLevel) continue;
    deposits.push({ dir: d, lat, lon, kind: drng.pick(['metals', 'metals', 'hydrocarbons', 'radioactives', 'rare'] as const), richness: drng.range(0.3, 1) });
  }
  const depletion = c.resourcesMax > 0 ? clamp(1 - c.resources / c.resourcesMax, 0, 1) : 0;

  const infrastructure: Infrastructure[] = [];
  const irng = new Rng(hash32(c.seed, 0x1f5));
  const near = (base: { lat: number; lon: number }, spread: number) => {
    const lat = clamp(base.lat + irng.range(-spread, spread), -1.4, 1.4);
    const lon = base.lon + irng.range(-spread, spread);
    return { lat, lon, dir: dirFromLatLon(lat, lon) };
  };
  if (L === 1) for (let i = 0; i < Math.min(n, 6); i++) infrastructure.push({ kind: 'mill', ...near(cities[i], 0.05) });
  if (L >= 2) for (const dep of deposits.filter((x) => x.kind === 'hydrocarbons').slice(0, 5)) infrastructure.push({ kind: L >= 4 ? 'fusion' : 'coal', ...near(dep, 0.03) });
  if (L >= 3) for (let i = 0; i < Math.min(n, 8); i += 2) infrastructure.push({ kind: L >= 4 ? 'fusion' : 'fission', ...near(cities[i], 0.08) });
  if (L >= 3) for (let i = 0; i < Math.min(n, 6); i++) infrastructure.push({ kind: 'solar', ...near({ lat: irng.range(-0.5, 0.5), lon: irng.range(-Math.PI, Math.PI) }, 0.02) });
  if (L >= 5 && n > 0) for (let i = 0; i < 3; i++) infrastructure.push({ kind: 'beam', ...near(cities[i % n], 0.1) });
  return { cities, roads, nations, deposits, depletion, infrastructure };
}
