import { LY_PER_KPC, PRESENT_YEARS } from '../core/constants';
import { DEG, Vec3 } from '../core/math';
import { fmtCompact, fmtHours, fmtInt, fmtNum, fmtPct, fmtPeriodYears, fmtWatts, kardashev } from '../core/format';
import { formatDuration } from '../core/time';
import { galaxyId, moonId, planetId, planetLetter, starId } from '../core/names';
import { epochAt, radiationTemperature, redshift, scaleFactor } from '../gen/cosmology';
import { galaxyAngle } from '../gen/galaxy';
import { EARTH_MASS_IN_SUN } from '../gen/planets';
import { Stage } from '../life/life';
import { orbitalPosition, visVivaKmS } from '../physics/orbits';
import { seasonName, solarDayHours, spinAxis, subsolarLatitude } from '../physics/rotation';
import { TECH_NAMES, extinctionRisk, techLevel, totalPopulation } from '../civ/civilization';
import { Simulation } from './simulation';
import { EntityRef } from './types';
import { planetKey } from '../survey/catalog';
import { speciesName } from '../core/names';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'accent' | 'muted';

export interface InfoRow {
  label: string;
  value: string;
  hint?: string;
  /** 0..1 meter. */
  bar?: number;
  tone?: Tone;
}

export interface InfoSection {
  title: string;
  rows: InfoRow[];
}

export interface ChildLink {
  label: string;
  sub: string;
  ref: EntityRef;
  tone?: Tone;
}

export interface EntityInfo {
  ref: EntityRef;
  headline: string;
  name: string;
  subtitle: string;
  badges: { text: string; tone: Tone }[];
  sections: InfoSection[];
  children: ChildLink[];
  childrenTitle?: string;
  parent: EntityRef | null;
  civIds: number[];
  /** Whether interventions in the inspector apply (planet/star/civ). */
  exists: boolean;
}

const yes = (b: boolean) => (b ? 'YES' : 'NO');

export function describe(sim: Simulation, ref: EntityRef): EntityInfo | null {
  switch (ref.kind) {
    case 'universe':
      return describeUniverse(sim);
    case 'galaxy':
      return describeGalaxy(sim, ref.g!);
    case 'star':
      return describeStar(sim, ref.g!, ref.s!);
    case 'planet':
      return describePlanet(sim, ref.g!, ref.s!, ref.p!);
    case 'moon':
      return describeMoon(sim, ref.g!, ref.s!, ref.p!, ref.m!);
    case 'civ':
      return describeCiv(sim, ref.civ!);
  }
}

function describeUniverse(sim: Simulation): EntityInfo {
  const t = sim.now();
  const ep = epochAt(t);
  const st = sim.stats(t);
  return {
    ref: { kind: 'universe' },
    headline: 'OBSERVABLE UNIVERSE',
    name: `Universe ${sim.seed}`,
    subtitle: ep.name,
    badges: [{ text: `Seed ${sim.seed}`, tone: 'accent' }],
    sections: [
      {
        title: 'Cosmology',
        rows: [
          { label: 'Age', value: formatDuration(t) },
          { label: 'Epoch', value: ep.name, hint: ep.description },
          { label: 'Scale factor a(t)', value: fmtNum(scaleFactor(t), 4) },
          { label: 'Redshift (to present)', value: t < PRESENT_YEARS ? fmtNum(redshift(t), 3) : '—' },
          { label: 'Radiation temperature', value: `${fmtNum(radiationTemperature(t), 2)} K` },
        ],
      },
      {
        title: 'Census',
        rows: [
          { label: 'Galaxies', value: fmtInt(st.galaxies) },
          { label: 'Shining stars', value: fmtInt(st.stars) },
          { label: 'Stellar remnants', value: fmtInt(st.remnants) },
          { label: 'Planets', value: fmtInt(st.planets) },
          { label: 'Habitable planets', value: fmtInt(st.habitable) },
          { label: 'Life-bearing planets', value: fmtInt(st.lifeBearing) },
          { label: 'Civilizations', value: fmtInt(st.civilizations) },
        ],
      },
    ],
    children: sim.universe.galaxies.slice(0, 200).map((g) => ({ label: g.name, sub: `${g.type} · ${fmtInt(g.starCount)} stars`, ref: { kind: 'galaxy', g: g.index } })),
    childrenTitle: 'Galaxies',
    parent: null,
    civIds: [],
    exists: true,
  };
}

