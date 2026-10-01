import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { SPEED_PRESETS } from '../engine/sim/simulation';
import { epochAt } from '../engine/gen/cosmology';
import { formatDuration } from '../engine/core/time';
import { YEAR_S } from '../engine/core/constants';

function rateLabel(speed: number): string {
  const yps = speed / YEAR_S;
  if (yps >= 1) return `${formatDuration(yps, 1)} / s`;
  const sps = speed;
  if (sps >= 86400) return `${(sps / 86400).toFixed(1)} days / s`;
  if (sps >= 3600) return `${(sps / 3600).toFixed(1)} hours / s`;
  if (sps >= 60) return `${(sps / 60).toFixed(1)} min / s`;
  return `${sps.toFixed(0)} s / s (real time)`;
}

export function TimeControls() {
  const years = useUI((s) => s.years);
  const secs = useUI((s) => s.secondsIntoYear);
  const speed = useUI((s) => s.speed);
  const paused = useUI((s) => s.paused);
  const direction = useUI((s) => s.direction);
  const lagging = useUI((s) => s.lagging);
  const phase = useUI((s) => s.phase);
  const ep = epochAt(years);
  const showFine = speed < 1e9;
  const day = Math.floor(secs / 86400);
  const hh = Math.floor((secs % 86400) / 3600), mm = Math.floor((secs % 3600) / 60), ss = Math.floor(secs % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    <div className="panel timebox">
      <div className="clock">
        {Math.floor(years).toLocaleString('en-US')}
        <span className="unit">YEARS</span>
      </div>
      <div className="clock-sub">
        <span className="epoch" title={ep.description}>
          {ep.name}
        </span>
        {showFine && (
          <span className="mono">
            day {day + 1} · {pad(hh)}:{pad(mm)}:{pad(ss)}
          </span>
        )}
        <span className="rate">{paused ? 'PAUSED' : `${direction < 0 ? '◀◀ rewinding · ' : ''}${rateLabel(speed)}`}</span>
        {lagging && !paused && <span className="lag" title="The simulation work for this speed exceeds the frame budget; simulated time advances as fast as it can be computed exactly.">● compute-bound</span>}
      </div>
      <div className="speeds">
        <div className="transport">
          <button title="Rewind (play backward)" className={direction < 0 && !paused ? 'on' : ''} onClick={() => runtime.rewind()} disabled={phase !== 'ready'}>
            ◀◀
          </button>
          <button title="Pause / play (Space)" className={paused ? 'on' : ''} onClick={() => runtime.togglePause()}>
            {paused ? '▶' : '❚❚'}
          </button>
          <button title="Single simulation tick (.)" onClick={() => runtime.step()} disabled={phase !== 'ready'}>
            ▶|
          </button>
        </div>
        {SPEED_PRESETS.map((p) => (
          <button key={p.value} className={`speed ${speed === p.value && !paused && direction > 0 ? 'active' : ''}`} onClick={() => runtime.setSpeed(p.value)} title={rateLabel(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
