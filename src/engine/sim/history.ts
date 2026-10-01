import { PLANET_FORMATION_DELAY } from '../core/constants';
import { fmtCompact, fmtNum } from '../core/format';
import { planetId, starId } from '../core/names';
import { STAGE_NAMES, Stage, BASE_DURATION } from '../life/life';
import { TECH_NAMES } from '../civ/civilization';
import { Simulation } from './simulation';
import { EntityRef } from './types';
import { Tone } from './describe';

export interface HistoryEffect {
  label: string;
  before: string;
  after: string;
}

export interface HistoryEntry {
  t: number;
  title: string;
  /** What happened and why (shown when the entry is clicked). */
  detail: string;
  effects: HistoryEffect[];
  tone: Tone;
  ref?: EntityRef;
}

const STAGE_DETAIL: Record<number, string> = {
  [Stage.CHEM]: 'Organic chemistry in the oceans begins building complex molecules — amino acids, lipids and nucleotides accumulate in warm, energy-rich environments.',
  [Stage.REPL]: 'Self-copying molecules appear. From here on, natural selection operates: the planet is formally life-bearing.',
  [Stage.CELL]: 'Membranes enclose metabolisms: true cells emerge. Photosynthesis will eventually oxygenate the atmosphere.',
  [Stage.MULTI]: 'Cells cooperate and specialise; multicellular organisms appear, enabled by an oxygen-rich atmosphere.',
  [Stage.COMPLEX]: 'Complex body plans, nervous systems and ecosystems radiate across land and sea.',
  [Stage.INTEL]: 'A lineage crosses the threshold to abstract thought, language and tool use.',
  [Stage.CIV]: 'Permanent settlements form; a civilization begins (handled by the civilization engine).',
};

function fmtEffect(key: string, v: number): string {
  if (key === 'stability' || key === 'territory') return `${(v * 100).toFixed(0)}%`;
  if (key === 'tech' || key === 'techLevel') return v.toFixed(2);
  if (key === 'resources' && v <= 300) return `${v.toFixed(0)}%`;
  return fmtCompact(v);
}