function describeGalaxy(sim: Simulation, g: number): EntityInfo | null {
  const gal = sim.universe.galaxies[g];
  if (!gal) return null;
  const t = sim.now();
  const cat = sim.queries.catalogOf(g);
  let shining = 0, born = 0, remnants = 0;
  if (cat) {
    for (let i = 0; i < cat.count; i++) {
      if (cat.birth[i] <= t) {
        born++;
        if (t < cat.death[i]) shining++;
        else remnants++;
      }
    }
  }
  let lifeHere = 0, intelligentHere = 0;
  if (sim.catalog) {
    for (const rec of sim.catalog.life) {
      if (rec.g !== g) continue;
      if (rec.t[Stage.REPL] <= t && t < rec.end) lifeHere++;
      if (rec.t[Stage.INTEL] <= t && t < rec.end) intelligentHere++;
    }
  }
  const civsHere = sim.civs.aliveIds.filter((id) => sim.civs.civs[id].capital.g === g);
  const formed = t >= gal.formation;
  const rotPeriod = Math.abs((2 * Math.PI) / gal.patternSpeed);
  return {
    ref: { kind: 'galaxy', g },
    headline: `${gal.type.toUpperCase()} GALAXY`,
    name: gal.name,
    subtitle: `${galaxyId(g)} · ${gal.environment} environment`,
    badges: [
      { text: gal.type, tone: 'accent' },
      ...(formed ? [] : [{ text: 'NOT YET FORMED', tone: 'warn' as Tone }]),
      ...(civsHere.length ? [{ text: `${civsHere.length} civilization${civsHere.length > 1 ? 's' : ''}`, tone: 'good' as Tone }] : []),
    ],
    sections: [
      {
        title: 'Structure',
        rows: [
          { label: 'Type', value: gal.type + (gal.barLength > 0 ? ' (barred)' : '') },
          { label: 'Radius', value: `${fmtNum(gal.radius, 1)} kpc · ${fmtCompact(gal.radius * LY_PER_KPC)} ly` },
          { label: 'Stellar mass', value: `${gal.mass.toExponential(2)} M☉` },
          ...(gal.type === 'spiral' ? [{ label: 'Arms / pitch', value: `${gal.arms} arms · ${(gal.pitch / DEG).toFixed(1)}°` }] : []),
          { label: 'Pattern rotation', value: `${formatDuration(rotPeriod)} per revolution` },
          { label: 'Position', value: gal.position.map((x) => fmtNum(x, 0)).join(', ') + ' kpc' },
        ],
      },
      {
        title: 'Population',
        rows: [
          { label: 'Catalog stars', value: fmtInt(gal.starCount), hint: 'Simulated stars sampling the stellar population' },
          { label: 'Born so far', value: fmtInt(born) },
          { label: 'Shining', value: fmtInt(shining) },
          { label: 'Remnants', value: fmtInt(remnants) },
          { label: 'Life-bearing worlds', value: fmtInt(lifeHere) },
          { label: 'Intelligent species', value: fmtInt(intelligentHere) },
        ],
      },
      {
        title: 'History',
        rows: [
          { label: 'Formation', value: `${formatDuration(gal.formation)} after Big Bang` },
          { label: 'Age', value: formed ? formatDuration(t - gal.formation) : '—' },
          { label: 'Metallicity [Fe/H]', value: fmtNum(gal.metallicity, 2), hint: 'log₁₀ iron abundance relative to the Sun' },
          { label: 'Star-formation timescale', value: formatDuration(gal.sfTau) },
        ],
      },
    ],
    children: civsHere.map((id) => {
      const c = sim.civs.civs[id];
      return { label: `${c.code} · ${c.name}`, sub: TECH_NAMES[techLevel(c.tech)], ref: { kind: 'civ', civ: id }, tone: 'good' };
    }),
    childrenTitle: 'Civilizations',
    parent: { kind: 'universe' },
    civIds: civsHere,
    exists: formed,
  };
}

