import { CivCounters, TECH_NAMES, extinctionRisk, techLevel, totalPopulation } from '../civ/civilization';
import { Simulation } from './simulation';

/**
 * Observer mode: snapshot a civilization, let the universe run for a fixed duration,
 * and summarise what actually changed (all figures read from simulation state / history).
 */

export interface ObserverBaseline {
  civ: number;
  t0: number;
  duration: number;
  population: number;
  tech: number;
  colonies: number;
  starColonies: number;
  counters: CivCounters;
  historyLen: number;
  alive: boolean;
}

export interface ObserverSummary {
  civ: number;
  code: string;
  name: string;
  t0: number;
  t1: number;
  populationChange: number | null;
  populationBefore: number;
  populationAfter: number;
  techBefore: number;
  techAfter: number;
  wars: number;
  famines: number;
  pandemics: number;
  collapses: number;
  discoveries: number;
  impacts: number;
  coloniesBefore: number;
  coloniesAfter: number;
  starSystemsBefore: number;
  starSystemsAfter: number;
  majorEvents: { t: number; title: string }[];
  extinct: boolean;
  risk: string;
}

export const OBSERVE_DURATIONS = [
  { label: '100 years', years: 100 },
  { label: '1,000 years', years: 1000 },
  { label: '10,000 years', years: 10000 },
  { label: '1 million years', years: 1e6 },
];

export function observerBaseline(sim: Simulation, civId: number, duration: number): ObserverBaseline {
  const c = sim.civs.civs[civId];
  return {
    civ: civId,
    t0: sim.now(),
    duration,
    population: totalPopulation(c),
    tech: c.tech,
    colonies: c.colonies.length,
    starColonies: c.colonies.filter((k) => k.kind === 'star').length,
    counters: { ...c.counters },
    historyLen: sim.civs.histories[civId].length,
    alive: c.alive,
  };
}

export function observerSummary(sim: Simulation, b: ObserverBaseline): ObserverSummary {
  const c = sim.civs.civs[b.civ];
  const after = totalPopulation(c);
  const d = (k: keyof CivCounters) => c.counters[k] - b.counters[k];
  const major = sim.civs.histories[b.civ]
    .slice(b.historyLen)
    .filter((e) => ['breakthrough', 'colonization', 'space', 'war', 'collapse', 'extinction', 'asteroid-impact', 'resource-depletion', 'intervention'].includes(e.type))
    .slice(-12)
    .map((e) => ({ t: e.t, title: e.title }));
  return {
    civ: b.civ,
    code: c.code,
    name: c.name,
    t0: b.t0,
    t1: sim.now(),
    populationChange: b.population > 0 ? (after - b.population) / b.population : null,
    populationBefore: b.population,
    populationAfter: after,
    techBefore: b.tech,
    techAfter: c.tech,
    wars: d('wars'),
    famines: d('famines'),
    pandemics: d('pandemics'),
    collapses: d('collapses'),
    discoveries: d('discoveries') + d('breakthroughs'),
    impacts: d('impacts'),
    coloniesBefore: b.colonies,
    coloniesAfter: c.colonies.length,
    starSystemsBefore: b.starColonies,
    starSystemsAfter: c.colonies.filter((k) => k.kind === 'star').length,
    majorEvents: major,
    extinct: b.alive && !c.alive,
    risk: extinctionRisk(c).label,
  };
}

export const techLabel = (tech: number) => `Level ${techLevel(tech)} (${TECH_NAMES[techLevel(tech)]})`;
