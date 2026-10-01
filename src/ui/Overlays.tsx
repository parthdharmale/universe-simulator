import { useUI } from '../store/store';
import { formatDuration } from '../engine/core/time';

export function Tooltip() {
  const h = useUI((s) => s.hover);
  if (!h) return null;
  return (
    <div className="tooltip" style={{ left: h.x, top: h.y }}>
      <div className="tt">{h.title}</div>
      <div className="ts">{h.sub}</div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div className="toast" key={t.id} onClick={() => dismiss(t.id)}>
          <div className="t">{t.title}</div>
          <div className="b">
            {t.body.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LoadingOverlay() {
  const phase = useUI((s) => s.phase);
  const p = useUI((s) => s.surveyProgress);
  const err = useUI((s) => s.error);
  const g = useUI((s) => s.galaxyCount);
  if (phase === 'ready') return null;
  return (
    <div className="loading">
      <div className="panel loading-card" style={{ position: 'relative' }}>
        <h2>{phase === 'error' ? 'Generation failed' : 'Big Bang'}</h2>
        {phase === 'error' ? (
          <p className="bad">{err}</p>
        ) : (
          <>
            <p>
              Surveying {g} galaxies across all CPU cores: generating star catalogs, every planetary system, and the evolutionary history of every biosphere. Time starts when the survey completes.
            </p>
            <div className="progress">
              <i style={{ width: `${p * 100}%` }} />
            </div>
            <div className="mono faint" style={{ fontSize: 10.5, marginTop: 6 }}>
              {(p * 100).toFixed(0)}% · {Math.round(p * g)}/{g} galaxies
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function JumpOverlay() {
  const jump = useUI((s) => s.jump);
  if (!jump) return null;
  return (
    <div className="loading" style={{ background: 'rgba(0,3,10,0.3)' }}>
      <div className="panel loading-card" style={{ position: 'relative' }}>
        <h2>Time machine</h2>
        <p>Travelling to year {Math.floor(jump.target).toLocaleString('en-US')} ({formatDuration(jump.target)} after the Big Bang). Civilization histories are replayed exactly from the nearest checkpoint.</p>
        <div className="progress">
          <i style={{ width: `${jump.progress * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export function HelpModal() {
  const set = useUI((s) => s.set);
  const keys: [string, string][] = [
    ['Left-drag', 'Orbit camera'],
    ['Right-drag / Shift-drag', 'Pan'],
    ['Wheel', 'Zoom (zoom far out to return to the parent object)'],
    ['Click', 'Select & fly to galaxy / star / planet / moon'],
    ['Esc', 'Up one level (planet → star → galaxy → universe)'],
    ['Space', 'Pause / resume'],
    ['[ ]', 'Slower / faster'],
    ['.', 'Single simulation tick'],
    ['/  or  ⌘K', 'Search'],
    ['F / H', 'Focus selection / home'],
    ['`', 'Debug panel'],
  ];
  return (
    <div className="modal-backdrop" onClick={() => set({ modal: null })}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ fontSize: 14, fontWeight: 600 }}>How to explore</div>
          <button className="icon-btn" onClick={() => set({ modal: null })}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="help-grid">
            {keys.map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <span>
                  <kbd>{k}</kbd>
                </span>
                <span className="dim">{v}</span>
              </span>
            ))}
          </div>
          <div className="iv-note" style={{ marginTop: 14 }}>
            Everything you see is simulated: stars live and die by their mass, planets are built from their disks, climates are solved from atmosphere and starlight, life evolves through great filters, and civilizations rise and fall by their own state. Select any object and open the <b>History</b> tab to see why it is the way it is, or <b>Intervene</b> to change it.
          </div>
        </div>
      </div>
    </div>
  );
}