function describeStar(sim: Simulation, g: number, s: number): EntityInfo | null {
  const t = sim.now();
  const st = sim.queries.starState(g, s, t);
  const sys = sim.queries.getSystem(g, s);
  const loc = sim.queries.starLocal(g, s);
  if (!st || !sys || !loc) return null;
  const age = t - st.core.birth;
  const created = sim.queries.isCreatedStar(g, s);
  const destroyed = sim.queries.destroyedAt(g, s);
  const phaseLabel: Record<string, string> = {
    unborn: 'Not yet formed',
    protostar: 'Protostar',
    'main-sequence': 'Main sequence',
    'red-giant': 'Red giant',
    'white-dwarf': 'White dwarf',
    'neutron-star': 'Neutron star',
    'black-hole': 'Black hole',
    destroyed: 'Destroyed',
  };
  const civsHere = sim.civs.aliveIds.filter((id) => {
    const c = sim.civs.civs[id];
    return (c.capital.g === g && c.capital.s === s) || c.colonies.some((k) => k.g === g && k.s === s);
  });
  const gal = sim.universe.galaxies[g];
  return {
    ref: { kind: 'star', g, s },
    headline: `${st.spectralClass}-TYPE ${phaseLabel[st.phase].toUpperCase()}`,
    name: starId(g, s),
    subtitle: `${st.spectral} · ${gal.name}`,
    badges: [
      { text: phaseLabel[st.phase], tone: st.phase === 'main-sequence' ? 'good' : st.phase === 'red-giant' ? 'warn' : st.phase === 'destroyed' ? 'bad' : 'info' },
      ...(created ? [{ text: 'USER-CREATED', tone: 'accent' as Tone }] : []),
      ...(destroyed !== undefined && destroyed <= t ? [{ text: 'DESTROYED', tone: 'bad' as Tone }] : []),
      ...(civsHere.length ? [{ text: 'INHABITED', tone: 'good' as Tone }] : []),
    ],
    sections: [
      {
        title: 'Stellar properties',
        rows: [
          { label: 'Spectral class', value: `${st.spectral} (${st.spectralClass})` },
          { label: 'Mass', value: `${fmtNum(st.core.mass, 3)} M☉` },
          { label: 'Radius', value: `${fmtNum(st.radius, 3)} R☉` },
          { label: 'Luminosity', value: `${fmtNum(st.luminosity, 4)} L☉` },
          { label: 'Temperature', value: `${fmtInt(st.temperature)} K` },
          { label: 'Metallicity [Fe/H]', value: fmtNum(st.core.feh, 2) },
        ],
      },
      {
        title: 'Lifecycle',
        rows: [
          { label: 'Phase', value: phaseLabel[st.phase] },
          { label: 'Age', value: age > 0 ? formatDuration(age) : '—' },
          { label: 'Main-sequence lifetime', value: formatDuration(st.lifetime) },
          { label: 'Life used', value: age > 0 ? fmtPct(Math.min(1, age / st.lifetime)) : '0%', bar: Math.min(1, Math.max(0, age / st.lifetime)) },
          { label: 'Leaves main sequence', value: `year ${fmtCompact(st.core.msEnd)}` },
          { label: 'Fate', value: st.core.mass >= 25 ? 'Supernova → black hole' : st.core.mass >= 8 ? 'Supernova → neutron star' : 'Planetary nebula → white dwarf' },
        ],
      },
      {
        title: 'System',
        rows: [
          { label: 'Planets', value: fmtInt(sys.planets.length) },
          { label: 'Moons', value: fmtInt(sys.planets.reduce((a, p) => a + p.moons.length, 0)) },
          { label: 'Belts', value: sys.belts.length ? sys.belts.map((b) => `${b.kind} ${fmtNum(b.inner, 2)}–${fmtNum(b.outer, 2)} AU`).join('; ') : 'none' },
          { label: 'Habitable zone', value: `${fmtNum(sys.habitableZone[0], 2)}–${fmtNum(sys.habitableZone[1], 2)} AU` },
          { label: 'Snow line', value: `${fmtNum(sys.snowLine, 2)} AU` },
          { label: 'Distance from galactic centre', value: `${fmtCompact(Math.hypot(loc[0], loc[1], loc[2]) * LY_PER_KPC)} ly` },
        ],
      },
    ],
    children: sys.planets.map((p) => {
      const d = sim.queries.planetAt(g, s, p.index, t)!;
      return {
        label: `${planetLetter(p.index)} · ${d.type}`,
        sub: `${fmtNum(p.orbit.a, 2)} AU · ${fmtInt(d.climate.surfaceTemp)} K${d.life.stage >= 2 ? ' · life' : ''}`,
        ref: { kind: 'planet', g, s, p: p.index },
        tone: d.life.stage >= Stage.REPL ? 'good' : d.type === 'habitable' ? 'accent' : undefined,
      };
    }),
    childrenTitle: 'Planets',
    parent: { kind: 'galaxy', g },
    civIds: civsHere,
    exists: t >= st.core.birth,
  };
}

