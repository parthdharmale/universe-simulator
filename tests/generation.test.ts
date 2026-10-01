import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/core/rng';
import { generateUniverse, generateStarCatalog } from '../src/engine/gen/galaxy';
import { sampleKroupaMass } from '../src/engine/gen/star';
import { TAU } from '../src/engine/core/math';

describe('universe & galaxy generation', () => {
  const u = generateUniverse({ seed: 2024, galaxyCount: 120, starDensity: 1 });

  it('generates the requested galaxies with all required properties', () => {
    expect(u.galaxies.length).toBe(120);
    for (const g of u.galaxies) {
      expect(g.name.length).toBeGreaterThan(3);
      expect(['spiral', 'elliptical', 'irregular']).toContain(g.type);
      expect(g.radius).toBeGreaterThan(0);
      expect(g.mass).toBeGreaterThan(1e7);
      expect(g.starCount).toBeGreaterThanOrEqual(1000);
      expect(g.formation).toBeGreaterThan(0);
      expect(g.metallicity).toBeGreaterThan(-2);
      expect(Math.hypot(...g.normal)).toBeCloseTo(1, 9);
    }
    const types = new Set(u.galaxies.map((g) => g.type));
    expect(types.size).toBe(3);
    // Thousands of stars per galaxy on average.
    expect(u.totalStars / u.galaxies.length).toBeGreaterThan(2000);
  });

  it('galaxies do not overlap and cluster into a cosmic web', () => {
    const gs = u.galaxies;
    let overlaps = 0;
    for (let i = 0; i < gs.length; i++)
      for (let j = i + 1; j < gs.length; j++) {
        const d = Math.hypot(gs[i].position[0] - gs[j].position[0], gs[i].position[1] - gs[j].position[1], gs[i].position[2] - gs[j].position[2]);
        if (d < gs[i].radius + gs[j].radius) overlaps++;
      }
    expect(overlaps).toBe(0);
    // Morphology–density relation: clusters are elliptical-rich.
    const frac = (env: string, type: string) => {
      const sel = gs.filter((g) => g.environment === env);
      return sel.filter((g) => g.type === type).length / Math.max(1, sel.length);
    };
    expect(frac('cluster', 'elliptical')).toBeGreaterThan(frac('filament', 'elliptical'));
  });

  it('spiral galaxies put stars on logarithmic arms (not random blobs)', () => {
    const g = u.galaxies.find((x) => x.type === 'spiral' && x.barLength === 0)!;
    const cat = generateStarCatalog(g);
    // For each disk star, compute its angular offset from the nearest predicted arm.
    // Arm stars concentrate near 0; a featureless disk would be uniform.
    const r0 = Math.max(0.5, g.radius * 0.08);
    let near = 0, total = 0;
    for (let i = 0; i < cat.count; i++) {
      const r = Math.hypot(cat.x[i], cat.z[i]);
      if (r < g.radius * 0.2 || r > g.radius) continue;
      const theta = Math.atan2(cat.z[i], cat.x[i]);
      const spiral = Math.log(Math.max(r, r0) / r0) / Math.tan(g.pitch);
      let best = Infinity;
      for (let k = 0; k < g.arms; k++) {
        let d = (theta - spiral - (TAU * k) / g.arms) % TAU;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        best = Math.min(best, Math.abs(d));
      }
      total++;
      if (best < Math.PI / g.arms / 3) near++;
    }
    // Uniform angles would give ≈ 1/3 within ±(π/arms)/3 of an arm.
    expect(near / total).toBeGreaterThan(0.5);
  });

  it('elliptical galaxies are smooth spheroids with old stars', () => {
    const g = u.galaxies.find((x) => x.type === 'elliptical')!;
    const s = u.galaxies.find((x) => x.type === 'spiral')!;
    const ce = generateStarCatalog(g), cs = generateStarCatalog(s);
    const meanBirth = (c: typeof ce) => c.birth.reduce((a, b) => a + b, 0) / c.count;
    expect(meanBirth(ce) - g.formation).toBeLessThan(meanBirth(cs) - s.formation);
    // Thickness: ellipticals are 3-D, spirals are thin disks.
    const flat = (c: typeof ce) => {
      let sy = 0, sr = 0;
      for (let i = 0; i < c.count; i++) {
        sy += Math.abs(c.y[i]);
        sr += Math.hypot(c.x[i], c.z[i]);
      }
      return sy / sr;
    };
    expect(flat(ce)).toBeGreaterThan(flat(cs) * 3);
  });

  it('samples the Kroupa IMF: mostly M dwarfs, rare massive stars', () => {
    const r = new Rng(5);
    const N = 100_000;
    let low = 0, sunlike = 0, massive = 0;
    for (let i = 0; i < N; i++) {
      const m = sampleKroupaMass(r);
      expect(m).toBeGreaterThanOrEqual(0.08);
      expect(m).toBeLessThanOrEqual(100.0001);
      if (m < 0.5) low++;
      if (m > 0.8 && m < 1.2) sunlike++;
      if (m > 8) massive++;
    }
    expect(low / N).toBeGreaterThan(0.6);
    expect(sunlike / N).toBeGreaterThan(0.03);
    expect(massive / N).toBeLessThan(0.01);
    expect(massive).toBeGreaterThan(0);
  });

  it('later stellar generations are more metal-rich (chemical enrichment)', () => {
    const g = u.galaxies.find((x) => x.type === 'spiral')!;
    const c = generateStarCatalog(g);
    const idx = Array.from({ length: c.count }, (_, i) => i).sort((a, b) => c.birth[a] - c.birth[b]);
    const q = Math.floor(c.count / 4);
    const mean = (ids: number[]) => ids.reduce((s, i) => s + c.feh[i], 0) / ids.length;
    expect(mean(idx.slice(-q))).toBeGreaterThan(mean(idx.slice(0, q)) + 0.2);
  });
});
