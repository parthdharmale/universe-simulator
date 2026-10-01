import { useMemo, useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { describe, EntityInfo } from '../engine/sim/describe';
import { historyOf, HistoryEntry } from '../engine/sim/history';
import { formatAgo } from '../engine/core/time';
import { refKey } from '../engine/sim/types';
import { InterventionPanel } from './InterventionPanel';

export function Inspector() {
  const selected = useUI((s) => s.selected);
  const revision = useUI((s) => s.revision);
  const tog = useUI((s) => s.togglePanel);
  const set = useUI((s) => s.set);
  const [tab, setTab] = useState<'overview' | 'history' | 'intervene'>('overview');
  const ref = selected ?? { kind: 'universe' as const };
  const info: EntityInfo | null = useMemo(() => (runtime.sim?.ready ? describe(runtime.sim, ref) : null), [refKey(ref), revision]);
  const civId = info?.civIds[0];
  return (
    <div className="panel inspector">
      {!info ? (
        <div className="empty">Generating universe…</div>
      ) : (
        <>
          <div className="insp-head">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="insp-headline">{info.headline}</div>
              <button className="icon-btn" onClick={() => tog('inspector')}>
                ✕
              </button>
            </div>
            <div className="insp-name">{info.name}</div>
            <div className="insp-sub">{info.subtitle}</div>
            <div className="badges">
              {info.badges.map((b, i) => (
                <span key={i} className={`badge ${b.tone}`}>
                  {b.text}
                </span>
              ))}
            </div>
          </div>
          <div className="tabs">
            {(['overview', 'history', 'intervene'] as const).map((t) => (
              <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="insp-body">
            {tab === 'overview' && <Overview info={info} />}
            {tab === 'history' && <History key={refKey(ref)} revision={revision} />}
            {tab === 'intervene' && <InterventionPanel info={info} />}
          </div>
          <div className="insp-actions">
            {info.ref.kind !== 'universe' && (
              <button className="btn small" onClick={() => runtime.select(info.ref, true)}>
                Focus
              </button>
            )}
            {info.parent && (
              <button className="btn ghost small" onClick={() => runtime.select(info.parent!.kind === 'universe' ? { kind: 'universe' } : info.parent, true)}>
                ↑ Parent
              </button>
            )}
            {civId !== undefined && (
              <>
                <button className="btn small" onClick={() => set({ modal: 'civmap', civMapCiv: civId })}>
                  Civilization map
                </button>
                <button className="btn small" onClick={() => set({ modal: 'observer', civMapCiv: civId, observer: null })}>
                  Observe
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Overview({ info }: { info: EntityInfo }) {
  return (
    <>
      {info.sections.map((sec) =>
        sec.rows.length ? (
          <div className="section" key={sec.title}>
            <div className="section-title">{sec.title}</div>
            {sec.rows.map((r, i) => (
              <div className="row" key={i} title={r.hint}>
                <span className="lab">{r.label}</span>
                <span>
                  <div className={`val ${r.tone ?? ''}`}>{r.value}</div>
                  {r.bar !== undefined && (
                    <div className="meter">
                      <i style={{ width: `${Math.max(0, Math.min(1, r.bar)) * 100}%` }} />
                    </div>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : null,
      )}
      {info.children.length > 0 && (
        <div className="section">
          <div className="section-title">{info.childrenTitle ?? 'Contents'}</div>
          {info.children.slice(0, 60).map((c, i) => (
            <button key={i} className={`child-link ${c.tone ?? ''}`} onClick={() => runtime.select(c.ref, true)}>
              <span className="l">{c.label}</span>
              <span className="s">{c.sub}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function History({ revision }: { revision: number }) {
  const selected = useUI((s) => s.selected) ?? { kind: 'universe' as const };
  const [open, setOpen] = useState<number | null>(null);
  const entries: HistoryEntry[] = useMemo(() => (runtime.sim?.ready ? historyOf(runtime.sim, selected) : []), [refKey(selected), Math.floor(revision / 8)]);
  const now = runtime.sim?.now() ?? 0;
  if (!entries.length) return <div className="empty">No recorded history yet at this point in time.</div>;
  const shown = entries.slice(-250);
  return (
    <div className="hist">
      {entries.length > shown.length && <div className="faint" style={{ fontSize: 10.5, marginBottom: 6 }}>{entries.length - shown.length} earlier entries omitted</div>}
      {shown.map((e, i) => (
        <div key={i} className={`hist-item ${e.tone}`} onClick={() => setOpen(open === i ? null : i)}>
          <div className="hist-when">{formatAgo(e.t, now)}</div>
          <div className="hist-title">{e.title}</div>
          {open === i && (
            <div className="hist-detail">
              <div>{e.detail}</div>
              <div className="faint mono" style={{ marginTop: 6, fontSize: 10 }}>
                year {Math.floor(e.t).toLocaleString('en-US')}
              </div>
              {e.effects.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div className="kicker">State change</div>
                  {e.effects.map((f, j) => (
                    <div className="effect" key={j}>
                      <span className="dim">{f.label}</span>
                      <span>{f.before}</span>
                      <span className="arrow">→</span>
                      <span className="accent">{f.after}</span>
                    </div>
                  ))}
                </div>
              )}
              {e.ref && (
                <button className="btn small" style={{ marginTop: 8 }} onClick={(ev) => { ev.stopPropagation(); runtime.select(e.ref!, true); }}>
                  Go to
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