function planetHeadline(type: string, stage: number, hasCiv: boolean): string {
  if (hasCiv) return 'INHABITED WORLD';
  if (type === 'habitable' && stage >= Stage.MULTI) return 'EARTH-LIKE PLANET';
  if (stage >= Stage.REPL) return 'LIFE-BEARING ' + type.toUpperCase().replace('-', ' ') + ' WORLD';
  const names: Record<string, string> = {
    'gas-giant': 'GAS GIANT',
    'ice-giant': 'ICE GIANT',
    terrestrial: 'TERRESTRIAL PLANET',
    ocean: 'OCEAN WORLD',
    desert: 'DESERT WORLD',
    frozen: 'FROZEN WORLD',
    volcanic: 'VOLCANIC WORLD',
    habitable: 'HABITABLE PLANET',
  };
  return names[type] ?? type.toUpperCase();
}

export function atmosphereSummary(a: { n2: number; o2: number; co2: number; h2o: number; ch4: number; ar: number; h2: number; he: number }, pressure: number): string {
  if (pressure < 1e-4) return 'None (airless)';
  const parts: [string, number][] = [
    ['N₂', a.n2],
    ['O₂', a.o2],
    ['CO₂', a.co2],
    ['H₂O', a.h2o],
    ['CH₄', a.ch4],
    ['Ar', a.ar],
    ['H₂', a.h2],
    ['He', a.he],
  ];
  return parts
    .filter(([, v]) => v > 0.005)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([n, v]) => `${n} ${(v * 100).toFixed(v > 0.1 ? 0 : 1)}%`)
    .join(' / ');
}

export function planetDetail(sim: Simulation, g: number, s: number, p: number) {
  return sim.queries.planetAt(g, s, p, sim.now());
}

