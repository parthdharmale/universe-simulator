import { useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { PRESENT_YEARS, MAX_YEARS } from '../engine/core/constants';
import { formatDuration } from '../engine/core/time';

const VIEW_MAX = 20e9;
const toX = (t: number) => Math.sqrt(Math.max(0, Math.min(VIEW_MAX, t)) / VIEW_MAX);
const fromX = (x: number) => x * x * VIEW_MAX;

/** Accepts "4,000,000,000", "4e9", "4 Gyr", "13.7B", "250 Myr", "10k". */
export function parseYears(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const m = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(k|kyr|m|myr|b|g|gyr|bn|y|yr|years)?$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const mult: Record<string, number> = { k: 1e3, kyr: 1e3, m: 1e6, myr: 1e6, b: 1e9, bn: 1e9, g: 1e9, gyr: 1e9, y: 1, yr: 1, years: 1 };
  const out = v * (m[2] ? mult[m[2]] : 1);
  return Number.isFinite(out) ? out : null;
}

const MARKS = [
  { t: 3.8e5, label: 'CMB' },
  { t: 1.5e8, label: 'First stars' },
  { t: 1e9, label: '1 Gyr' },
  { t: 3.5e9, label: 'Star-formation peak' },
  { t: 9.2e9, label: 'Sun forms*' },
  { t: PRESENT_YEARS, label: 'Present' },
  { t: 20e9, label: '20 Gyr' },
];

export function TimeMachine() {
  const years = useUI((s) => s.years);
  const phase = useUI((s) => s.phase);
  const [hover, setHover] = useState<number | null>(null);
  const [text, setText] = useState('4,000,000,000');
  const [mode, setMode] = useState<'after' | 'ago'>('after');
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    const v = parseYears(text);
    if (v === null) {
      setErr('Unrecognised year');
      return;
    }
    const target = mode === 'after' ? v : PRESENT_YEARS - v;
    if (target < 0 || target > MAX_YEARS) {
      setErr(`Must lie between the Big Bang and ${formatDuration(MAX_YEARS)}`);
      return;
    }
    setErr(null);
    void runtime.jumpTo(target);
  };
  return (
    <div className="panel timemachine" style={{ position: 'absolute' }}>
      <div className="tm-row" style={{ justifyContent: 'space-between' }}>
        <span className="panel-title">
          <span className="dot" /> Time machine
        </span>
        <span className="mono dim" style={{ fontSize: 10.5 }}>
          {years <= PRESENT_YEARS ? `${formatDuration(PRESENT_YEARS - years)} before present` : `${formatDuration(years - PRESENT_YEARS)} after present`}
        </span>
      </div>
      <div
        className="tm-track"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          if (phase !== 'ready') return;
          const r = e.currentTarget.getBoundingClientRect();
          void runtime.jumpTo(fromX(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))));
        }}
      >
        <div className="tm-axis" />
        <div className="tm-fill" style={{ width: `${toX(years) * 100}%` }} />
        {MARKS.map((m) => (
          <div key={m.label}>
            <div className={m.label === 'Present' ? 'tm-present' : 'tm-mark'} style={{ left: `${toX(m.t) * 100}%` }} />
            <div className="tm-mark-label" style={{ left: `${toX(m.t) * 100}%`, color: m.label === 'Present' ? 'var(--good)' : undefined }}>
              {m.label}
            </div>
          </div>
        ))}
        <div className="tm-now" style={{ left: `${toX(years) * 100}%` }} />
        <div className="tm-now-label" style={{ left: `${toX(years) * 100}%` }}>
          NOW
        </div>
        {hover !== null && (
          <div className="tm-hover" style={{ left: `${hover * 100}%` }}>
            {formatDuration(fromX(hover))}
          </div>
        )}
      </div>
      <div className="tm-row" style={{ marginTop: 10 }}>
        <div className="tm-input">
          <span className="kicker">Year</span>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="e.g. 4,000,000,000 or 4.5 Gyr" />
          <select value={mode} onChange={(e) => setMode(e.target.value as 'after' | 'ago')}>
            <option value="after">after Big Bang</option>
            <option value="ago">years ago</option>
          </select>
          <button className="btn small" onClick={go} disabled={phase !== 'ready'}>
            Jump
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {err && <span className="warn" style={{ fontSize: 10.5 }}>{err}</span>}
        <button className="btn ghost small" onClick={() => runtime.resetToBigBang()} disabled={phase !== 'ready'} title="Return to t = 0 (interventions are kept and replay)">
          Big Bang
        </button>
        <button className="btn ghost small" onClick={() => void runtime.jumpToPresent()} disabled={phase !== 'ready'}>
          Present day
        </button>
      </div>
    </div>
  );
}
