import { useState } from 'react';
import { runtime } from '../app/runtime';
import { EntityInfo } from '../engine/sim/describe';
import { fmtNum } from '../engine/core/format';
import { Rng, hash32 } from '../engine/core/rng';
import { TECH_NAMES, techLevel } from '../engine/civ/civilization';
import { Stage, STAGE_NAMES } from '../engine/life/life';

function Slider({ label, min, max, step, value, onChange, fmt }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <div className="iv-row">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="num">{fmt(value)}</span>
    </div>
  );
}

export function InterventionPanel({ info }: { info: EntityInfo }) {
  const sim = runtime.sim;
  const ref = info.ref;
  if (!sim) return null;
  if (ref.kind === 'planet') return <PlanetInterventions g={ref.g!} s={ref.s!} p={ref.p!} />;
  if (ref.kind === 'star') return <StarInterventions g={ref.g!} s={ref.s!} />;
  if (ref.kind === 'galaxy') return <GalaxyInterventions g={ref.g!} />;
  if (ref.kind === 'civ') return <CivInterventions id={ref.civ!} />;
  return <div className="empty">Select a galaxy, star, planet or civilization to modify the universe.<br />Every intervention is recorded in the timeline and replays deterministically.</div>;
}

function Log({ match }: { match: (t: { g: number; s?: number; p?: number; civ?: number }) => boolean }) {
  const ivs = runtime.sim!.interventions.filter((iv) => match(iv.target));
  if (!ivs.length) return null;
  return (
    <div className="iv-list">
      <div className="kicker">Interventions here</div>
      {ivs.map((iv) => (
        <div className="iv-entry" key={iv.id}>
          <span className="warn">⚠ {iv.label}</span> <span className="faint mono">· yr {Math.floor(iv.t).toLocaleString('en-US')}</span>
          <div className="mono dim" style={{ marginTop: 2 }}>
            {iv.previous} → {iv.next}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanetInterventions({ g, s, p }: { g: number; s: number; p: number }) {
  const sim = runtime.sim!;
  const d = sim.queries.planetAt(g, s, p, sim.now());
  const [pressure, setPressure] = useState(() => Math.log10(Math.max(0.001, d?.climate.pressure ?? 1)));
  const [co2, setCo2] = useState(() => Math.min(100, (d?.atmosphere.co2 ?? 0) * 100));
  const [water, setWater] = useState(() => d?.env.water ?? 0);
  const [forcing, setForcing] = useState(() => d?.env.forcing ?? 0);
  const [severity, setSeverity] = useState(0.5);
  if (!d) return null;
  if (d.planet.composition === 'gaseous') return <div className="empty">Giant planets have no surface to modify. Try one of its moons' parent star, or a rocky world.</div>;
  const target = { g, s, p };
  const civHere = sim.civsOnPlanet(target);
  const P = Math.pow(10, pressure);
  return (
    <div>
      <div className="iv-note">Changes take effect at the current time ({Math.floor(sim.now()).toLocaleString('en-US')}); the climate model re-solves and the biosphere responds. Interventions made in the past branch the timeline.</div>

      <div className="iv-group">
        <div className="section-title">Atmosphere</div>
        <Slider label="Pressure" min={-3} max={2.3} step={0.01} value={pressure} onChange={setPressure} fmt={(v) => `${fmtNum(Math.pow(10, v), 3)} bar`} />
        <Slider label="CO₂ fraction" min={0} max={100} step={0.1} value={co2} onChange={setCo2} fmt={(v) => `${v.toFixed(1)}%`} />
        <button
          className="btn warn small"
          style={{ marginTop: 6 }}
          onClick={() =>
            runtime.intervene('set-atmosphere', target, { pN2: P * (1 - co2 / 100), pCO2: (P * co2) / 100 }, `P ${fmtNum(d.climate.pressure, 3)} bar, CO₂ ${fmtNum(d.atmosphere.co2 * 100, 2)}%`, `P ${fmtNum(P, 3)} bar, CO₂ ${co2.toFixed(1)}%`)
          }
        >
          Alter atmosphere
        </button>
      </div>

      <div className="iv-group">
        <div className="section-title">Hydrosphere</div>
        <Slider label="Water inventory" min={0} max={6} step={0.01} value={water} onChange={setWater} fmt={(v) => `${v.toFixed(2)} oceans`} />
        <button className="btn warn small" style={{ marginTop: 6 }} onClick={() => runtime.intervene('set-water', target, { water }, `${fmtNum(d.env.water, 2)} Earth oceans (${(d.climate.liquidWater * 100).toFixed(0)}% liquid cover)`, `${water.toFixed(2)} Earth oceans`)}>
          {water >= d.env.water ? 'Add water' : 'Remove water'}
        </button>
      </div>

      <div className="iv-group">
        <div className="section-title">Temperature</div>
        <Slider label="Forcing" min={-120} max={200} step={1} value={forcing} onChange={setForcing} fmt={(v) => `${v >= 0 ? '+' : ''}${v} K`} />
        <button className="btn warn small" style={{ marginTop: 6 }} onClick={() => runtime.intervene('set-temperature', target, { forcing }, `${Math.round(d.climate.surfaceTemp)} K (forcing ${d.env.forcing} K)`, `forcing ${forcing >= 0 ? '+' : ''}${forcing} K`)}>
          Change temperature
        </button>
      </div>

      <div className="iv-group">
        <div className="section-title">Biosphere & geology</div>
        <div className="toggle-row">
          <button
            className="btn warn small"
            disabled={d.life.stage >= Stage.CIV || d.habitability <= 0.02}
            onClick={() => runtime.intervene('accelerate-evolution', target, {}, d.life.stageName, STAGE_NAMES[Math.min(Stage.CIV, d.life.stage + 1)])}
            title={d.habitability <= 0.02 ? 'Uninhabitable — change the climate first' : ''}
          >
            Accelerate evolution
          </button>
          <button className="btn warn small" onClick={() => runtime.intervene('add-resources', target, { boost: 0.5 }, `metals ${(d.resources.metals * 100).toFixed(0)}%`, `+50% resource endowment`)}>
            Introduce resources
          </button>
          <button
            className="btn small"
            disabled={civHere.length > 0}
            onClick={() => runtime.intervene('spawn-civilization', target, {}, civHere.length ? 'inhabited' : 'no civilization', 'civilization seeded')}
          >
            Spawn civilization
          </button>
        </div>
        <Slider label="Impact severity" min={0.05} max={1} step={0.01} value={severity} onChange={setSeverity} fmt={(v) => `${(v * 100).toFixed(0)}%`} />
        <button className="btn danger small" style={{ marginTop: 6 }} onClick={() => runtime.intervene('asteroid-impact', target, { severity }, d.life.stageName, `impact (${(severity * 100).toFixed(0)}% severity)`)}>
          Trigger asteroid impact
        </button>
      </div>
      <Log match={(t) => t.g === g && t.s === s && t.p === p} />
    </div>
  );
}

function StarInterventions({ g, s }: { g: number; s: number }) {
  const sim = runtime.sim!;
  const st = sim.queries.starState(g, s, sim.now());
  const [mass, setMass] = useState(1);
  if (!st) return null;
  const destroyed = st.phase === 'destroyed';
  return (
    <div>
      <div className="iv-group">
        <div className="section-title">Destroy</div>
        <div className="iv-note">Destroys the star now. All biospheres in the system are sterilised; civilizations without interstellar refuges perish.</div>
        <button className="btn danger small" style={{ marginTop: 6 }} disabled={destroyed} onClick={() => runtime.intervene('destroy-star', { g, s }, {}, `${st.spectral} ${st.phase}`, 'destroyed')}>
          Destroy star
        </button>
      </div>
      <CreateStar g={g} near={s} mass={mass} setMass={setMass} />
      <Log match={(t) => t.g === g && t.s === s && t.p === undefined} />
    </div>
  );
}

function CreateStar({ g, near, mass, setMass }: { g: number; near?: number; mass: number; setMass: (v: number) => void }) {
  const sim = runtime.sim!;
  const create = () => {
    const gal = sim.universe.galaxies[g];
    const rng = new Rng(hash32(sim.interventions.length, Math.floor(sim.now()), g));
    let x: number, y: number, z: number;
    const base = near !== undefined ? sim.queries.starLocal(g, near) : null;
    if (base) {
      x = base[0] + rng.gaussian(0, 0.02);
      y = base[1] + rng.gaussian(0, 0.01);
      z = base[2] + rng.gaussian(0, 0.02);
    } else {
      const r = rng.range(0.1, 0.6) * gal.radius, th = rng.range(0, Math.PI * 2);
      x = Math.cos(th) * r;
      y = rng.gaussian(0, 0.1);
      z = Math.sin(th) * r;
    }
    const iv = runtime.intervene('create-star', { g }, { mass, feh: gal.metallicity, x, y, z }, 'none', `${mass.toFixed(2)} M☉ star`);
    if (iv) {
      const cs = sim.overrides.createdStars.find((c) => c.interventionId === iv.id);
      if (cs) runtime.select({ kind: 'star', g, s: cs.s }, true);
    }
  };
  return (
    <div className="iv-group">
      <div className="section-title">Create star</div>
      <Slider label="Mass" min={-1} max={1.7} step={0.01} value={Math.log10(mass)} onChange={(v) => setMass(Math.pow(10, v))} fmt={(v) => `${Math.pow(10, v).toFixed(2)} M☉`} />
      <div className="iv-note">A new star is born{near !== undefined ? ' near this one' : ' in this galaxy'} with a procedurally generated planetary system (seeded by the intervention).</div>
      <button className="btn warn small" style={{ marginTop: 6 }} onClick={create}>
        Create star
      </button>
    </div>
  );
}

function GalaxyInterventions({ g }: { g: number }) {
  const [mass, setMass] = useState(1);
  return (
    <div>
      <CreateStar g={g} mass={mass} setMass={setMass} />
      <Log match={(t) => t.g === g && t.s === undefined} />
    </div>
  );
}

function CivInterventions({ id }: { id: number }) {
  const sim = runtime.sim!;
  const c = sim.civs.civs[id];
  const [severity, setSeverity] = useState(0.5);
  if (!c) return null;
  if (!c.alive) return <div className="empty">This civilization is extinct ({c.endCause}).</div>;
  const L = techLevel(c.tech);
  const target = { g: c.capital.g, s: c.capital.s, p: c.capital.p, civ: id };
  return (
    <div>
      <div className="iv-group">
        <div className="section-title">Technology</div>
        <button className="btn warn small" disabled={L >= 6} onClick={() => runtime.intervene('advance-tech', { g: c.g, civ: id }, {}, `Level ${L} (${TECH_NAMES[L]})`, `Level ${Math.min(6, L + 1)} (${TECH_NAMES[Math.min(6, L + 1)]})`)}>
          Advance technology
        </button>
      </div>
      <div className="iv-group">
        <div className="section-title">Resources</div>
        <button className="btn warn small" disabled={c.capital.p < 0} onClick={() => runtime.intervene('add-resources', { g: target.g, s: target.s, p: target.p }, { boost: 0.5 }, `${((c.resources / c.resourcesMax) * 100).toFixed(0)}% of endowment`, `+50% of endowment`)}>
          Introduce resources
        </button>
      </div>
      <div className="iv-group">
        <div className="section-title">Catastrophe</div>
        <Slider label="Impact severity" min={0.05} max={1} step={0.01} value={severity} onChange={setSeverity} fmt={(v) => `${(v * 100).toFixed(0)}%`} />
        <div className="toggle-row" style={{ marginTop: 6 }}>
          <button className="btn danger small" disabled={c.capital.p < 0} onClick={() => runtime.intervene('asteroid-impact', { g: target.g, s: target.s, p: target.p }, { severity }, `population ${c.population.toExponential(2)}`, `impact (${(severity * 100).toFixed(0)}%)`)}>
            Asteroid impact
          </button>
          <button className="btn danger small" onClick={() => runtime.intervene('remove-civilization', { g: c.g, civ: id }, {}, `${c.name} (active)`, 'removed')}>
            Remove civilization
          </button>
        </div>
      </div>
      <Log match={(t) => t.civ === id} />
    </div>
  );
}