function describePlanet(sim: Simulation, g: number, s: number, p: number): EntityInfo | null {
  const t = sim.now();
  const d = sim.queries.planetAt(g, s, p, t);
  const sys = sim.queries.getSystem(g, s);
  if (!d || !sys) return null;
  const pl = d.planet;
  const civIds = sim.civs.civs.filter((c) => c.alive && c.capital.g === g && c.capital.s === s && c.capital.p === p).map((c) => c.id);
  const colonists = sim.civs.aliveIds.filter((id) => sim.civs.civs[id].colonies.some((k) => k.g === g && k.s === s && k.p === p && k.kind !== 'orbital'));
  const pastCivs = sim.civs.civs.filter((c) => c.g === g && c.s === s && c.p === p && !c.alive);
  const civ = civIds.length ? sim.civs.civs[civIds[0]] : null;
  const pos = orbitalPosition(pl.orbit, sim.clock, t);
  const r = Math.hypot(pos[0], pos[1], pos[2]);
  const axis = spinAxis(pl.orbit, pl.axialTilt, pl.seed);
  const sub = subsolarLatitude(axis, pos as Vec3);
  const giant = pl.composition === 'gaseous';
  const exists = t >= pl.formation;
  const res = d.resources;
  const species = d.life.stage >= Stage.INTEL ? speciesName(hashForSpecies(sim, g, s, p)) : null;
  return {
    ref: { kind: 'planet', g, s, p },
    headline: planetHeadline(d.type, d.life.stage, !!civ),
    name: planetId(g, s, p),
    subtitle: `${d.type} · orbiting ${starId(g, s)}`,
    badges: [
      { text: d.type, tone: d.type === 'habitable' ? 'good' : 'info' },
      ...(d.life.stage >= Stage.REPL ? [{ text: 'LIFE', tone: 'good' as Tone }] : []),
      ...(civ ? [{ text: `CIV ${civ.code}`, tone: 'accent' as Tone }] : []),
      ...(d.modified ? [{ text: 'MODIFIED', tone: 'warn' as Tone }] : []),
      ...(!exists ? [{ text: 'NOT YET FORMED', tone: 'warn' as Tone }] : []),
      ...(d.starPhase === 'red-giant' ? [{ text: 'SCORCHED BY RED GIANT', tone: 'bad' as Tone }] : []),
    ],
    sections: [
      {
        title: 'Physical',
        rows: [
          { label: 'Type', value: d.type },
          { label: 'Mass', value: `${fmtNum(pl.massE, 2)} Earths${pl.massE > 30 ? ` · ${fmtNum(pl.massE / 317.8, 2)} Jupiters` : ''}` },
          { label: 'Radius', value: `${fmtNum(pl.radiusE, 2)} Earths` },
          { label: 'Density', value: `${fmtNum(pl.density, 2)} g/cm³` },
          { label: 'Surface gravity', value: `${fmtNum(pl.surfaceGravity, 2)} g` },
          { label: 'Escape velocity', value: `${fmtNum(pl.vEscape, 1)} km/s` },
        ],
      },
      {
        title: 'Orbit',
        rows: [
          { label: 'Semi-major axis', value: `${fmtNum(pl.orbit.a, 3)} AU` },
          { label: 'Eccentricity', value: fmtNum(pl.orbit.e, 3) },
          { label: 'Orbital period', value: fmtPeriodYears(pl.orbit.period) },
          { label: 'Current distance', value: `${fmtNum(r, 3)} AU` },
          { label: 'Orbital velocity', value: `${fmtNum(visVivaKmS(r, pl.orbit.a, sys.star.mass + pl.massE * EARTH_MASS_IN_SUN), 2)} km/s`, hint: 'Vis-viva equation' },
          { label: 'Inclination', value: `${fmtNum(pl.orbit.i / DEG, 2)}°` },
          { label: 'Apsidal precession', value: pl.orbit.precession ? `${fmtNum(((2 * Math.PI) / pl.orbit.precession) / 1e3, 1)} kyr/cycle` : '—', hint: 'Secular perturbation by other planets' },
        ],
      },
      {
        title: 'Rotation',
        rows: [
          { label: 'Sidereal day', value: `${fmtHours(pl.rotationHours)}${pl.rotationHours < 0 ? ' (retrograde)' : ''}` },
          { label: 'Solar day', value: fmtHours(solarDayHours(pl.rotationHours, pl.orbit.period)) },
          { label: 'Axial tilt', value: `${fmtNum(pl.axialTilt / DEG, 1)}°` },
          { label: 'Spin–orbit state', value: pl.spinOrbitResonance ? `${pl.spinOrbitResonance} resonance${pl.tidallyLocked ? ' (tidally locked)' : ''}` : 'free rotation' },
          { label: 'Sub-solar latitude', value: `${fmtNum(sub / DEG, 1)}°` },
          { label: 'Season', value: seasonName(sub, pl.axialTilt) },
        ],
      },
      {
        title: 'Climate',
        rows: [
          { label: 'Temperature', value: `${fmtInt(d.climate.surfaceTemp)} K (${fmtInt(d.climate.surfaceTemp - 273.15)} °C)` },
          { label: 'Equilibrium temp.', value: `${fmtInt(d.climate.equilibriumTemp)} K` },
          { label: 'Greenhouse warming', value: `${fmtNum(d.climate.greenhouseK, 1)} K` },
          { label: 'Insolation', value: `${fmtNum(pl.insolation, 3)} × Earth` },
          { label: 'Bond albedo', value: fmtNum(d.climate.albedo, 2) },
          ...(giant
            ? []
            : [
                { label: 'Water (liquid)', value: fmtPct(d.climate.liquidWater), bar: d.climate.liquidWater },
                { label: 'Ice cover', value: fmtPct(d.climate.ice), bar: d.climate.ice },
                { label: 'Cloud cover', value: fmtPct(d.climate.clouds), bar: d.climate.clouds },
              ]),
        ],
      },
      {
        title: 'Atmosphere',
        rows: [
          { label: 'Surface pressure', value: giant ? '— (no surface)' : `${fmtNum(d.climate.pressure + d.oxygen * d.climate.pressure, 3)} bar` },
          { label: 'Composition', value: atmosphereSummary(d.atmosphere, giant ? 1 : d.atmosphere.pressure) },
          ...(giant ? [] : [{ label: 'CO₂', value: `${fmtNum(d.atmosphere.co2 * 100, 3)}%` }, { label: 'O₂ (biogenic)', value: `${fmtNum(d.atmosphere.o2 * 100, 1)}%` }]),
        ],
      },
      {
        title: 'Interior',
        rows: [
          { label: 'Magnetic field', value: `${fmtNum(pl.magneticField, 2)} × Earth`, bar: Math.min(1, pl.magneticField / 2) },
          { label: 'Geological activity', value: fmtPct(d.geology), bar: d.geology },
          { label: 'Tidal heating', value: fmtPct(pl.tidalHeating), bar: pl.tidalHeating },
          { label: 'Composition', value: `${pl.composition} · iron ${fmtPct(pl.ironFraction)} · water ${fmtPct(pl.waterMassFraction, 2)} by mass` },
        ],
      },
      {
        title: 'Resources',
        rows: [
          { label: 'Metals', value: fmtPct(res.metals), bar: res.metals },
          { label: 'Rare elements', value: fmtPct(res.rareElements), bar: res.rareElements },
          { label: 'Silicates', value: fmtPct(res.silicates), bar: res.silicates },
          { label: 'Water', value: fmtPct(res.water), bar: res.water },
          { label: 'Hydrocarbons', value: fmtPct(res.hydrocarbons), bar: res.hydrocarbons, hint: 'Fossil carbon from ancient biospheres' },
          { label: 'Radioactives', value: fmtPct(res.radioactives), bar: res.radioactives },
          { label: 'Helium-3', value: fmtPct(res.helium3), bar: res.helium3 },
        ],
      },
      {
        title: 'Biosphere',
        rows: [
          { label: 'Habitability index', value: fmtNum(d.habitability, 2), bar: d.habitability, tone: d.habitability > 0.4 ? 'good' : 'muted' },
          { label: '· temperature', value: fmtNum(d.factors.temperature, 2), bar: d.factors.temperature },
          { label: '· liquid water', value: fmtNum(d.factors.water, 2), bar: d.factors.water },
          { label: '· atmosphere', value: fmtNum(d.factors.atmosphere, 2), bar: d.factors.atmosphere },
          { label: '· stellar energy', value: fmtNum(d.factors.energy, 2), bar: d.factors.energy },
          { label: '· geology', value: fmtNum(d.factors.geology, 2), bar: d.factors.geology },
          { label: '· chemistry', value: fmtNum(d.factors.chemistry, 2), bar: d.factors.chemistry },
          { label: 'Life', value: yes(d.life.stage >= Stage.REPL), tone: d.life.stage >= Stage.REPL ? 'good' : 'muted' },
          { label: 'Evolutionary stage', value: d.life.stageName },
          ...(d.life.stage >= 1 && d.life.stage < Stage.CIV ? [{ label: 'Progress to next stage', value: fmtPct(d.life.progress), bar: d.life.progress }] : []),
          ...(species ? [{ label: 'Intelligent species', value: species }] : []),
        ],
      },
      {
        title: 'Civilization',
        rows: civ
          ? [
              { label: 'Civilization', value: `${civ.code} · ${civ.name}` },
              { label: 'Technology', value: `Level ${techLevel(civ.tech)} · ${TECH_NAMES[techLevel(civ.tech)]}` },
              { label: 'Population', value: fmtCompact(totalPopulation(civ)) },
            ]
          : [
              { label: 'Civilization', value: 'NO' },
              ...(colonists.length ? [{ label: 'Colonized by', value: colonists.map((id) => sim.civs.civs[id].code).join(', ') }] : []),
              ...(pastCivs.length ? [{ label: 'Extinct civilizations', value: pastCivs.map((c) => `${c.code} (${c.endCause})`).join('; ') }] : []),
            ],
      },
    ],
    children: [
      ...pl.moons.map((m) => ({ label: `${m.id.split('-').pop()} · ${m.kind} moon`, sub: `${fmtNum(m.radiusE * 6371, 0)} km · ${fmtPeriodYears(m.orbit.period)}`, ref: { kind: 'moon', g, s, p, m: m.index } as EntityRef })),
      ...civIds.map((id) => ({ label: `Civilization ${sim.civs.civs[id].code}`, sub: sim.civs.civs[id].name, ref: { kind: 'civ', civ: id } as EntityRef, tone: 'good' as Tone })),
    ],
    childrenTitle: pl.moons.length ? 'Moons & inhabitants' : 'Inhabitants',
    parent: { kind: 'star', g, s },
    civIds,
    exists,
  };
}

