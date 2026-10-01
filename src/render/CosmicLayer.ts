import * as THREE from 'three';
import { Rng, hash32 } from '../engine/core/rng';
import { Vec3, smoothstep } from '../engine/core/math';
import { radiationTemperature, visualScale } from '../engine/gen/cosmology';
import { galaxyAngle } from '../engine/gen/galaxy';
import { Simulation } from '../engine/sim/simulation';
import {
  IMPOSTOR_FRAG,
  IMPOSTOR_VERT,
  LINK_FRAG,
  LINK_VERT,
  MARKER_FRAG,
  MARKER_VERT,
  PLASMA_FRAG,
  PLASMA_VERT,
  STAR_POINTS_FRAG,
  STAR_POINTS_VERT,
} from './shaders';

/**
 * CosmicLayer — everything at galactic scale, in kpc, drawn relative to the camera focus.
 *
 *  - Stars: ONE THREE.Points over every catalog star in the universe (~0.5M vertices).
 *    Position, colour, brightness and life phase (birth, main sequence, giant, remnant,
 *    supernova flash) are evaluated in the vertex shader from per-star attributes and the
 *    current time, so time travel costs nothing on the CPU.
 *  - Galaxy transforms (position × a(t) − focus, rotation angle) live in a 4×G float
 *    texture updated each frame (G ≈ 128 rows), so moving/rotating every galaxy is O(G).
 *  - Galaxy impostors: one instanced quad per galaxy, an analytic density model that
 *    matches the star generator — the far LOD; fades out as the camera approaches.
 *  - Primordial plasma: 100k particles collapsing from a uniform field onto dark-matter halos.
 *  - Civilization markers & expansion links, rebuilt only when civ state changes.
 */
const HUGE_SPHERE = new THREE.Sphere(new THREE.Vector3(), 1e12);

export class CosmicLayer {
  readonly scene = new THREE.Scene();
  private galTex: THREE.DataTexture;
  private galData: Float32Array;
  private starMat: THREE.ShaderMaterial;
  private stars: THREE.Points | null = null;
  private starGeo: THREE.BufferGeometry | null = null;
  private createdStars: THREE.Points | null = null;
  private plasma: THREE.Points;
  private plasmaMat: THREE.ShaderMaterial;
  private impostors: THREE.InstancedMesh;
  private impostorMat: THREE.ShaderMaterial;
  private iCenter: THREE.InstancedBufferAttribute;
  private iState: THREE.InstancedBufferAttribute;
  private markers: THREE.Points;
  private markerMat: THREE.ShaderMaterial;
  private links: THREE.LineSegments;
  private civSignature = '';
  private overrideVersion = -1;
  private patchedStars: { idx: number; life: [number, number, number, number] }[] = [];
  private grid: THREE.LineSegments;
  exposure = 3e4;
  visibleStars = 0;
  /** Device-pixel ratio of the render target (point sprites are sized in framebuffer pixels). */
  dpr = 1;
  private civSyncAt = 0;

