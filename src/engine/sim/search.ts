import { galaxyId, parseEntityId, planetId, speciesName, starId, moonId } from '../core/names';
import { Stage } from '../life/life';
import { TECH_NAMES, techLevel } from '../civ/civilization';
import { Simulation } from './simulation';
import { EntityKind, EntityRef } from './types';
import { hashForSpecies } from './describe';

export interface SearchResult {
  kind: EntityKind | 'species';
  label: string;
  lines: string[];
  ref: EntityRef;
  score: number;
}

const speciesCache = new WeakMap<object, Map<number, string>>();

function speciesFor(sim: Simulation, row: number, g: number, s: number, p: number): string {
  let m = speciesCache.get(sim.catalog!);
  if (!m) {
    m = new Map();
    speciesCache.set(sim.catalog!, m);
  }
  let name = m.get(row);
  if (!name) {
    name = speciesName(hashForSpecies(sim, g, s, p));
    m.set(row, name);
  }
  return name;
}

/**
 * Global search over galaxies, stars, planets, moons (by hierarchical ID — no index needed,
 * the ID encodes the path), civilizations (code, name) and species (intelligent life,
 * whether or not it has founded a civilization yet).
 */
export function search(sim: Simulation, query: string, limit = 24): SearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const out: SearchResult[] = [];
  const t = sim.now();
  const galName = (g: number) => sim.universe.galaxies[g]?.name ?? galaxyId(g);

  const id = parseEntityId(q);
  if (id && id.g < sim.universe.galaxies.length) {
    const g = id.g;
    if (id.s === undefined) out.push({ kind: 'galaxy', label: `${galName(g)}`, lines: [galaxyId(g), sim.universe.galaxies[g].type], ref: { kind: 'galaxy', g }, score: 100 });
    else if (id.s < sim.queries.starCount(g)) {
      const s = id.s;
      if (id.p === undefined) out.push({ kind: 'star', label: `Star ${starId(g, s)}`, lines: [`Galaxy: ${galName(g)}`], ref: { kind: 'star', g, s }, score: 100 });
      else {
        const sys = sim.queries.getSystem(g, s);
        const pl = sys?.planets[id.p];
        if (pl) {
          if (id.m === undefined) out.push({ kind: 'planet', label: `Planet ${planetId(g, s, id.p)}`, lines: [`Star: ${starId(g, s)}`, `Galaxy: ${galName(g)}`], ref: { kind: 'planet', g, s, p: id.p }, score: 100 });
          else if (pl.moons[id.m]) out.push({ kind: 'moon', label: `Moon ${moonId(g, s, id.p, id.m)}`, lines: [`Planet: ${planetId(g, s, id.p)}`, `Galaxy: ${galName(g)}`], ref: { kind: 'moon', g, s, p: id.p, m: id.m }, score: 100 });
        }
      }
    }
  }

  for (const gal of sim.universe.galaxies) {
    const n = gal.name.toLowerCase();
    if (n.includes(ql) || gal.id.toLowerCase() === ql) {
      out.push({ kind: 'galaxy', label: gal.name, lines: [`${gal.id} · ${gal.type}`, `${gal.starCount.toLocaleString('en-US')} catalog stars`], ref: { kind: 'galaxy', g: gal.index }, score: n.startsWith(ql) ? 80 : 60 });
    }
  }

  for (const c of sim.civs.civs) {
    if (c.born > t) continue;
    const code = c.code.toLowerCase();
    const hit = code === ql ? 95 : code.includes(ql) ? 75 : c.name.toLowerCase().includes(ql) ? 65 : c.species.toLowerCase().includes(ql) ? 55 : 0;
    if (!hit) continue;
    out.push({
      kind: 'civ',
      label: `Civilization ${c.code} · ${c.name}`,
      lines: [
        `Species: ${c.species}${c.alive ? '' : ' (extinct)'}`,
        `Planet: ${planetId(c.g, c.s, c.p)}`,
        `Star: ${starId(c.g, c.s)}`,
        `Galaxy: ${galName(c.g)}`,
        c.alive ? `Technology: ${TECH_NAMES[techLevel(c.tech)]}` : `Ended: ${c.endCause}`,
      ],
      ref: { kind: 'civ', civ: c.id },
      score: hit + (c.alive ? 5 : 0),
    });
  }

  if (sim.catalog && ql.length >= 2) {
    for (const rec of sim.catalog.life) {
      if (!(rec.t[Stage.INTEL] <= t)) continue;
      const sp = speciesFor(sim, rec.row, rec.g, rec.s, rec.p);
      if (!sp.toLowerCase().includes(ql)) continue;
      // Skip species already listed through their civilization.
      if (out.some((r) => r.kind === 'civ' && r.lines[0].toLowerCase().includes(sp.toLowerCase()))) continue;
      const alive = t < rec.end;
      out.push({
        kind: 'species',
        label: `Species ${sp}`,
        lines: [`Planet: ${planetId(rec.g, rec.s, rec.p)}`, `Star: ${starId(rec.g, rec.s)}`, `Galaxy: ${galName(rec.g)}`, alive ? 'Intelligent, pre-civilization or civilized' : 'Extinct'],
        ref: { kind: 'planet', g: rec.g, s: rec.s, p: rec.p },
        score: sp.toLowerCase().startsWith(ql) ? 50 : 40,
      });
    }
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, limit);
}