export function hashForSpecies(sim: Simulation, g: number, s: number, p: number) {
  return sim.queries.planetSeed(g, s, p) ^ 0x5bec;
}

function describeMoon(sim: Simulation, g: number, s: number, p: number, m: number): EntityInfo | null {
  const sys = sim.queries.getSystem(g, s);
  const moon = sys?.planets[p]?.moons[m];
  if (!sys || !moon) return null;
  const pl = sys.planets[p];
  const colonists = sim.civs.aliveIds.filter((id) => sim.civs.civs[id].colonies.some((k) => k.kind === 'moon' && k.g === g && k.s === s && k.p === p && k.m === m));
  return {
    ref: { kind: 'moon', g, s, p, m },
    headline: `${moon.kind.toUpperCase()} MOON`,
    name: moonId(g, s, p, m),
    subtitle: `satellite of ${planetId(g, s, p)}`,
    badges: [{ text: moon.kind, tone: moon.kind === 'volcanic' ? 'warn' : 'info' }, ...(colonists.length ? [{ text: 'SETTLED', tone: 'good' as Tone }] : [])],
    sections: [
      {
        title: 'Physical',
        rows: [
          { label: 'Mass', value: `${fmtNum(moon.massE, 4)} Earths` },
          { label: 'Radius', value: `${fmtInt(moon.radiusE * 6371)} km` },
          { label: 'Density', value: `${fmtNum(moon.density, 2)} g/cm³` },
        ],
      },
      {
        title: 'Orbit',
        rows: [
          { label: 'Semi-major axis', value: `${fmtInt(moon.orbit.a * 1.496e8)} km · ${fmtNum(moon.aInPlanetRadii, 1)} R_p` },
          { label: 'Period', value: fmtPeriodYears(moon.orbit.period) },
          { label: 'Eccentricity', value: fmtNum(moon.orbit.e, 3) },
          { label: 'Rotation', value: 'Tidally locked (synchronous)' },
          { label: 'Parent mass ratio', value: `1 : ${fmtCompact(pl.massE / moon.massE)}` },
        ],
      },
      ...(colonists.length ? [{ title: 'Settlement', rows: colonists.map((id) => ({ label: 'Settled by', value: sim.civs.civs[id].code })) }] : []),
    ],
    children: [],
    parent: { kind: 'planet', g, s, p },
    civIds: colonists,
    exists: true,
  };
}

