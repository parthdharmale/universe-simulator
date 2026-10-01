import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { OBSERVE_DURATIONS, techLabel } from '../engine/sim/observer';
import { fmtCompact } from '../engine/core/format';
import { formatDuration } from '../engine/core/time';

export function ObserverModal() {
  const set = useUI((s) => s.set);
  const civId = useUI((s) => s.civMapCiv);
  const obs = useUI((s) => s.observer);
  useUI((s) => s.revision);
  const sim = runtime.sim;
  const civ = sim && civId !== null ? sim.civs.civs[civId] : null;
  if (!sim || !civ) return null;
  const close = () => {
    if (obs?.running) runtime.cancelObserver();
    set({ modal: null, observer: null });
  };
  const s = obs?.summary;
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="kicker">Observer mode</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
              {civ.code} · {civ.name}
            </div>
          </div>
          <button className="icon-btn" onClick={close}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {!obs && (
            <>
              <div className="dim" style={{ marginBottom: 12 }}>
                Observe this civilization for:
              </div>
              <div className="toggle-row">
                {OBSERVE_DURATIONS.map((d) => (
                  <button key={d.years} className="btn" disabled={!civ.alive} onClick={() => runtime.startObserver(civ.id, d.years)}>
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="iv-note" style={{ marginTop: 12 }}>
                The whole universe runs forward (deterministically) while you watch; the summary is computed from the civilization's actual state and event history.
              </div>
            </>
          )}
          {obs?.running && (
            <>
              <div className="dim" style={{ marginBottom: 8 }}>
                Observing for {formatDuration(obs.duration)}…
              </div>
              <div className="progress">
                <i style={{ width: `${runtime.observerProgress() * 100}%` }} />
              </div>
            </>
          )}
          {s && (
            <>
              <div className="dim">
                {formatDuration(s.t1 - s.t0)} observed · year {Math.floor(s.t0).toLocaleString('en-US')} → {Math.floor(s.t1).toLocaleString('en-US')}
              </div>
              <div className="obs-grid">
                <Cell k="Population" v={s.populationChange === null ? '—' : `${s.populationChange >= 0 ? '+' : ''}${(s.populationChange * 100).toFixed(0)}%`} tone={s.populationChange !== null && s.populationChange < 0 ? 'bad' : 'good'} sub={`${fmtCompact(s.populationBefore)} → ${fmtCompact(s.populationAfter)}`} />
                <Cell k="Technology" v={`L${Math.floor(s.techBefore)} → L${Math.floor(s.techAfter)}`} sub={techLabel(s.techAfter)} />
                <Cell k="Wars" v={`${s.wars}`} tone={s.wars ? 'warn' : undefined} />
                <Cell k="Colonies" v={`${s.coloniesBefore} → ${s.coloniesAfter}`} sub={`${s.starSystemsAfter} star systems`} />
                <Cell k="Major discoveries" v={`${s.discoveries}`} />
                <Cell k="Extinction risk" v={s.extinct ? 'EXTINCT' : s.risk} tone={s.extinct || s.risk === 'HIGH' || s.risk === 'CRITICAL' ? 'bad' : s.risk === 'LOW' ? 'good' : 'warn'} />
                <Cell k="Famines" v={`${s.famines}`} />
                <Cell k="Pandemics" v={`${s.pandemics}`} />
                <Cell k="Collapses" v={`${s.collapses}`} tone={s.collapses ? 'bad' : undefined} />
              </div>
              {s.majorEvents.length > 0 && (
                <div className="section">
                  <div className="section-title">Key events</div>
                  {s.majorEvents.map((e, i) => (
                    <div className="row" key={i}>
                      <span className="lab mono">+{formatDuration(e.t - s.t0)}</span>
                      <span className="val" style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}>
                        {e.title}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="toggle-row" style={{ marginTop: 14 }}>
                <button className="btn" onClick={() => set({ observer: null })}>
                  Observe again
                </button>
                <button className="btn ghost" onClick={() => set({ modal: 'civmap' })}>
                  Open civilization map
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Cell({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div className="obs-cell">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
      {sub && <div className="mono faint" style={{ fontSize: 10, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
