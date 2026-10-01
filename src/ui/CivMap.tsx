import { useEffect, useMemo, useRef, useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { terrainHeight } from '../engine/gen/terrain';
import { citySites, civGeography, CivGeography } from '../engine/civ/cities';
import { TECH_NAMES, techLevel, totalPopulation } from '../engine/civ/civilization';
import { planetLook } from '../render/planetLook';
import { fmtCompact } from '../engine/core/format';
import { planetId } from '../engine/core/names';

const W = 720, H = 360;
// Fixed-order categorical palette for nations (never cycled: nation count ≤ 8).
const NATION_COLORS = ['#4f9dff', '#ff8a4c', '#3fd0a4', '#d36cff', '#ffd24a', '#ff5f7e', '#8fd14f', '#4fd2e0'];

const heightCache = new Map<number, Float32Array>();

/** Equirectangular height field, computed incrementally (rows per frame) to keep the UI live. */
function useHeightField(seed: number | null): { field: Float32Array | null; progress: number } {
  const [state, setState] = useState<{ field: Float32Array | null; progress: number }>({ field: seed !== null ? heightCache.get(seed) ?? null : null, progress: 0 });
  useEffect(() => {
    if (seed === null) return;
    const cached = heightCache.get(seed);
    if (cached) {
      setState({ field: cached, progress: 1 });
      return;
    }
    const f = new Float32Array(W * H);
    let row = 0;
    let cancelled = false;
    const work = () => {
      if (cancelled) return;
      const t0 = performance.now();
      while (row < H && performance.now() - t0 < 12) {
        const lat = (0.5 - (row + 0.5) / H) * Math.PI;
        const cl = Math.cos(lat), sl = Math.sin(lat);
        for (let x = 0; x < W; x++) {
          const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
          f[row * W + x] = terrainHeight(cl * Math.cos(lon), sl, cl * Math.sin(lon), seed);
        }
        row++;
      }
      if (row < H) {
        setState({ field: null, progress: row / H });
        requestAnimationFrame(work);
      } else {
        heightCache.set(seed, f);
        if (heightCache.size > 6) heightCache.delete(heightCache.keys().next().value as number);
        setState({ field: f, progress: 1 });
      }
    };
    work();
    return () => {
      cancelled = true;
    };
  }, [seed]);
  return state;
}

const lonX = (lon: number) => ((lon + Math.PI) / (2 * Math.PI)) * W;
const latY = (lat: number) => (0.5 - lat / Math.PI) * H;

export function CivMapModal() {
  const civId = useUI((s) => s.civMapCiv);
  const revision = useUI((s) => s.revision);
  const set = useUI((s) => s.set);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sim = runtime.sim;
  const civ = sim && civId !== null ? sim.civs.civs[civId] : null;
  const dyn = sim && civ ? sim.queries.planetAt(civ.g, civ.s, civ.p, sim.now()) : null;
  const look = useMemo(() => (dyn ? planetLook(dyn) : null), [dyn?.type, dyn?.life.stage, Math.round((dyn?.climate.liquidWater ?? 0) * 200), Math.round((dyn?.climate.ice ?? 0) * 100)]);
  const { field, progress } = useHeightField(look?.seed ?? null);
  const geo: CivGeography | null = useMemo(() => {
    if (!civ || !look) return null;
    const sites = citySites(look.seed, look.seaLevel, civ.seed);
    return civGeography(civ, sites, look.seed, look.seaLevel);
  }, [civ?.id, look, Math.floor(revision / 4)]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !field || !look || !geo || !civ) return;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const sea = look.seaLevel;
    const nations = geo.cities.filter((c) => c.capital);
    const L = techLevel(civ.tech);
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      const ice = Math.abs(lat) > look.iceLat;
      for (let x = 0; x < W; x++) {
        const h = field[y * W + x];
        let r: number, g: number, b: number;
        if (h < sea) {
          const d = Math.min(1, (sea - h) / 0.18);
          r = look.shallow[0] + (look.deep[0] - look.shallow[0]) * d;
          g = look.shallow[1] + (look.deep[1] - look.shallow[1]) * d;
          b = look.shallow[2] + (look.deep[2] - look.shallow[2]) * d;
        } else {
          const e = Math.min(1, (h - sea) / Math.max(0.05, 1 - sea));
          const lo = e < 0.45 ? look.low : look.high, hi = e < 0.45 ? look.high : look.peak;
          const f = e < 0.45 ? e / 0.45 : (e - 0.45) / 0.55;
          r = lo[0] + (hi[0] - lo[0]) * f;
          g = lo[1] + (hi[1] - lo[1]) * f;
          b = lo[2] + (hi[2] - lo[2]) * f;
          const veg = look.vegetation * (1 - Math.min(1, Math.abs(lat) / 1.25)) * (1 - Math.min(1, e / 0.6));
          r = r * (1 - veg) + 0.12 * veg;
          g = g * (1 - veg) + 0.27 * veg;
          b = b * (1 - veg) + 0.09 * veg;
          // Shaded relief from the east–west gradient.
          const hx = field[y * W + ((x + 1) % W)] - h;
          const shade = Math.max(0.6, Math.min(1.35, 1 + hx * 18));
          r *= shade;
          g *= shade;
          b *= shade;
        }
        if (ice) {
          r = r * 0.15 + 0.85 * 0.92;
          g = g * 0.15 + 0.85 * 0.94;
          b = b * 0.15 + 0.85 * 0.98;
        }
        const i = (y * W + x) * 4;
        img.data[i] = Math.min(255, r * 255);
        img.data[i + 1] = Math.min(255, g * 255);
        img.data[i + 2] = Math.min(255, b * 255);
        img.data[i + 3] = 255;
      }
    }
    // Political territories: each land pixel within reach of settlement belongs to the
    // nearest capital (great-circle Voronoi), clipped to explored territory.
    if (L >= 1 && nations.length) {
      const reach = 0.25 + 1.6 * civ.territory;
      const step = 3;
      for (let y = 0; y < H; y += step) {
        const lat = (0.5 - (y + 0.5) / H) * Math.PI;
        for (let x = 0; x < W; x += step) {
          if (field[y * W + x] < sea) continue;
          const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
          const p = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
          let best = -1, bd = -2, nearestCity = -2;
          for (let k = 0; k < nations.length; k++) {
            const c = nations[k].dir;
            const dot = c[0] * p[0] + c[1] * p[1] + c[2] * p[2];
            if (dot > bd) {
              bd = dot;
              best = k;
            }
          }
          for (const c of geo.cities) nearestCity = Math.max(nearestCity, c.dir[0] * p[0] + c.dir[1] * p[1] + c.dir[2] * p[2]);
          if (Math.acos(Math.min(1, nearestCity)) > reach) continue;
          const col = NATION_COLORS[best % NATION_COLORS.length];
          const cr = parseInt(col.slice(1, 3), 16), cg = parseInt(col.slice(3, 5), 16), cb = parseInt(col.slice(5, 7), 16);
          const k = nations.length > 1 ? 0.28 : 0.1;
          for (let dy = 0; dy < step && y + dy < H; dy++)
            for (let dx = 0; dx < step && x + dx < W; dx++) {
              const i = ((y + dy) * W + x + dx) * 4;
              img.data[i] = img.data[i] * (1 - k) + cr * k;
              img.data[i + 1] = img.data[i + 1] * (1 - k) + cg * k;
              img.data[i + 2] = img.data[i + 2] * (1 - k) + cb * k;
            }
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    // Roads / rail (great-circle polylines).
    ctx.lineWidth = L >= 2 ? 1.3 : 0.8;
    ctx.strokeStyle = L >= 3 ? 'rgba(255,230,170,0.75)' : 'rgba(230,205,160,0.55)';
    for (const [a, b] of geo.roads) {
      const A = geo.cities[a].dir, B = geo.cities[b].dir;
      ctx.beginPath();
      let prevX = NaN;
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const v = [A[0] * (1 - t) + B[0] * t, A[1] * (1 - t) + B[1] * t, A[2] * (1 - t) + B[2] * t];
        const n = Math.hypot(v[0], v[1], v[2]);
        const lat = Math.asin(v[1] / n), lon = Math.atan2(v[2], v[0]);
        const px = lonX(lon), py = latY(lat);
        if (k === 0 || Math.abs(px - prevX) > W / 2) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        prevX = px;
      }
      ctx.stroke();
    }
    // Resource deposits.
    for (const dp of geo.deposits) {
      const x = lonX(dp.lon), y = latY(dp.lat);
      const depleted = geo.depletion * (dp.kind === 'hydrocarbons' ? 1.2 : 0.8) > dp.richness;
      ctx.fillStyle = depleted ? 'rgba(120,120,120,0.7)' : dp.kind === 'metals' ? '#c9d2dc' : dp.kind === 'hydrocarbons' ? '#2a2a2a' : dp.kind === 'radioactives' ? '#9dff6a' : '#ff9de2';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 4);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Energy infrastructure.
    for (const inf of geo.infrastructure) {
      const x = lonX(inf.lon), y = latY(inf.lat);
      ctx.fillStyle = inf.kind === 'solar' ? '#5ac8ff' : inf.kind === 'fusion' ? '#c18bff' : inf.kind === 'fission' ? '#ffe14d' : inf.kind === 'coal' ? '#8a6a52' : inf.kind === 'beam' ? '#ff6bd5' : '#d8c08a';
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    // Cities.
    for (const c of geo.cities) {
      const x = lonX(c.lon), y = latY(c.lat);
      const r = 1.5 + c.size * 4.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = L >= 2 ? 'rgba(255,214,140,0.95)' : 'rgba(240,220,190,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (c.capital && L >= 1) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - r - 2, y - r - 2, (r + 2) * 2, (r + 2) * 2);
      }
      if (c.spaceport) {
        ctx.fillStyle = '#7dfcd0';
        ctx.beginPath();
        ctx.moveTo(x + r + 3, y - 6);
        ctx.lineTo(x + r + 7, y + 2);
        ctx.lineTo(x + r - 1, y + 2);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Graticule.
    ctx.strokeStyle = 'rgba(160,200,255,0.08)';
    ctx.lineWidth = 1;
    for (let k = 1; k < 6; k++) {
      ctx.beginPath();
      ctx.moveTo(0, (H * k) / 6);
      ctx.lineTo(W, (H * k) / 6);
      ctx.stroke();
    }
    for (let k = 1; k < 12; k++) {
      ctx.beginPath();
      ctx.moveTo((W * k) / 12, 0);
      ctx.lineTo((W * k) / 12, H);
      ctx.stroke();
    }
  }, [field, look, geo, civ?.id]);

  if (!sim || !civ) return null;
  const L = techLevel(civ.tech);
  return (
    <div className="modal-backdrop" onClick={() => set({ modal: null })}>
      <div className="modal civmap" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="kicker">Civilization view · {planetId(civ.g, civ.s, civ.p)}</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
              {civ.code} · {civ.name}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span className="mono dim">Tech {L} · {TECH_NAMES[L]}</span>
            <span className="mono dim">Pop {fmtCompact(totalPopulation(civ))}</span>
            <span className="mono dim">{geo?.nations ?? 0} nation{geo?.nations === 1 ? '' : 's'}</span>
            <span className="mono dim">{geo?.cities.length ?? 0} cities</span>
            {!civ.alive && <span className="badge bad">EXTINCT</span>}
            <button className="icon-btn" onClick={() => set({ modal: null })}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">
          {!field ? (
            <div style={{ padding: 40 }}>
              <div className="dim" style={{ marginBottom: 10 }}>
                Projecting planetary terrain… {(progress * 100).toFixed(0)}%
              </div>
              <div className="progress">
                <i style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
          ) : (
            <canvas ref={canvasRef} width={W} height={H} style={{ aspectRatio: `${W} / ${H}` }} />
          )}
          <div className="legend">
            <span><i style={{ background: '#ffd68c', borderRadius: '50%' }} />City (size ∝ population)</span>
            <span><i style={{ border: '1px solid #fff', background: 'transparent' }} />Capital</span>
            <span><i style={{ background: 'rgba(255,230,170,0.75)', height: 2 }} />{L >= 3 ? 'Highways & rail' : 'Roads'}</span>
            <span><i style={{ background: '#c9d2dc', transform: 'rotate(45deg)' }} />Metals</span>
            <span><i style={{ background: '#2a2a2a', transform: 'rotate(45deg)' }} />Hydrocarbons</span>
            <span><i style={{ background: '#9dff6a', transform: 'rotate(45deg)' }} />Radioactives</span>
            <span><i style={{ background: '#ff9de2', transform: 'rotate(45deg)' }} />Rare elements</span>
            <span><i style={{ background: 'rgba(120,120,120,0.7)', transform: 'rotate(45deg)' }} />Depleted</span>
            <span><i style={{ background: '#ffe14d' }} />Fission</span>
            <span><i style={{ background: '#c18bff' }} />Fusion</span>
            <span><i style={{ background: '#5ac8ff' }} />Solar</span>
            <span><i style={{ background: '#8a6a52' }} />Fossil plant</span>
            <span><i style={{ background: '#7dfcd0' }} />Spaceport</span>
          </div>
          <div className="iv-note">
            Territory covers {(civ.territory * 100).toFixed(0)}% of habitable land · resources {((civ.resources / Math.max(1, civ.resourcesMax)) * 100).toFixed(0)}% of endowment · stability {(civ.stability * 100).toFixed(0)}%. The map is regenerated from the civilization's live state — leave it open while time runs to watch it evolve.
          </div>
        </div>
      </div>
    </div>
  );
}
