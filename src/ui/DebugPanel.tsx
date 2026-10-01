import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { SPEED_PRESETS } from '../engine/sim/simulation';
import { fmtCompact, fmtInt } from '../engine/core/format';

export function DebugPanel() {
  const perf = useUI((s) => s.perf);
  const years = useUI((s) => s.years);
  const seed = useUI((s) => s.seed);
  const speed = useUI((s) => s.speed);
  const settings = useUI((s) => s.settings);
  const set = useUI((s) => s.set);
  const tog = useUI((s) => s.togglePanel);
  const row = (k: string, v: string) => (
    <div className="row">
      <span className="lab dim">{k}</span>
      <span className="val">{v}</span>
    </div>
  );
  const toggle = (k: keyof typeof settings) => {
    const next = { ...settings, [k]: !settings[k] };
    set({ settings: next });
    if (runtime.renderer) runtime.renderer.settings = next;
  };
  return (
    <div className="panel debug">
      <div className="panel-head">
        <span className="panel-title">
          <span className="dot" style={{ background: 'var(--warn)', boxShadow: '0 0 8px var(--warn)' }} /> Debug
        </span>
        <button className="icon-btn" onClick={() => tog('debug')}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {row('FPS', perf.fps.toFixed(0))}
        {row('Frame (render)', `${perf.frameMs.toFixed(2)} ms`)}
        {row('Sim advance', `${perf.advanceMs.toFixed(2)} ms`)}
        {row('Memory (JS heap)', perf.memoryMB !== null ? `${perf.memoryMB.toFixed(0)} MB` : 'n/a')}
        {row('Simulation TPS', fmtInt(perf.tps))}
        {row('Steps last frame', fmtInt(perf.stepsLastFrame))}
        {row('Active entities', fmtInt(perf.activeEntities))}
        {row('Generated entities', fmtCompact(perf.generatedEntities))}
        {row('Visible entities', fmtCompact(perf.visibleEntities))}
        {row('Event queue', fmtInt(perf.eventQueue))}
        {row('Checkpoints', fmtInt(perf.checkpoints))}
        {row('Draw calls', fmtInt(perf.drawCalls))}
        {row('Points / tris', `${fmtCompact(perf.points)} / ${fmtCompact(perf.triangles)}`)}
        {row('GPU geometries', fmtInt(perf.geometries))}
        {row('Simulation time', `${Math.floor(years).toLocaleString('en-US')} yr`)}
        {row('Seed', String(seed))}
        <div className="toggle-row" style={{ marginTop: 8 }}>
          <button className="btn small" onClick={() => runtime.togglePause()}>
            Pause
          </button>
          <button className="btn small" onClick={() => runtime.step()}>
            Tick
          </button>
          <button className="btn small" onClick={() => runtime.resetToBigBang()}>
            Reset
          </button>
          <button className="btn small warn" onClick={() => runtime.sim && runtime.boot(runtime.sim.config)}>
            Regenerate
          </button>
        </div>
        <div className="field" style={{ marginTop: 8, marginBottom: 4 }}>
          <label>Speed</label>
          <select value={speed} onChange={(e) => runtime.setSpeed(+e.target.value)}>
            {SPEED_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="kicker" style={{ marginTop: 6 }}>Render</div>
        <div className="toggle-row" style={{ marginTop: 4 }}>
          {(Object.keys(settings) as (keyof typeof settings)[]).map((k) => (
            <button key={k} className={`chip ${settings[k] ? 'on' : ''}`} onClick={() => toggle(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
