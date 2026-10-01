import { useState } from 'react';
import { useUI } from '../store/store';
import { runtime } from '../app/runtime';
import { fmtCompact, fmtInt } from '../engine/core/format';
import { formatDuration } from '../engine/core/time';

type Series = { t: number; stars: number; life: number; civs: number; habitable: number }[];

/** Single-series sparkline (small multiple) with a hover crosshair + readout. */
function Spark({ data, k, label, color }: { data: Series; k: 'stars' | 'life' | 'civs' | 'habitable'; label: string; color: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length < 2) return null;
  const W = 240, H = 34;
  const max = Math.max(1, ...data.map((d) => d[k]));
  const x = (i: number) => (i / (data.length - 1)) * W;
  const y = (v: number) => H - 2 - (v / max) * (H - 6);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join('');
  const area = `${path}L${W},${H}L0,${H}Z`;
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="spark">
      <div className="spark-row">
        <span className="k">{label}</span>
        <span className="mono dim" style={{ fontSize: 10 }}>
          {h ? `${fmtCompact(h[k])} @ ${formatDuration(h.t, 1)}` : `peak ${fmtCompact(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(((e.clientX - r.left) / r.width) * (data.length - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${label} over cosmic time, peak ${fmtInt(max)}`}
      >
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(126,176,230,0.15)" strokeWidth="1" />
        <path d={area} fill={color} opacity="0.1" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {h && hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="rgba(215,227,242,0.4)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(h[k])} r="2.5" fill={color} stroke="#070d18" strokeWidth="1" />
          </>
        )}
      </svg>
    </div>
  );
}

export function StatsPanel() {
  const st = useUI((s) => s.stats);
  const series = useUI((s) => s.series);
  const tog = useUI((s) => s.togglePanel);
  const cell = (k: string, v: string, cls = '', title?: string) => (
    <div className={`stat ${cls}`} title={title}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
  return (
    <div className="panel stats">
      <div className="panel-head">
        <span className="panel-title">
          <span className="dot" /> Universe statistics
        </span>
        <button className="icon-btn" onClick={() => tog('stats')}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {!st ? (
          <div className="faint">Surveying…</div>
        ) : (
          <>
            <div className="stat-grid">
              {cell('Galaxies', fmtInt(st.galaxies))}
              {cell('Stars', fmtInt(st.stars), '', 'Catalogued stars currently shining')}
              {cell('Planets', fmtInt(st.planets))}
              {cell('Remnants', fmtInt(st.remnants), '', 'White dwarfs, neutron stars, black holes')}
              {cell('Habitable planets', fmtInt(st.habitable), 'hl', 'Habitability index ≥ 0.4, host star on the main sequence')}
              {cell('Life-bearing', fmtInt(st.lifeBearing), 'hl')}
              {cell('Complex life', fmtInt(st.complexLife), 'hl')}
              {cell('Intelligent species', fmtInt(st.intelligent), 'hl')}
              {cell('Civilizations', fmtInt(st.civilizations), 'civ')}
              {cell('Spacefaring', fmtInt(st.spacefaring), 'civ', 'Technology level ≥ 4')}
              {cell('Interstellar', fmtInt(st.interstellar), 'civ')}
              {cell('Extinct civs', fmtInt(st.extinctCivs))}
              {cell('Population', fmtCompact(st.population), 'civ')}
              {cell('Colonies', fmtInt(st.colonies), 'civ')}
            </div>
            <Spark data={series} k="stars" label="Shining stars" color="#ffd27a" />
            <Spark data={series} k="life" label="Life-bearing worlds" color="#5be49b" />
            <Spark data={series} k="civs" label="Civilizations" color="#7dfcd0" />
            <button className="btn small" style={{ marginTop: 10, width: '100%' }} onClick={() => void runtime.watchNextEmergence()} title="Jump to the next moment a species founds a civilization, and follow it">
              ▶ Watch the next civilization rise
            </button>
          </>
        )}
      </div>
    </div>
  );
}