function describeCiv(sim: Simulation, id: number): EntityInfo | null {
  const c = sim.civs.civs[id];
  if (!c) return null;
  const t = sim.now();
  const L = techLevel(c.tech);
  const pop = totalPopulation(c);
  const risk = extinctionRisk(c);
  const k = kardashev(c.energy);
  const coloniesBy = (kind: string) => c.colonies.filter((x) => x.kind === kind).length;
  return {
    ref: { kind: 'civ', civ: id },
    headline: c.alive ? `${TECH_NAMES[L].toUpperCase()} CIVILIZATION` : 'EXTINCT CIVILIZATION',
    name: `${c.code} · ${c.name}`,
    subtitle: `${c.species} · home ${planetId(c.g, c.s, c.p)}`,
    badges: [
      { text: c.alive ? 'ACTIVE' : 'EXTINCT', tone: c.alive ? 'good' : 'bad' },
      { text: `Tech ${L}`, tone: 'accent' },
      ...(c.source === 'intervention' ? [{ text: 'SEEDED', tone: 'warn' as Tone }] : []),
      { text: `Risk ${risk.label}`, tone: risk.label === 'LOW' ? 'good' : risk.label === 'MODERATE' ? 'info' : 'bad' },
    ],
    sections: [
      {
        title: 'Overview',
        rows: [
          { label: 'Species', value: c.species },
          { label: 'Age', value: formatDuration((c.alive ? Math.min(t, c.time) : c.endedAt ?? t) - c.born) },
          { label: 'Population', value: fmtCompact(pop), hint: `${fmtCompact(c.population)} on the capital world` },
          { label: 'Intelligence', value: fmtNum(c.intelligence, 2), hint: 'Species cognitive factor (1 = human-like)' },
          { label: 'Status', value: c.alive ? 'Active' : `Ended: ${c.endCause} (${formatDuration(t - (c.endedAt ?? t))} ago)` },
        ],
      },
      {
        title: 'Technology',
        rows: [
          { label: 'Level', value: `${L} — ${TECH_NAMES[L]}` },
          { label: 'Progress to next level', value: L < 6 ? fmtPct(c.tech - L) : '—', bar: L < 6 ? c.tech - L : 1 },
          { label: 'Energy consumption', value: fmtWatts(c.energy) },
          { label: 'Kardashev rating', value: `K ${fmtNum(k, 2)}` },
          { label: 'Satellites', value: fmtInt(c.satellites) },
        ],
      },
      {
        title: 'Economy & society',
        rows: [
          { label: 'Economic output', value: `${fmtCompact(c.economy)} /yr` },
          { label: 'Resources', value: fmtPct(Math.min(3, c.resources / Math.max(1, c.resourcesMax))), bar: Math.min(1, c.resources / Math.max(1, c.resourcesMax)), tone: c.depleted ? 'bad' : undefined },
          { label: 'Territory (home world)', value: fmtPct(c.territory), bar: c.territory },
          { label: 'Stability', value: fmtPct(c.stability), bar: c.stability, tone: c.stability < 0.3 ? 'bad' : c.stability > 0.6 ? 'good' : undefined },
          { label: 'Culture · cohesion', value: fmtPct(c.culture.cohesion), bar: c.culture.cohesion },
          { label: 'Culture · militarism', value: fmtPct(c.culture.militarism), bar: c.culture.militarism },
          { label: 'Culture · curiosity', value: fmtPct(c.culture.curiosity), bar: c.culture.curiosity },
          { label: 'Culture · expansionism', value: fmtPct(c.culture.expansionism), bar: c.culture.expansionism },
        ],
      },
      {
        title: 'Expansion',
        rows: [
          { label: 'Orbital colonies', value: fmtInt(coloniesBy('orbital')) },
          { label: 'Lunar bases', value: fmtInt(coloniesBy('moon')) },
          { label: 'Planetary colonies', value: fmtInt(coloniesBy('planet')) },
          { label: 'Star systems settled', value: fmtInt(coloniesBy('star')) },
          { label: 'Ships in transit', value: fmtInt(c.transits.length) },
          { label: 'Capital', value: c.capital.p >= 0 ? planetId(c.capital.g, c.capital.s, c.capital.p) : `habitat at ${starId(c.capital.g, c.capital.s)}` },
        ],
      },
      {
        title: 'Record',
        rows: [
          { label: 'Wars', value: fmtInt(c.counters.wars) },
          { label: 'Famines', value: fmtInt(c.counters.famines) },
          { label: 'Pandemics', value: fmtInt(c.counters.pandemics) },
          { label: 'Collapses', value: fmtInt(c.counters.collapses) },
          { label: 'Discoveries', value: fmtInt(c.counters.discoveries) },
          { label: 'Asteroid impacts', value: fmtInt(c.counters.impacts) },
          { label: 'Extinction risk', value: risk.label, bar: risk.score, tone: risk.label === 'LOW' ? 'good' : 'bad' },
        ],
      },
    ],
    children: [
      { label: `Home world ${planetId(c.g, c.s, c.p)}`, sub: 'origin of the species', ref: { kind: 'planet', g: c.g, s: c.s, p: c.p } },
      ...c.colonies
        .filter((x) => x.kind === 'star')
        .slice(0, 40)
        .map((x) => ({ label: `Colony ${starId(x.g, x.s)}`, sub: `founded ${formatDuration(t - x.founded)} ago · ${fmtCompact(x.population)}`, ref: { kind: 'star', g: x.g, s: x.s } as EntityRef })),
    ],
    childrenTitle: 'Worlds',
    parent: { kind: 'planet', g: c.g, s: c.s, p: c.p },
    civIds: [id],
    exists: true,
  };
}

/** Rotation angle of a galaxy (exported for the renderer/picking). */
export const galaxyRotation = (sim: Simulation, g: number) => galaxyAngle(sim.universe.galaxies[g], sim.now());
export const planetKeyOf = planetKey;