export function historyOf(sim: Simulation, ref: EntityRef): HistoryEntry[] {
  const now = sim.now();
  const out: HistoryEntry[] = [];
  const ivEntries = (pred: (iv: (typeof sim.interventions)[number]) => boolean) => {
    for (const iv of sim.interventions) {
      if (!pred(iv) || iv.t > now) continue;
      out.push({
        t: iv.t,
        title: `⚠ ${iv.label}`,
        detail: `User intervention. ${sim.describeTarget(iv.target)} was modified.`,
        effects: [{ label: iv.label, before: iv.previous, after: iv.next }],
        tone: 'warn',
      });
    }
  };

  if (ref.kind === 'galaxy') {
    const gal = sim.universe.galaxies[ref.g!];
    out.push({ t: gal.formation, title: 'Formation', detail: `Protogalactic gas clouds in a dark-matter halo merge into a ${gal.type} galaxy.`, effects: [], tone: 'accent' });
    const cat = sim.queries.catalogOf(ref.g!);
    if (cat && cat.count) {
      let first = Infinity;
      for (let i = 0; i < cat.count; i++) first = Math.min(first, cat.birth[i]);
      out.push({ t: first, title: 'First stars', detail: 'The first catalogued stars ignite.', effects: [], tone: 'info' });
      out.push({ t: gal.formation + gal.sfTau * 0.3, title: 'Peak star formation', detail: `Star formation decays with a ${fmtNum(gal.sfTau / 1e9, 1)} Gyr timescale after this period.`, effects: [], tone: 'info' });
    }
    if (sim.catalog) {
      const recs = sim.catalog.life.filter((r) => r.g === ref.g);
      const firstLife = recs.reduce((m, r) => Math.min(m, r.t[Stage.REPL]), Infinity);
      const firstIntel = recs.reduce((m, r) => Math.min(m, r.t[Stage.INTEL]), Infinity);
      if (isFinite(firstLife)) out.push({ t: firstLife, title: 'First life in the galaxy', detail: 'The earliest biosphere in this galaxy emerges.', effects: [], tone: 'good' });
      if (isFinite(firstIntel)) out.push({ t: firstIntel, title: 'First intelligent species', detail: 'A species in this galaxy becomes intelligent.', effects: [], tone: 'good' });
    }
    for (const c of sim.civs.civs) {
      if (c.g !== ref.g) continue;
      out.push({ t: c.born, title: `Civilization ${c.code} emerges`, detail: `${c.name} (${c.species}) on ${planetId(c.g, c.s, c.p)}.`, effects: [], tone: 'good', ref: { kind: 'civ', civ: c.id } });
      if (c.endedAt !== null) out.push({ t: c.endedAt, title: `Civilization ${c.code} ends`, detail: c.endCause ?? '', effects: [], tone: 'bad', ref: { kind: 'civ', civ: c.id } });
    }
    ivEntries((iv) => iv.target.g === ref.g);
  }

  if (ref.kind === 'star') {
    const st = sim.queries.starCore(ref.g!, ref.s!);
    if (st) {
      const created = sim.queries.isCreatedStar(ref.g!, ref.s!);
      out.push({ t: st.birth, title: created ? 'Created by intervention' : 'Protostar collapse', detail: 'A molecular cloud core collapses; deuterium burning begins.', effects: [], tone: 'accent' });
      out.push({ t: st.birth + 1e6 * Math.max(0.05, 1 / st.mass), title: 'Main sequence', detail: 'Hydrogen fusion ignites in the core; the star settles into hydrostatic equilibrium.', effects: [], tone: 'info' });
      out.push({ t: st.birth + PLANET_FORMATION_DELAY, title: 'Planets form', detail: 'The protoplanetary disk dissipates, leaving the planetary system in place.', effects: [], tone: 'info' });
      out.push({ t: st.msEnd, title: 'Red giant phase', detail: 'Core hydrogen is exhausted; the envelope swells and the inner system is scorched. Biospheres end.', effects: [], tone: 'warn' });
      out.push({
        t: st.death,
        title: st.mass >= 8 ? 'Core-collapse supernova' : 'Planetary nebula',
        detail: st.mass >= 25 ? 'The core collapses into a black hole.' : st.mass >= 8 ? 'The core collapses into a neutron star; the explosion seeds the galaxy with heavy elements.' : 'The envelope disperses, leaving a cooling white dwarf.',
        effects: [],
        tone: 'bad',
      });
      const d = sim.queries.destroyedAt(ref.g!, ref.s!);
      if (d !== undefined) out.push({ t: d, title: 'Destroyed by intervention', detail: 'The star was destroyed; all biospheres in the system are sterilised.', effects: [], tone: 'bad' });
    }
    for (const c of sim.civs.civs) {
      for (const k of c.colonies) if (k.kind === 'star' && k.g === ref.g && k.s === ref.s) out.push({ t: k.founded, title: `Settled by ${c.code}`, detail: `${c.name} founded a colony here.`, effects: [], tone: 'good', ref: { kind: 'civ', civ: c.id } });
    }
    ivEntries((iv) => iv.target.g === ref.g && iv.target.s === ref.s && iv.target.p === undefined);
  }

  if (ref.kind === 'planet') {
    const { g, s, p } = ref as Required<Pick<EntityRef, 'g' | 's' | 'p'>>;
    const sys = sim.queries.getSystem(g, s);
    const pl = sys?.planets[p];
    const tl = sim.queries.lifeTimeline(g, s, p);
    if (pl && tl) {
      out.push({
        t: pl.formation,
        title: 'Formation',
        detail: `Accreted from the protoplanetary disk at ${fmtNum(pl.orbit.a, 2)} AU: ${fmtNum(pl.massE, 2)} Earth masses, ${pl.composition} composition.`,
        effects: [{ label: 'Mass', before: '—', after: `${fmtNum(pl.massE, 2)} M⊕` }],
        tone: 'accent',
      });
      for (const e of tl.events) {
        if (e.kind === 'oceans') {
          if (pl.climate.liquidWater > 0.02 || pl.env.water > 0.05)
            out.push({ t: e.t, title: 'First oceans', detail: 'The crust cools enough for water vapour to condense into oceans.', effects: [], tone: 'info' });
          continue;
        }
        if (e.kind === 'stage') {
          const dur = BASE_DURATION[Math.max(1, e.stage - 1)];
          out.push({
            t: e.t,
            title: e.stage === Stage.REPL ? 'First life' : e.stage === Stage.CIV ? 'Civilization arises' : STAGE_NAMES[e.stage],
            detail: `${STAGE_DETAIL[e.stage] ?? ''} (Reference duration of the previous stage on an Earth-like world: ${fmtNum(dur / 1e6, 0)} Myr.)`,
            effects: [{ label: 'Evolutionary stage', before: STAGE_NAMES[e.stage - 1], after: STAGE_NAMES[e.stage] }],
            tone: 'good',
          });
        } else if (e.kind === 'dead-end') {
          out.push({ t: e.t, title: 'Evolutionary dead end', detail: `Life failed to make the transition beyond "${STAGE_NAMES[e.stage]}" — one of the great filters. The biosphere persists but stops advancing.`, effects: [], tone: 'muted' });
        } else if (e.kind === 'mass-extinction') {
          out.push({
            t: e.t,
            title: 'Mass extinction',
            detail: `A planet-wide extinction (impact, volcanism or climate shock) erases ${fmtNum((e.severity ?? 0) * 100, 0)}% of the progress of complex life, delaying the emergence of intelligence.`,
            effects: [{ label: 'Evolutionary setback', before: '0', after: `${fmtNum(((e.severity ?? 0) * BASE_DURATION[Stage.COMPLEX]) / 1e6, 0)} Myr` }],
            tone: 'bad',
          });
        } else if (e.kind === 'sterilized' || e.kind === 'star-death' || (e.kind === 'impact' && e.stage === 0)) {
          out.push({ t: e.t, title: e.kind === 'star-death' ? 'End of the biosphere' : 'Sterilisation', detail: e.kind === 'star-death' ? 'The host star leaves the main sequence; the biosphere cannot survive.' : 'Conditions became uninhabitable and all life was lost.', effects: [{ label: 'Life', before: 'YES', after: 'NO' }], tone: 'bad' });
        } else if (e.kind === 'impact') {
          out.push({ t: e.t, title: 'Asteroid impact', detail: 'A large impact sets back complex life.', effects: [{ label: 'Severity', before: '—', after: `${fmtNum((e.severity ?? 0) * 100, 0)}%` }], tone: 'bad' });
        } else if (e.kind === 'boost') {
          out.push({ t: e.t, title: 'Evolution accelerated', detail: 'An intervention pushes the biosphere to its next stage.', effects: [{ label: 'Stage', before: STAGE_NAMES[e.stage - 1], after: STAGE_NAMES[e.stage] }], tone: 'warn' });
        }
      }
    }
    for (const c of sim.civs.civs) {
      if (c.g === g && c.s === s && c.p === p) {
        for (const ev of sim.civs.histories[c.id]) {
          if (ev.type === 'breakthrough' || ev.type === 'emergence' || ev.type === 'extinction' || ev.type === 'space' || ev.type === 'asteroid-impact' || ev.type === 'collapse' || ev.type === 'intervention')
            out.push(civEntry(ev, c.code));
        }
      }
      for (const k of c.colonies) if (k.g === g && k.s === s && k.p === p && k.kind !== 'orbital') out.push({ t: k.founded, title: `Colonized by ${c.code}`, detail: `${c.name} established a ${k.kind === 'moon' ? 'lunar' : 'planetary'} colony.`, effects: [], tone: 'good', ref: { kind: 'civ', civ: c.id } });
    }
    ivEntries((iv) => iv.target.g === g && iv.target.s === s && iv.target.p === p);
  }

  if (ref.kind === 'civ') {
    const c = sim.civs.civs[ref.civ!];
    if (c) {
      for (const ev of sim.civs.histories[c.id]) out.push(civEntry(ev, c.code));
      ivEntries((iv) => iv.target.civ === c.id);
    }
  }

  if (ref.kind === 'moon') {
    const sys = sim.queries.getSystem(ref.g!, ref.s!);
    const pl = sys?.planets[ref.p!];
    if (pl) out.push({ t: pl.formation, title: 'Formation', detail: pl.composition === 'gaseous' ? 'Accreted in the circumplanetary disk.' : 'Formed from impact debris or captured.', effects: [], tone: 'accent' });
    for (const c of sim.civs.civs)
      for (const k of c.colonies) if (k.kind === 'moon' && k.g === ref.g && k.s === ref.s && k.p === ref.p && k.m === ref.m) out.push({ t: k.founded, title: `Lunar base (${c.code})`, detail: 'A settlement is founded.', effects: [], tone: 'good' });
  }

  if (ref.kind === 'universe') {
    out.push({ t: 0, title: 'Big Bang', detail: 'Space, time and energy begin. Inflation stretches quantum fluctuations into the seeds of structure.', effects: [], tone: 'accent' });
    out.push({ t: 3.8e5, title: 'Recombination', detail: 'Neutral atoms form; the cosmic microwave background is released.', effects: [], tone: 'info' });
    if (sim.catalog) out.push({ t: sim.catalog.births[0], title: 'First stars', detail: 'Cosmic dawn.', effects: [], tone: 'info' });
    const firstLife = sim.catalog?.stageReach[Stage.REPL][0];
    if (firstLife !== undefined) out.push({ t: firstLife, title: 'First life in the universe', detail: 'Somewhere, chemistry becomes biology.', effects: [], tone: 'good' });
    const firstCiv = sim.civs.civs[0];
    if (firstCiv) out.push({ t: firstCiv.born, title: 'First civilization', detail: `${firstCiv.name} emerges.`, effects: [], tone: 'good', ref: { kind: 'civ', civ: 0 } });
    ivEntries(() => true);
  }

  return out.filter((e) => e.t <= now + 1e-6).sort((a, b) => a.t - b.t);
}

function civEntry(ev: { t: number; type: string; title: string; detail: string; effects: Record<string, [number, number]> }, code: string): HistoryEntry {
  const tone: Tone =
    ev.type === 'extinction' || ev.type === 'collapse' || ev.type === 'war' || ev.type === 'famine' || ev.type === 'pandemic' || ev.type === 'asteroid-impact' || ev.type === 'resource-depletion'
      ? 'bad'
      : ev.type === 'breakthrough' || ev.type === 'colonization' || ev.type === 'space' || ev.type === 'emergence'
        ? 'good'
        : ev.type === 'intervention'
          ? 'warn'
          : 'info';
  return {
    t: ev.t,
    title: ev.title,
    detail: `${ev.detail} [${code}]`,
    effects: Object.entries(ev.effects).map(([k, [a, b]]) => ({
      label: k === 'techLevel' ? 'Technology level' : k.charAt(0).toUpperCase() + k.slice(1),
      before: k === 'techLevel' ? `${a} · ${TECH_NAMES[a] ?? ''}` : fmtEffect(k, a),
      after: k === 'techLevel' ? `${b} · ${TECH_NAMES[b] ?? ''}` : fmtEffect(k, b),
    })),
    tone,
  };
}

export const starLabel = starId;
