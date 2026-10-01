import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { KPC_PER_AU, R_EARTH, R_SUN, AU, YEAR_S } from '../engine/core/constants';
import { Rng } from '../engine/core/rng';
import { Vec3, clamp, smoothstep } from '../engine/core/math';
import { galaxyAngle, localToWorldOffset } from '../engine/gen/galaxy';
import { visualScale } from '../engine/gen/cosmology';
import { planetId, starId } from '../engine/core/names';
import { Simulation } from '../engine/sim/simulation';
import { EntityRef, sameRef } from '../engine/sim/types';
import { Anchor, CameraRig } from './CameraRig';
import { CosmicLayer } from './CosmicLayer';
import { SystemLayer } from './SystemLayer';

void FullScreenQuad;

export interface RenderSettings {
  bloom: boolean;
  labels: boolean;
  orbits: boolean;
  grid: boolean;
  civMarkers: boolean;
  habitableZone: boolean;
}

export interface HoverInfo {
  ref: EntityRef;
  x: number;
  y: number;
  title: string;
  sub: string;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  visibleEntities: number;
  geometries: number;
  textures: number;
}

const R_EARTH_KPC = (R_EARTH / AU) * KPC_PER_AU;
const R_SUN_KPC = (R_SUN / AU) * KPC_PER_AU;

