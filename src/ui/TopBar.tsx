import { useEffect, useMemo, useRef, useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { EntityRef } from '../engine/sim/types';
import { planetLetter, moonNumeral, starId } from '../engine/core/names';
import { search, SearchResult } from '../engine/sim/search';

function crumbs(ref: EntityRef): { label: string; ref: EntityRef }[] {
  const sim = runtime.sim;
  const out: { label: string; ref: EntityRef }[] = [{ label: 'Universe', ref: { kind: 'universe' } }];
  if (!sim || ref.kind === 'universe') return out;
  if (ref.kind === 'civ') {
    const c = sim.civs.civs[ref.civ!];
    if (!c) return out;
    return [...crumbs({ kind: 'planet', g: c.g, s: c.s, p: c.p }), { label: c.code, ref }];
  }
  if (ref.g !== undefined) out.push({ label: sim.universe.galaxies[ref.g]?.name ?? `G${ref.g}`, ref: { kind: 'galaxy', g: ref.g } });
  if (ref.s !== undefined) out.push({ label: starId(ref.g!, ref.s), ref: { kind: 'star', g: ref.g, s: ref.s } });
  if (ref.p !== undefined) out.push({ label: `planet ${planetLetter(ref.p)}`, ref: { kind: 'planet', g: ref.g, s: ref.s, p: ref.p } });
  if (ref.m !== undefined) out.push({ label: `moon ${moonNumeral(ref.m)}`, ref });
  return out;
}

export function TopBar() {
  const focus = useUI((s) => s.focus);
  const seed = useUI((s) => s.seed);
  const set = useUI((s) => s.set);
  const panels = useUI((s) => s.panels);
  const togglePanel = useUI((s) => s.togglePanel);
  const items = useMemo(() => crumbs(focus), [focus]);
  return (
    <div className="topbar">
      <div className="panel brand" style={{ position: 'relative' }}>
        <div className="brand-mark" />
        <div className="brand-name">Universe Simulator</div>
        <div className="brand-seed" title="Universe seed — the same seed always generates the same universe">
          SEED {seed}
        </div>
      </div>
      <div className="panel crumbs" style={{ position: 'relative' }}>
        {items.map((c, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <span className="crumb-sep">›</span>}
            <button className={`crumb ${i === items.length - 1 ? 'current' : ''}`} onClick={() => runtime.select(c.ref.kind === 'universe' ? { kind: 'universe' } : c.ref, true)}>
              {c.label}
            </button>
          </span>
        ))}
      </div>
      <div className="topbar-spacer" />
      <SearchBox />
      <div className="panel menu" style={{ position: 'relative' }}>
        <button className={`icon-btn ${panels.stats ? 'accent' : ''}`} onClick={() => togglePanel('stats')} title="Statistics">STATS</button>
        <button className={`icon-btn ${panels.feed ? 'accent' : ''}`} onClick={() => togglePanel('feed')} title="Event feed">FEED</button>
        <button className={`icon-btn ${panels.inspector ? 'accent' : ''}`} onClick={() => togglePanel('inspector')} title="Inspector">INSPECT</button>
        <button className={`icon-btn ${panels.debug ? 'accent' : ''}`} onClick={() => togglePanel('debug')} title="Debug (`)">DEBUG</button>
        <button className="icon-btn" onClick={() => set({ modal: 'saves' })} title="Save / load / export / import">SAVE·LOAD</button>
        <button className="icon-btn" onClick={() => set({ modal: 'new' })} title="New universe">NEW</button>
        <button className="icon-btn" onClick={() => set({ modal: 'help' })} title="Help (?)">?</button>
      </div>
    </div>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const revision = useUI((s) => Math.floor(s.revision / 16));
  const ref = useRef<HTMLDivElement>(null);
  const results: SearchResult[] = useMemo(() => (runtime.sim && q.trim() ? search(runtime.sim, q) : []), [q, revision]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const choose = (r: SearchResult) => {
    runtime.select(r.ref, true);
    setOpen(false);
    (document.activeElement as HTMLElement)?.blur();
  };
  return (
    <div className="panel search" ref={ref} style={{ position: 'relative' }}>
      <span className="faint">⌕</span>
      <input
        id="global-search"
        value={q}
        placeholder="Search galaxy, star, planet, civilization, species…"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter' && results[active]) choose(results[active]);
          else if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <kbd>/</kbd>
      {open && q.trim() && (
        <div className="panel search-results">
          {results.length === 0 && <div className="empty">No matches. Try a civilization code (e.g. “A-1234”), a galaxy name, a species, or an ID like “G12-S345-b”.</div>}
          {results.map((r, i) => (
            <button key={i} className={`search-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}>
              <div className="lbl">
                <span className="kind">{r.kind}</span>
                {r.label}
              </div>
              {r.lines.map((l, j) => (
                <div className="line" key={j}>
                  {l}
                </div>
              ))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
