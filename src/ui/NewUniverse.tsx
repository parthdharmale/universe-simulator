import { useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';

export function NewUniverseModal() {
  const set = useUI((s) => s.set);
  const cur = { seed: useUI((s) => s.seed), galaxyCount: useUI((s) => s.galaxyCount), starDensity: useUI((s) => s.starDensity) };
  const [seed, setSeed] = useState(String(cur.seed));
  const [galaxies, setGalaxies] = useState(cur.galaxyCount);
  const [density, setDensity] = useState(cur.starDensity);
  const start = (s: number) => {
    set({ modal: null });
    const url = new URL(location.href);
    url.searchParams.set('seed', String(s));
    url.searchParams.set('galaxies', String(galaxies));
    url.searchParams.set('density', String(density));
    history.replaceState(null, '', url);
    void runtime.boot({ seed: s, galaxyCount: galaxies, starDensity: density });
  };
  const parsed = Number(seed.replace(/[,\s]/g, ''));
  const valid = Number.isInteger(parsed) && parsed > 0 && parsed < 2 ** 32;
  return (
    <div className="modal-backdrop" onClick={() => set({ modal: null })}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ fontSize: 14, fontWeight: 600 }}>New universe</div>
          <button className="icon-btn" onClick={() => set({ modal: null })}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Seed</label>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} />
          </div>
          <div className="field">
            <label>Galaxies · {galaxies}</label>
            <input type="range" min={16} max={256} step={8} value={galaxies} onChange={(e) => setGalaxies(+e.target.value)} />
          </div>
          <div className="field">
            <label>Star density · {density.toFixed(2)}× (≈{Math.round(3700 * density).toLocaleString('en-US')} catalog stars per galaxy)</label>
            <input type="range" min={0.25} max={3} step={0.25} value={density} onChange={(e) => setDensity(+e.target.value)} />
          </div>
          <div className="iv-note">The same seed and settings always generate exactly the same universe. Larger universes take longer to survey (all cores are used).</div>
          <div className="toggle-row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={!valid} onClick={() => start(parsed)}>
              Big Bang
            </button>
            <button className="btn ghost" onClick={() => start(1 + Math.floor(Math.random() * 999_999))}>
              Random seed
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