/** Renders the layer stack into the composer's read buffer (camera-relative per layer). */
class LayerPass extends Pass {
  constructor(private draw: (r: THREE.WebGLRenderer) => void) {
    super();
    this.needsSwap = false;
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    this.draw(renderer);
  }
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e6);
  readonly rig: CameraRig;
  readonly cosmic: CosmicLayer;
  readonly system: SystemLayer;
  private sky = new THREE.Scene();
  private skyCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private labelPool: HTMLDivElement[] = [];
  private selRing: HTMLDivElement;
  private width = 1;
  private height = 1;
  private pixel = 800;
  private lastYears = 0;
  private yearsPerFrame = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private pixelRatio = 1;
  private scaleAcc = 0;
  settings: RenderSettings = { bloom: true, labels: true, orbits: true, grid: true, civMarkers: true, habitableZone: true };
  selected: EntityRef | null = null;
  stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, points: 0, visibleEntities: 0, geometries: 0, textures: 0 };
  onSelect: (ref: EntityRef | null) => void = () => {};
  onHover: (h: HoverInfo | null) => void = () => {};
  onFocusChange: (ref: EntityRef) => void = () => {};
  private disposed = false;
  /** Removes every DOM listener on dispose (otherwise a regenerated universe would leave the
   * old renderer handling clicks against a stale simulation). */
  private listeners = new AbortController();
  private pointer = { down: false, x: 0, y: 0, moved: 0, button: 0, lastHover: 0 };

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLDivElement,
    readonly sim: Simulation,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;

    this.rig = new CameraRig(
      (ref) => this.anchorOf(ref),
      (ref) => this.framingRadius(ref),
      (ref) => this.surfaceRadius(ref),
    );
    this.cosmic = new CosmicLayer(sim);
    this.system = new SystemLayer(sim);
    this.buildSky();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new LayerPass((r) => this.drawLayers(r)));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.72);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.selRing = document.createElement('div');
    this.selRing.className = 'sel-ring';
    this.overlay.appendChild(this.selRing);
    this.attachInput();
  }

  // ---- anchors & sizes --------------------------------------------------------------------

  private anchorOf(ref: EntityRef): Anchor | null {
    const t = this.sim.now();
    const q = this.sim.queries;
    switch (ref.kind) {
      case 'universe':
        return { star: null, base: [0, 0, 0], local: [0, 0, 0] };
      case 'galaxy':
        return { star: null, base: q.galaxyWorld(ref.g!, t), local: [0, 0, 0] };
      case 'star':
        if (!q.starLocal(ref.g!, ref.s!)) return null;
        return { star: [ref.g!, ref.s!], base: q.starWorld(ref.g!, ref.s!, t), local: [0, 0, 0] };
      case 'planet':
      case 'moon': {
        if (!q.starLocal(ref.g!, ref.s!)) return null;
        const local = this.system.bodyPositionAU(ref, this.sim.clock, t);
        return { star: [ref.g!, ref.s!], base: q.starWorld(ref.g!, ref.s!, t), local };
      }
      case 'civ': {
        const c = this.sim.civs.civs[ref.civ!];
        if (!c) return null;
        return this.anchorOf(c.capital.p >= 0 ? { kind: 'planet', g: c.capital.g, s: c.capital.s, p: c.capital.p } : { kind: 'star', g: c.capital.g, s: c.capital.s });
      }
    }
  }

  private framingRadius(ref: EntityRef): number {
    const q = this.sim.queries;
    switch (ref.kind) {
      case 'universe':
        return 3000;
      case 'galaxy':
        return this.sim.universe.galaxies[ref.g!]?.radius ?? 10;
      case 'star': {
        const sys = q.getSystem(ref.g!, ref.s!);
        const outer = sys && sys.planets.length ? sys.planets[sys.planets.length - 1].orbit.a * 1.2 : 3;
        return Math.max(outer, 1.5) * KPC_PER_AU;
      }
      case 'planet': {
        const p = q.getSystem(ref.g!, ref.s!)?.planets[ref.p!];
        return (p?.radiusE ?? 1) * R_EARTH_KPC;
      }
      case 'moon': {
        const m = q.getSystem(ref.g!, ref.s!)?.planets[ref.p!]?.moons[ref.m!];
        return (m?.radiusE ?? 0.2) * R_EARTH_KPC;
      }
      case 'civ':
        return R_EARTH_KPC * 2;
    }
  }

  private surfaceRadius(ref: EntityRef): number {
    if (ref.kind === 'star') {
      const st = this.sim.queries.starState(ref.g!, ref.s!, this.sim.now());
      return Math.max(1e-3, st?.radius ?? 1) * R_SUN_KPC;
    }
    return this.framingRadius(ref);
  }

  parentOf(ref: EntityRef): EntityRef {
    switch (ref.kind) {
      case 'galaxy':
        return { kind: 'universe' };
      case 'star':
        return { kind: 'galaxy', g: ref.g };
      case 'planet':
        return { kind: 'star', g: ref.g, s: ref.s };
      case 'moon':
        return { kind: 'planet', g: ref.g, s: ref.s, p: ref.p };
      case 'civ': {
        const c = this.sim.civs.civs[ref.civ!];
        return c ? { kind: 'star', g: c.capital.g, s: c.capital.s } : { kind: 'universe' };
      }
      default:
        return { kind: 'universe' };
    }
  }

  focusOn(ref: EntityRef, distance?: number) {
    const target = ref.kind === 'civ' ? this.anchorTargetForCiv(ref) : ref;
    this.rig.flyTo(target, distance);
    this.onFocusChange(target);
  }

  private anchorTargetForCiv(ref: EntityRef): EntityRef {
    const c = this.sim.civs.civs[ref.civ!];
    if (!c) return { kind: 'universe' };
    return c.capital.p >= 0 ? { kind: 'planet', g: c.capital.g, s: c.capital.s, p: c.capital.p } : { kind: 'star', g: c.capital.g, s: c.capital.s };
  }

  // ---- background -------------------------------------------------------------------------

  private buildSky() {
    const rng = new Rng(0x5c1e5);
    const n = 6000;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const z = rng.range(-1, 1), t = rng.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
      pos.set([r * Math.cos(t) * 5, z * 5, r * Math.sin(t) * 5], i * 3);
      const b = Math.pow(rng.next(), 6) * 0.55 + 0.04;
      const warm = rng.next();
      col.set([b * (0.8 + 0.2 * warm), b * 0.85, b * (1.05 - 0.25 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.2, sizeAttenuation: false, vertexColors: true, depthWrite: false, depthTest: false }));
    this.sky.add(pts);
  }

  // ---- frame ----------------------------------------------------------------------------------

  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.bloom.resolution.set(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.skyCam.aspect = this.camera.aspect;
    this.skyCam.updateProjectionMatrix();
    this.pixel = this.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  /** The system whose layer should be drawn, if any. */
  private activeSystem(): [number, number] | null {
    const candidates = [this.rig.focus, this.rig.transitionTarget, this.rig.transitionSource];
    for (const r of candidates) {
      if (!r) continue;
      if (r.kind === 'star' || r.kind === 'planet' || r.kind === 'moon') return [r.g!, r.s!];
    }
    return null;
  }

  render(dt: number) {
    if (this.disposed) return;
    const t0 = performance.now();
    const years = this.sim.now();
    this.yearsPerFrame = Math.abs(years - this.lastYears);
    this.lastYears = years;
    this.rig.update(dt);
    if (this.rig.wantsParent()) {
      const parent = this.parentOf(this.rig.focus);
      this.rig.flyTo(parent);
      this.onFocusChange(parent);
    }
    this.renderer.info.reset();
    if (this.settings.bloom) this.composer.render(dt);
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear(true, true, true);
      this.drawLayers(this.renderer);
    }
    this.updateLabels();
    const info = this.renderer.info;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.adaptResolution();
    }
    this.stats.frameMs = performance.now() - t0;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.points = info.render.points;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
    this.stats.visibleEntities = this.cosmic.visibleStars + (this.activeSystem() ? this.system.objectCount : 0);
  }

  /**
   * Dynamic resolution: the frame is GPU fill-bound (hundreds of thousands of additive point
   * sprites + bloom), so when FPS sags we render fewer pixels rather than drop frames.
   */
  private adaptResolution() {
    this.scaleAcc++;
    if (this.scaleAcc < 3) return;
    const max = Math.min(window.devicePixelRatio || 1, 1.5);
    let pr = this.pixelRatio;
    if (this.stats.fps < 38 && pr > 0.6) pr = Math.max(0.6, pr - 0.2);
    else if (this.stats.fps > 57 && pr < max) pr = Math.min(max, pr + 0.1);
    if (pr !== this.pixelRatio) {
      this.pixelRatio = pr;
      this.renderer.setPixelRatio(pr);
      this.composer.setPixelRatio(pr);
      this.resize(this.width, this.height);
      this.scaleAcc = 0;
    }
  }

  get resolutionScale() {
    return this.pixelRatio;
  }

  private drawLayers(r: THREE.WebGLRenderer) {
    const years = this.sim.now();
    const dir = this.rig.direction();
    const camRel = this.rig.cameraRel();
    const pan = this.rig.pan;
    const focus = this.rig.focusWorld();
    const camDist = this.rig.distance;
    const cam = this.camera;

    // ---- deep sky (orientation only) ----
    this.skyCam.position.set(0, 0, 0);
    this.skyCam.lookAt(-dir[0], -dir[1], -dir[2]);
    r.render(this.sky, this.skyCam);

    // ---- cosmic layer (kpc, relative to focus) ----
    const sysRef = this.activeSystem();
    cam.position.set(camRel[0], camRel[1], camRel[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(pan[0], pan[1], pan[2]);
    cam.near = Math.max(camDist * 1e-3, 1e-18);
    cam.far = 1e6;
    cam.updateProjectionMatrix();
    // Exposure: brighter when far so galaxies integrate into visible glows; also scales the
    // apparent brightness of resolved stars smoothly with zoom.
    // Auto-exposure on the focal distance; dimmer at cosmic scales where galaxies already
    // integrate thousands of stars.
    this.cosmic.exposure = camDist * camDist * (camDist > 300 ? 0.25 : camDist > 20 ? 1.5 : 2);
    const highlight = this.rig.focus.kind === 'galaxy' || this.rig.focus.kind === 'star' ? this.rig.focus.g! : -1;
    this.cosmic.dpr = this.pixelRatio;
    this.cosmic.update(years, focus, camRel, this.pixel, {
      nearHide: sysRef ? 2e-5 : 0,
      highlightGalaxy: camDist < 400 ? highlight : -1,
      showGrid: this.settings.grid,
      showCivs: this.settings.civMarkers,
      insideSystem: !!sysRef && camDist < 0.02,
    });
    r.render(this.cosmic.scene, cam);

    // ---- system layer (AU, relative to focus) ----
    if (sysRef) {
      const [g, s] = sysRef;
      this.system.setSystem(g, s);
      this.system.showOrbits = this.settings.orbits;
      this.system.showHZ = this.settings.habitableZone;
      const focusAU = this.rig.focusInSystem(g, s, (gg, ss) => this.sim.queries.starWorld(gg, ss, years));
      const camAU: Vec3 = [camRel[0] / KPC_PER_AU, camRel[1] / KPC_PER_AU, camRel[2] / KPC_PER_AU];
      const fromStar = Math.hypot(focusAU[0] + camAU[0], focusAU[1] + camAU[1], focusAU[2] + camAU[2]);
      if (fromStar < 2e5) {
        this.system.update(this.sim.clock, years, focusAU, camAU, this.pixel, this.yearsPerFrame, this.selected);
        r.clearDepth();
        cam.position.set(camAU[0], camAU[1], camAU[2]);
        cam.lookAt(pan[0] / KPC_PER_AU, pan[1] / KPC_PER_AU, pan[2] / KPC_PER_AU);
        const dAU = camDist / KPC_PER_AU;
        cam.near = Math.max(dAU * 2e-4, 1e-10);
        cam.far = Math.max(dAU * 1e4, fromStar * 4 + 1e4);
        cam.updateProjectionMatrix();
        r.render(this.system.scene, cam);
      }
    } else if (this.system.key) {
      this.system.clear();
    }
  }

  // ---- projection helpers -----------------------------------------------------------------------

  /** Project a point given in a layer frame (with the matching camera already configured). */
  private projectCosmic(p: Vec3): { x: number; y: number; z: number } | null {
    const camRel = this.rig.cameraRel();
    const pan = this.rig.pan;
    const cam = this.camera;
    cam.position.set(camRel[0], camRel[1], camRel[2]);
    cam.lookAt(pan[0], pan[1], pan[2]);
    cam.near = Math.max(this.rig.distance * 1e-3, 1e-18);
    cam.far = 1e6;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z };
  }

  private projectSystem(p: Vec3): { x: number; y: number; z: number; dist: number } | null {
    const camRel = this.rig.cameraRel();
    const camAU: Vec3 = [camRel[0] / KPC_PER_AU, camRel[1] / KPC_PER_AU, camRel[2] / KPC_PER_AU];
    const pan = this.rig.pan;
    const cam = this.camera;
    const dAU = this.rig.distance / KPC_PER_AU;
    cam.position.set(...camAU);
    cam.lookAt(pan[0] / KPC_PER_AU, pan[1] / KPC_PER_AU, pan[2] / KPC_PER_AU);
    cam.near = Math.max(dAU * 2e-4, 1e-10);
    cam.far = dAU * 1e6;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z, dist: Math.hypot(p[0] - camAU[0], p[1] - camAU[1], p[2] - camAU[2]) };
  }

  private galaxyRel(g: number, t: number): Vec3 {
    const w = this.sim.queries.galaxyWorld(g, t);
    const f = this.rig.focusWorld();
    return [w[0] - f[0], w[1] - f[1], w[2] - f[2]];
  }

  // ---- picking -----------------------------------------------------------------------------------

  pick(x: number, y: number): { ref: EntityRef; title: string; sub: string } | null {
    const t = this.sim.now();
    const sysRef = this.activeSystem();
    // 1. bodies in the active system
    if (sysRef && this.system.key) {
      let best: { ref: EntityRef; d: number; label: string; kind: string } | null = null;
      for (const b of this.system.bodies) {
        const p = this.projectSystem(b.pos);
        if (!p) continue;
        const rpx = (b.radius / Math.max(1e-12, p.dist)) * this.pixel;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < Math.max(rpx + 5, 9) && (!best || d < best.d)) best = { ref: b.ref, d, label: b.label, kind: b.kind };
      }
      if (best) return { ref: best.ref, ...this.describeShort(best.ref) };
    }
    // 2. stars of the galaxy in view
    const g = this.rig.focus.g ?? (this.rig.distance < 300 ? this.nearestGalaxyTo(x, y) : undefined);
    if (g !== undefined && this.rig.distance < 600 && this.sim.catalog) {
      const cat = this.sim.catalog.surveys[g].catalog;
      const gal = this.sim.universe.galaxies[g];
      const ang = galaxyAngle(gal, t);
      const base = this.galaxyRel(g, t);
      const tmp: Vec3 = [0, 0, 0];
      let best = -1, bestScore = Infinity;
      // Project once using the camera matrix (fast path: manual projection).
      const camRel = this.rig.cameraRel();
      this.camera.position.set(...camRel);
      this.camera.lookAt(this.rig.pan[0], this.rig.pan[1], this.rig.pan[2]);
      this.camera.near = Math.max(this.rig.distance * 1e-3, 1e-18);
      this.camera.far = 1e6;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
      for (let i = 0; i < cat.count; i++) {
        if (cat.birth[i] > t || cat.death[i] < t) continue;
        localToWorldOffset(gal, cat.x[i], cat.y[i], cat.z[i], ang, tmp);
        const px = base[0] + tmp[0], py = base[1] + tmp[1], pz = base[2] + tmp[2];
        const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (w <= 0) continue;
        const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * this.width;
        const sy = (-(m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5) * this.height;
        const d = Math.hypot(sx - x, sy - y);
        if (d > 10) continue;
        const score = d - Math.log10(1 + cat.lum[i]) * 2;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0) {
        const ref: EntityRef = { kind: 'star', g, s: best };
        return { ref, ...this.describeShort(ref) };
      }
    }
    // 3. galaxies
    const gi = this.nearestGalaxyTo(x, y, 40);
    if (gi !== undefined) {
      const ref: EntityRef = { kind: 'galaxy', g: gi };
      return { ref, ...this.describeShort(ref) };
    }
    return null;
  }

  private nearestGalaxyTo(x: number, y: number, maxPx = 60): number | undefined {
    const t = this.sim.now();
    let best: number | undefined;
    let bd = Infinity;
    for (const gal of this.sim.universe.galaxies) {
      if (gal.formation > t + 5e8) continue;
      const p = this.projectCosmic(this.galaxyRel(gal.index, t));
      if (!p) continue;
      const rel = this.galaxyRel(gal.index, t);
      const camRel = this.rig.cameraRel();
      const dist = Math.hypot(rel[0] - camRel[0], rel[1] - camRel[1], rel[2] - camRel[2]);
      const rpx = (gal.radius / Math.max(1e-9, dist)) * this.pixel;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(maxPx, rpx) && d < bd) {
        bd = d;
        best = gal.index;
      }
    }
    return best;
  }

  describeShort(ref: EntityRef): { title: string; sub: string } {
    const q = this.sim.queries;
    const t = this.sim.now();
    switch (ref.kind) {
      case 'galaxy': {
        const g = this.sim.universe.galaxies[ref.g!];
        return { title: g.name, sub: `${g.type} galaxy · ${g.starCount.toLocaleString('en-US')} stars` };
      }
      case 'star': {
        const st = q.starState(ref.g!, ref.s!, t);
        const sys = q.getSystem(ref.g!, ref.s!);
        return { title: `Star ${starId(ref.g!, ref.s!)}`, sub: `${st?.spectral ?? ''} · ${st?.phase ?? ''} · ${sys?.planets.length ?? 0} planets` };
      }
      case 'planet': {
        const d = q.planetAt(ref.g!, ref.s!, ref.p!, t);
        return { title: `Planet ${planetId(ref.g!, ref.s!, ref.p!)}`, sub: d ? `${d.type} · ${Math.round(d.climate.surfaceTemp)} K${d.life.stage >= 2 ? ' · life' : ''}` : '' };
      }
      case 'moon':
        return { title: `Moon ${planetId(ref.g!, ref.s!, ref.p!)}-${ref.m! + 1}`, sub: 'natural satellite' };
      default:
        return { title: '', sub: '' };
    }
  }

  // ---- labels & selection ring (DOM overlay) ------------------------------------------------------

  private label(i: number): HTMLDivElement {
    while (this.labelPool.length <= i) {
      const d = document.createElement('div');
      d.className = 'world-label';
      this.overlay.appendChild(d);
      this.labelPool.push(d);
    }
    return this.labelPool[i];
  }

  private updateLabels() {
    let n = 0;
    const t = this.sim.now();
    const placed: [number, number, number, number][] = [];
    const put = (x: number, y: number, text: string, cls: string) => {
      if (x < -50 || y < -50 || x > this.width + 50 || y > this.height + 50) return;
      // Declutter: skip labels that would overlap one already placed (priority = call order).
      const w = text.length * 6.4 + 4, h = 13;
      if (placed.some(([px, py, pw, ph]) => x < px + pw && x + w > px && y < py + ph && y + h > py)) return;
      placed.push([x, y, w, h]);
      const el = this.label(n++);
      if (el.textContent !== text) el.textContent = text;
      el.className = `world-label ${cls}`;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.display = 'block';
    };
    if (this.settings.labels) {
      const sysRef = this.activeSystem();
      if (sysRef && this.system.key && this.rig.distance / KPC_PER_AU < 3000) {
        for (const b of this.system.bodies) {
          if (b.kind === 'moon' && this.rig.focus.kind !== 'planet' && this.rig.focus.kind !== 'moon') continue;
          const p = this.projectSystem(b.pos);
          if (!p) continue;
          const rpx = (b.radius / Math.max(1e-12, p.dist)) * this.pixel;
          put(p.x + rpx + 6, p.y - 7, b.kind === 'star' ? `${starId(this.system.g, this.system.s)} · ${b.label}` : b.label, b.kind);
        }
      } else if (this.rig.distance > 150) {
        const camRel = this.rig.cameraRel();
        const byMass = this.sim.universe.galaxies.slice().sort((a, b) => b.mass - a.mass);
        for (const gal of byMass) {
          if (gal.formation > t) continue;
          const rel = this.galaxyRel(gal.index, t);
          const dist = Math.hypot(rel[0] - camRel[0], rel[1] - camRel[1], rel[2] - camRel[2]);
          const rpx = (gal.radius / dist) * this.pixel;
          if (rpx < 2.2 && gal.mass < 1e11) continue;
          const p = this.projectCosmic(rel);
          if (p) put(p.x + Math.max(4, rpx * 0.7), p.y - 6, gal.name, 'galaxy');
        }
      }
      // Civilization tags (galaxy scale).
      if (this.settings.civMarkers && this.rig.distance < 400 && this.rig.distance > 1e-6) {
        for (const id of this.sim.civs.aliveIds) {
          const c = this.sim.civs.civs[id];
          if (this.rig.focus.g !== undefined && c.capital.g !== this.rig.focus.g) continue;
          const w = this.sim.queries.starWorld(c.capital.g, c.capital.s, t);
          const f = this.rig.focusWorld();
          const p = this.projectCosmic([w[0] - f[0], w[1] - f[1], w[2] - f[2]]);
          if (p) put(p.x + 9, p.y + 4, c.code, 'civ');
        }
      }
    }
    for (let i = n; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none';

    // Selection ring.
    const sel = this.selected;
    let shown = false;
    if (sel) {
      let pos: { x: number; y: number } | null = null;
      let rpx = 10;
      if ((sel.kind === 'planet' || sel.kind === 'moon' || sel.kind === 'star') && this.system.key === `${sel.g}:${sel.s}`) {
        const b = this.system.bodies.find((x) => sameRef(x.ref, sel));
        if (b) {
          const p = this.projectSystem(b.pos);
          if (p) {
            pos = p;
            rpx = (b.radius / Math.max(1e-12, p.dist)) * this.pixel;
          }
        }
      } else if (sel.kind === 'star') {
        const w = this.sim.queries.starWorld(sel.g!, sel.s!, t);
        const f = this.rig.focusWorld();
        pos = this.projectCosmic([w[0] - f[0], w[1] - f[1], w[2] - f[2]]);
      } else if (sel.kind === 'galaxy') {
        const rel = this.galaxyRel(sel.g!, t);
        const camRel = this.rig.cameraRel();
        pos = this.projectCosmic(rel);
        rpx = (this.sim.universe.galaxies[sel.g!].radius / Math.max(1e-9, Math.hypot(rel[0] - camRel[0], rel[1] - camRel[1], rel[2] - camRel[2]))) * this.pixel;
      }
      if (pos && rpx < Math.min(this.width, this.height) * 0.42) {
        const size = clamp(rpx * 2 + 16, 18, 400);
        this.selRing.style.transform = `translate(${(pos.x - size / 2).toFixed(1)}px, ${(pos.y - size / 2).toFixed(1)}px)`;
        this.selRing.style.width = this.selRing.style.height = `${size}px`;
        shown = true;
      }
    }
    this.selRing.style.display = shown ? 'block' : 'none';
  }

  // ---- input ----------------------------------------------------------------------------------------

  private attachInput() {
    const el = this.canvas;
    const opts = { signal: this.listeners.signal };
    el.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    el.addEventListener('pointerdown', (e) => {
      this.pointer = { ...this.pointer, down: true, x: e.clientX, y: e.clientY, moved: 0, button: e.button };
      el.setPointerCapture(e.pointerId);
    }, opts);
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      if (this.pointer.down) {
        const dx = e.clientX - this.pointer.x, dy = e.clientY - this.pointer.y;
        this.pointer.moved += Math.abs(dx) + Math.abs(dy);
        this.pointer.x = e.clientX;
        this.pointer.y = e.clientY;
        if (this.pointer.button === 2 || e.shiftKey) {
          const d = this.rig.direction();
          const right: Vec3 = [Math.cos(this.rig.yaw), 0, -Math.sin(this.rig.yaw)];
          const up: Vec3 = [d[1] * right[2] - d[2] * right[1], d[2] * right[0] - d[0] * right[2], d[0] * right[1] - d[1] * right[0]];
          this.rig.panBy(dx, dy, right, [-up[0], -up[1], -up[2]], this.height);
        } else this.rig.rotate(dx, dy);
        this.onHover(null);
      } else {
        const now = performance.now();
        if (now - this.pointer.lastHover > 60) {
          this.pointer.lastHover = now;
          const x = e.clientX - rect.left, y = e.clientY - rect.top;
          const hit = this.pick(x, y);
          this.onHover(hit ? { ref: hit.ref, x, y, title: hit.title, sub: hit.sub } : null);
        }
      }
    }, opts);
    el.addEventListener('pointerup', (e) => {
      const wasClick = this.pointer.down && this.pointer.moved < 5 && this.pointer.button === 0;
      this.pointer.down = false;
      if (!wasClick) return;
      const rect = el.getBoundingClientRect();
      const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        this.onSelect(hit.ref);
        this.focusOn(hit.ref);
      }
    }, opts);
    el.addEventListener('pointerleave', () => this.onHover(null), opts);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.rig.zoom(e.deltaY * (e.deltaMode === 1 ? 33 : 1));
      },
      { passive: false, signal: this.listeners.signal },
    );
  }

  /** Simulated years advanced per rendered frame (for motion-aliasing hints). */
  get yearsPerRenderFrame() {
    return this.yearsPerFrame;
  }

  speedYearsPerSecond() {
    return this.sim.speed / YEAR_S;
  }

  dispose() {
    this.disposed = true;
    this.listeners.abort();
    this.cosmic.dispose();
    this.system.clear();
    this.bloom.dispose();
    this.composer.dispose();
    this.sky.traverse((o) => {
      const m = o as THREE.Points;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.renderer.dispose();
    this.overlay.innerHTML = '';
  }
}

export const visualScaleAt = visualScale;
export const smooth = smoothstep;