  constructor(private sim: Simulation) {
    const G = sim.universe.galaxies.length;
    this.galData = new Float32Array(4 * 4 * G);
    this.galTex = new THREE.DataTexture(this.galData, 4, G, THREE.RGBAFormat, THREE.FloatType);
    this.galTex.minFilter = THREE.NearestFilter;
    this.galTex.magFilter = THREE.NearestFilter;
    this.galTex.needsUpdate = true;

    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_POINTS_VERT,
      fragmentShader: STAR_POINTS_FRAG,
      uniforms: {
        uGal: { value: this.galTex },
        uTime: { value: 0 },
        uPixel: { value: 800 },
        uExposure: { value: this.exposure },
        uNearHide: { value: 0 },
        uHighlightGal: { value: -1 },
        uDpr: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // ---- primordial plasma ----
    const N = 100_000;
    const rng = new Rng(hash32(sim.seed, 0x91a5));
    const seedPos = new Float32Array(N * 3);
    const off = new Float32Array(N * 3);
    const gal = new Float32Array(N);
    const rnd = new Float32Array(N);
    const weights = sim.universe.galaxies.map((g) => Math.sqrt(g.mass));
    const wsum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < N; i++) {
      let r: Vec3;
      do r = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
      while (r[0] * r[0] + r[1] * r[1] + r[2] * r[2] > 1);
      seedPos.set([r[0] * 2900, r[1] * 2900, r[2] * 2900], i * 3);
      let w = rng.next() * wsum;
      let gi = 0;
      for (; gi < G - 1; gi++) {
        w -= weights[gi];
        if (w < 0) break;
      }
      gal[i] = gi;
      const R = sim.universe.galaxies[gi].radius * 2.8;
      // Halos are connected along filaments: a fraction of gas trails toward neighbours.
      off.set([rng.gaussian(0, R), rng.gaussian(0, R), rng.gaussian(0, R)], i * 3);
      rnd[i] = rng.next();
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seedPos, 3));
    pg.setAttribute('aOffset', new THREE.BufferAttribute(off, 3));
    pg.setAttribute('aGal', new THREE.BufferAttribute(gal, 1));
    pg.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    this.plasmaMat = new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      uniforms: {
        uGal: { value: this.galTex },
        uScale: { value: 0.01 },
        uCluster: { value: 0 },
        uTempK: { value: 3000 },
        uFade: { value: 1 },
        uPixel: { value: 800 },
        uFocus: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    pg.boundingSphere = HUGE_SPHERE.clone();
    this.plasma = new THREE.Points(pg, this.plasmaMat);
    this.plasma.frustumCulled = false;
    this.scene.add(this.plasma);

    // ---- galaxy impostors ----
    const quad = new THREE.PlaneGeometry(2, 2);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = quad.index;
    ig.setAttribute('position', quad.getAttribute('position'));
    this.iCenter = new THREE.InstancedBufferAttribute(new Float32Array(G * 3), 3);
    this.iState = new THREE.InstancedBufferAttribute(new Float32Array(G * 4), 4);
    const iU = new Float32Array(G * 3), iV = new Float32Array(G * 3), iShape = new Float32Array(G * 4);
    sim.universe.galaxies.forEach((g, i) => {
      iU.set([g.u[0] * g.radius, g.u[1] * g.radius, g.u[2] * g.radius], i * 3);
      iV.set([g.v[0] * g.radius, g.v[1] * g.radius, g.v[2] * g.radius], i * 3);
      iShape.set([g.type === 'spiral' ? 0 : g.type === 'elliptical' ? 1 : 2, g.arms, g.pitch, (g.seed % 997) / 7], i * 4);
    });
    ig.setAttribute('iCenter', this.iCenter);
    ig.setAttribute('iU', new THREE.InstancedBufferAttribute(iU, 3));
    ig.setAttribute('iV', new THREE.InstancedBufferAttribute(iV, 3));
    ig.setAttribute('iShape', new THREE.InstancedBufferAttribute(iShape, 4));
    ig.setAttribute('iState', this.iState);
    ig.instanceCount = G;
    ig.boundingSphere = HUGE_SPHERE.clone();
    this.impostorMat = new THREE.ShaderMaterial({
      vertexShader: IMPOSTOR_VERT,
      fragmentShader: IMPOSTOR_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.impostors = new THREE.InstancedMesh(ig, this.impostorMat, G);
    this.impostors.frustumCulled = false;
    this.impostors.boundingSphere = HUGE_SPHERE.clone();
    this.scene.add(this.impostors);

    // ---- civilization markers & links ----
    this.markerMat = new THREE.ShaderMaterial({
      vertexShader: MARKER_VERT,
      fragmentShader: MARKER_FRAG,
      uniforms: { uGal: { value: this.galTex }, uSize: { value: 14 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const emptyGeo = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      g.boundingSphere = HUGE_SPHERE.clone();
      return g;
    };
    this.markers = new THREE.Points(emptyGeo(), this.markerMat);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 5;
    this.scene.add(this.markers);
    this.links = new THREE.LineSegments(
      emptyGeo(),
      new THREE.ShaderMaterial({ vertexShader: LINK_VERT, fragmentShader: LINK_FRAG, uniforms: { uGal: { value: this.galTex } }, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.links.frustumCulled = false;
    this.scene.add(this.links);

    // ---- faint reference grid in the universe's mean plane ----
    const gl: number[] = [];
    for (const r of [500, 1000, 1500, 2000, 2500, 3000]) {
      for (let k = 0; k < 128; k++) {
        const a0 = (k / 128) * Math.PI * 2, a1 = ((k + 1) / 128) * Math.PI * 2;
        gl.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      gl.push(Math.cos(a) * 500, 0, Math.sin(a) * 500, Math.cos(a) * 3000, 0, Math.sin(a) * 3000);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    this.grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x4a7fb0, transparent: true, opacity: 0.08, depthTest: false, depthWrite: false }));
    this.grid.frustumCulled = false;
    this.scene.add(this.grid);
  }

  /** Called once the survey is complete: upload every star in the universe. */
  buildStars() {
    const cat = this.sim.catalog;
    if (!cat) return;
    const N = cat.totalStars;
    const local = new Float32Array(N * 3);
    const galA = new Float32Array(N);
    const life = new Float32Array(N * 4);
    const phot = new Float32Array(N * 2);
    let o = 0;
    for (const sv of cat.surveys) {
      const c = sv.catalog;
      for (let i = 0; i < c.count; i++, o++) {
        local[o * 3] = c.x[i];
        local[o * 3 + 1] = c.y[i];
        local[o * 3 + 2] = c.z[i];
        galA[o] = sv.galaxy;
        life[o * 4] = c.birth[i] / 1e9;
        life[o * 4 + 1] = c.msEnd[i] / 1e9;
        life[o * 4 + 2] = c.death[i] / 1e9;
        life[o * 4 + 3] = c.mass[i];
        phot[o * 2] = c.temp[i];
        phot[o * 2 + 1] = c.lum[i];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aLocal', new THREE.BufferAttribute(local, 3));
    g.setAttribute('aGal', new THREE.BufferAttribute(galA, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 4));
    g.setAttribute('aPhot', new THREE.BufferAttribute(phot, 2));
    // Bounding sphere is irrelevant (frustumCulled = false) but three requires one to exist.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.starGeo = g;
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 1;
    this.scene.add(this.stars);
  }

  /** Re-apply intervention effects on the GPU buffers (destroyed / created stars). */
  private syncOverrides() {
    const ov = this.sim.overrides;
    if (ov.version === this.overrideVersion || !this.starGeo || !this.sim.catalog) return;
    this.overrideVersion = ov.version;
    const attr = this.starGeo.getAttribute('aLife') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (const p of this.patchedStars) arr.set(p.life, p.idx * 4);
    this.patchedStars = [];
    for (const [sk, t] of ov.destroyedStars) {
      const g = Math.floor(sk / 1_000_000), s = sk % 1_000_000;
      if (this.sim.queries.isCreatedStar(g, s)) continue;
      const idx = this.sim.catalog.starOffset[g] + s;
      const prev: [number, number, number, number] = [arr[idx * 4], arr[idx * 4 + 1], arr[idx * 4 + 2], arr[idx * 4 + 3]];
      this.patchedStars.push({ idx, life: prev });
      if (t / 1e9 < prev[2]) {
        arr[idx * 4 + 1] = t / 1e9;
        arr[idx * 4 + 2] = t / 1e9;
        arr[idx * 4 + 3] = Math.max(prev[3], 8); // destroyed stars flash like a supernova
      }
    }
    attr.needsUpdate = true;

    if (this.createdStars) {
      this.scene.remove(this.createdStars);
      this.createdStars.geometry.dispose();
      this.createdStars = null;
    }
    if (ov.createdStars.length) {
      const n = ov.createdStars.length;
      const local = new Float32Array(n * 3), galA = new Float32Array(n), life = new Float32Array(n * 4), phot = new Float32Array(n * 2);
      ov.createdStars.forEach((cs, i) => {
        const core = this.sim.queries.starCore(cs.g, cs.s)!;
        const ms = this.sim.queries.mainSequence(cs.g, cs.s)!;
        const d = ov.destroyedStars.get(cs.g * 1_000_000 + cs.s);
        local.set([cs.x, cs.y, cs.z], i * 3);
        galA[i] = cs.g;
        life.set([core.birth / 1e9, (d ?? core.msEnd) / 1e9, Math.min(d ?? Infinity, core.death) / 1e9, d !== undefined ? Math.max(8, cs.mass) : cs.mass], i * 4);
        phot.set([ms.temperature, ms.luminosity], i * 2);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aLocal', new THREE.BufferAttribute(local, 3));
      g.setAttribute('aGal', new THREE.BufferAttribute(galA, 1));
      g.setAttribute('aLife', new THREE.BufferAttribute(life, 4));
      g.setAttribute('aPhot', new THREE.BufferAttribute(phot, 2));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      this.createdStars = new THREE.Points(g, this.starMat);
      this.createdStars.frustumCulled = false;
      this.scene.add(this.createdStars);
    }
  }

  private syncCivs() {
    // Throttled: civ state changes at most a few times per second visually.
    const now = performance.now();
    if (now - this.civSyncAt < 250) return;
    this.civSyncAt = now;
    const civs = this.sim.civs;
    let sig = `${civs.aliveIds.length}`;
    for (const id of civs.aliveIds) sig += `:${id}.${civs.civs[id].colonies.length}.${Math.floor(civs.civs[id].tech)}`;
    if (sig === this.civSignature) return;
    this.civSignature = sig;
    const loc: number[] = [], gal: number[] = [], col: number[] = [];
    const lloc: number[] = [], lgal: number[] = [], lcol: number[] = [];
    for (const id of civs.aliveIds) {
      const c = civs.civs[id];
      const hue = (hash32(c.seed, 0xc010) % 360) / 360;
      const color = new THREE.Color().setHSL(hue, 0.85, 0.62);
      const home = this.sim.queries.starLocal(c.capital.g, c.capital.s);
      if (!home) continue;
      loc.push(...home);
      gal.push(c.capital.g);
      col.push(color.r, color.g, color.b, 1);
      for (const k of c.colonies) {
        if (k.kind !== 'star') continue;
        const p = this.sim.queries.starLocal(k.g, k.s);
        if (!p) continue;
        loc.push(...p);
        gal.push(k.g);
        col.push(color.r, color.g, color.b, 0.45);
        lloc.push(...home, ...p);
        lgal.push(c.capital.g, k.g);
        lcol.push(color.r, color.g, color.b, 0.12, color.r, color.g, color.b, 0.03);
      }
    }
    // Fresh geometries (disposing the old ones) — replacing attributes in place would leak
    // the previous GPU buffers until the geometry itself is disposed.
    this.markers.geometry.dispose();
    this.links.geometry.dispose();
    const mg = new THREE.BufferGeometry();
    this.markers.geometry = mg;
    mg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(loc.length), 3));
    mg.setAttribute('aLocal', new THREE.Float32BufferAttribute(loc, 3));
    mg.setAttribute('aGal', new THREE.Float32BufferAttribute(gal, 1));
    mg.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 4));
    mg.boundingSphere = HUGE_SPHERE.clone();
    const lg = new THREE.BufferGeometry();
    this.links.geometry = lg;
    lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(lloc.length), 3));
    lg.setAttribute('aLocal', new THREE.Float32BufferAttribute(lloc, 3));
    lg.setAttribute('aGal', new THREE.Float32BufferAttribute(lgal, 1));
    lg.setAttribute('aColor', new THREE.Float32BufferAttribute(lcol, 4));
    lg.boundingSphere = HUGE_SPHERE.clone();
  }

  /**
   * Per-frame update. `focus` is the camera focus in world kpc (float64); every position
   * handed to the GPU is relative to it.
   */
  update(t: number, focus: Vec3, camRel: Vec3, pixel: number, opts: { nearHide: number; highlightGalaxy: number; showGrid: boolean; showCivs: boolean; insideSystem?: boolean }) {
    const gals = this.sim.universe.galaxies;
    const a = visualScale(t);
    const camDist = Math.hypot(camRel[0], camRel[1], camRel[2]);
    for (let i = 0; i < gals.length; i++) {
      const g = gals[i];
      const px = g.position[0] * a - focus[0], py = g.position[1] * a - focus[1], pz = g.position[2] * a - focus[2];
      const ang = galaxyAngle(g, t);
      const formed = smoothstep(g.formation - 2e8, g.formation + 1.5e9, t);
      const o = i * 16;
      this.galData[o] = px;
      this.galData[o + 1] = py;
      this.galData[o + 2] = pz;
      this.galData[o + 3] = ang;
      this.galData[o + 4] = g.u[0];
      this.galData[o + 5] = g.u[1];
      this.galData[o + 6] = g.u[2];
      this.galData[o + 7] = formed;
      this.galData[o + 8] = g.normal[0];
      this.galData[o + 9] = g.normal[1];
      this.galData[o + 10] = g.normal[2];
      this.galData[o + 12] = g.v[0];
      this.galData[o + 13] = g.v[1];
      this.galData[o + 14] = g.v[2];
      this.iCenter.setXYZ(i, px, py, pz);
      // Impostor brightness: fades in as the galaxy forms, out as the camera gets close
      // enough to resolve individual stars.
      const dCam = Math.hypot(px - camRel[0], py - camRel[1], pz - camRel[2]);
      // Diffuse galactic light: full strength from afar, dimmed (not removed) up close so
      // resolved stars dominate while dust lanes and the bulge glow remain.
      // …and gone once the camera is inside the galaxy (resolved stars form the sky).
      const near = (0.3 + 0.7 * smoothstep(g.radius * 0.8, g.radius * 7, dCam)) * smoothstep(g.radius * 0.9, g.radius * 1.6, dCam);
      const massB = 0.35 + 0.25 * Math.log10(g.mass / 1e9);
      this.iState.setXYZW(i, ang, formed * near * massB, g.bulgeFraction, g.axisRatios[1]);
    }
    this.galTex.needsUpdate = true;
    this.iCenter.needsUpdate = true;
    this.iState.needsUpdate = true;

    const tGyr = t / 1e9;
    this.starMat.uniforms.uTime.value = tGyr;
    this.starMat.uniforms.uPixel.value = pixel;
    this.starMat.uniforms.uExposure.value = this.exposure;
    this.starMat.uniforms.uNearHide.value = opts.nearHide;
    this.starMat.uniforms.uHighlightGal.value = opts.highlightGalaxy;
    this.starMat.uniforms.uDpr.value = this.dpr;

    const pm = this.plasmaMat.uniforms;
    pm.uScale.value = a;
    pm.uCluster.value = smoothstep(4e7, 2.5e9, t);
    pm.uTempK.value = radiationTemperature(t);
    // Diffuse gas is consumed into galaxies as structure forms; it fades out by ~4 Gyr.
    pm.uFade.value = 1 - smoothstep(4e8, 4e9, t);
    pm.uPixel.value = pixel;
    (pm.uFocus.value as THREE.Vector3).set(focus[0], focus[1], focus[2]);
    this.plasma.visible = pm.uFade.value > 0.01;

    this.grid.position.set(-focus[0], -focus[1], -focus[2]);
    this.grid.visible = opts.showGrid;
    (this.grid.material as THREE.LineBasicMaterial).opacity = 0.08 * smoothstep(300, 2500, camDist);

    this.syncOverrides();
    if (opts.showCivs) this.syncCivs();
    // Galactic territory markers are meaningless from inside a planetary system.
    this.markers.visible = opts.showCivs && !opts.insideSystem;
    this.links.visible = opts.showCivs;
    // Markers shrink at cosmic scale so territories read as tinted haze, not blobs.
    this.markerMat.uniforms.uSize.value = (camDist > 500 ? 8 : camDist > 50 ? 11 : 14) * this.dpr;
    this.links.visible = opts.showCivs && camDist < 500 && !opts.insideSystem;

    this.visibleStars = this.sim.catalog ? this.sim.catalog.starsShining(t) : 0;
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.galTex.dispose();
  }
}
