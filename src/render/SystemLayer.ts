import * as THREE from 'three';
import { AU, R_EARTH, R_SUN } from '../engine/core/constants';
import { Rng, hash32 } from '../engine/core/rng';
import { DEG, TAU, Vec3 } from '../engine/core/math';
import { SimTime, phase } from '../engine/core/time';
import { StarSystem, EARTH_MASS_IN_SUN } from '../engine/gen/planets';
import { blackbodyRGB } from '../engine/gen/star';
import { orbitPolyline, orbitalPeriodYears, orbitalPosition, stellarReflex } from '../engine/physics/orbits';
import { rotationAngle, spinAxis, subsolarLatitude } from '../engine/physics/rotation';
import { Simulation } from '../engine/sim/simulation';
import { EntityRef } from '../engine/sim/types';
import { techLevel } from '../engine/civ/civilization';
import { citySites, civGeography } from '../engine/civ/cities';
import { planetLook, moonColor } from './planetLook';
import {
  ATMO_FRAG,
  BELT_FRAG,
  BELT_VERT,
  CLOUD_FRAG,
  CORONA_FRAG,
  CORONA_VERT,
  PLANET_FRAG,
  PLANET_VERT,
  RING_FRAG,
  RING_VERT,
  STAR_SURFACE_FRAG,
} from './shaders';

const R_EARTH_AU = R_EARTH / AU;
const R_SUN_AU = R_SUN / AU;

// Reused temporaries: the per-frame update allocates nothing per planet.
const _qAlign = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _vAxis = new THREE.Vector3();
const _vUp = new THREE.Vector3(0, 1, 0);
const _vZ = new THREE.Vector3(0, 0, 1);
const _sun = new THREE.Vector3();
const LOOK_REFRESH_MS = 250;

const sphereLow = new THREE.SphereGeometry(1, 48, 24);
const sphereHigh = new THREE.SphereGeometry(1, 160, 80);
const sphereMoon = new THREE.SphereGeometry(1, 32, 16);

interface PlanetVis {
  index: number;
  ref: EntityRef;
  group: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  clouds: THREE.Mesh;
  cloudMat: THREE.ShaderMaterial;
  atmo: THREE.Mesh;
  atmoMat: THREE.ShaderMaterial;
  ring: THREE.Mesh | null;
  ringMat: THREE.ShaderMaterial | null;
  orbit: THREE.Line;
  orbitBuiltAt: number;
  moons: { ref: EntityRef; mesh: THREE.Mesh; orbit: THREE.Line; index: number }[];
  axis: Vec3;
  lookStamp: string;
  lookCheckedAt: number;
  lookYears: number;
  lifeStage: number;
  pos: Vec3;
  displayR: number;
  trueR: number;
  habitat: THREE.Mesh;
  sats: THREE.Points;
  satCount: number;
  cityStamp: string;
}

export interface BodyHit {
  ref: EntityRef;
  pos: Vec3; // layer coordinates (AU, relative to focus)
  radius: number; // display radius (AU)
  label: string;
  kind: 'star' | 'planet' | 'moon';
}

export class SystemLayer {
  readonly scene = new THREE.Scene();
  key: string | null = null;
  sys: StarSystem | null = null;
  private starMesh: THREE.Mesh | null = null;
  private starMat: THREE.ShaderMaterial | null = null;
  private corona: THREE.Mesh | null = null;
  private coronaMat: THREE.ShaderMaterial | null = null;
  private planets: PlanetVis[] = [];
  private belts: { points: THREE.Points; mat: THREE.ShaderMaterial; epoch: number; meanAnomaly: Float32Array; n: Float64Array; M0: Float64Array }[] = [];
  private hz: THREE.Mesh | null = null;
  private starPos: Vec3 = [0, 0, 0];
  private starDisplayR = 0;
  bodies: BodyHit[] = [];
  showOrbits = true;
  showHZ = true;
  objectCount = 0;

  constructor(private sim: Simulation) {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.02));
  }

  get g() {
    return this.sys?.g ?? -1;
  }
  get s() {
    return this.sys?.s ?? -1;
  }

  setSystem(g: number, s: number) {
    const key = `${g}:${s}`;
    if (key === this.key) return;
    this.clear();
    const sys = this.sim.queries.getSystem(g, s);
    if (!sys) return;
    this.key = key;
    this.sys = sys;
    const seedLo = sys.seed & 0xffff, seedHi = (sys.seed >>> 16) & 0xffff;

    // ---- star ----
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: STAR_SURFACE_FRAG,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uTime: { value: 0 }, uSeedLo: { value: seedLo }, uSeedHi: { value: seedHi } },
    });
    this.starMesh = new THREE.Mesh(sphereLow, this.starMat);
    this.scene.add(this.starMesh);
    this.coronaMat = new THREE.ShaderMaterial({
      vertexShader: CORONA_VERT,
      fragmentShader: CORONA_FRAG,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uIntensity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.coronaMat);
    this.corona.renderOrder = 10;
    this.scene.add(this.corona);

    // ---- habitable zone ----
    const hzGeo = new THREE.RingGeometry(sys.habitableZone[0], sys.habitableZone[1], 128, 1);
    this.hz = new THREE.Mesh(hzGeo, new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    this.hz.rotation.x = -Math.PI / 2;
    this.scene.add(this.hz);

    // ---- planets ----
    for (const p of sys.planets) {
      const pv = this.buildPlanet(sys, p.index);
      this.planets.push(pv);
      this.scene.add(pv.group, pv.orbit);
      for (const m of pv.moons) this.scene.add(m.mesh, m.orbit);
    }

    // ---- belts (instanced points, Kepler solved in the vertex shader) ----
    sys.belts.forEach((b, bi) => {
      const rng = new Rng(hash32(sys.seed, 0xbe17, bi));
      const n = b.kind === 'asteroid' ? 3500 : 4500;
      const orbit = new Float32Array(n * 4), angles = new Float32Array(n * 3), size = new Float32Array(n);
      const M0 = new Float64Array(n), mm = new Float64Array(n);
      let k = 0;
      for (let tries = 0; k < n && tries < n * 4; tries++) {
        const a = rng.range(b.inner, b.outer);
        // Kirkwood gaps: orbits in mean-motion resonance with the giant are cleared.
        if (b.gaps.some((gp) => Math.abs(a - gp) < 0.022 * gp) && rng.next() < 0.93) continue;
        const e = Math.min(0.35, rng.rayleigh(b.kind === 'asteroid' ? 0.08 : 0.1));
        const inc = rng.rayleigh((b.kind === 'asteroid' ? 5 : 9) * DEG);
        orbit.set([a, e, inc, rng.range(0, TAU)], k * 4);
        M0[k] = rng.range(0, TAU);
        mm[k] = TAU / orbitalPeriodYears(a, sys.star.mass);
        angles.set([rng.range(0, TAU), 0, mm[k]], k * 3);
        size[k] = rng.logRange(0.5, 2.5);
        k++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(k * 3), 3));
      geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit.subarray(0, k * 4), 4));
      geo.setAttribute('aAngles', new THREE.BufferAttribute(angles.subarray(0, k * 3), 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size.subarray(0, k), 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: BELT_VERT,
        fragmentShader: BELT_FRAG,
        uniforms: { uDt: { value: 0 }, uPixel: { value: 800 }, uColor: { value: new THREE.Color(b.kind === 'asteroid' ? 0xb8a890 : 0x9fb6cc) } },
        transparent: true,
        depthWrite: false,
      });
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.scene.add(pts);
      this.belts.push({ points: pts, mat, epoch: NaN, meanAnomaly: angles, n: mm.subarray(0, k), M0: M0.subarray(0, k) });
    });
  }

  private buildPlanet(sys: StarSystem, idx: number): PlanetVis {
    const p = sys.planets[idx];
    const seedLo = 0, seedHi = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uSeedLo: { value: seedLo },
        uSeedHi: { value: seedHi },
        uKind: { value: 0 },
        uSea: { value: -1 },
        uIceLat: { value: Math.PI },
        uSeason: { value: 0 },
        uDeep: { value: new THREE.Color() },
        uShallow: { value: new THREE.Color() },
        uLow: { value: new THREE.Color() },
        uHigh: { value: new THREE.Color() },
        uPeak: { value: new THREE.Color() },
        uVegetation: { value: 0 },
        uLava: { value: 0 },
        uCityLights: { value: 0 },
        uCities: { value: Array.from({ length: 32 }, () => new THREE.Vector4()) },
        uCityCount: { value: 0 },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uBand1: { value: new THREE.Color() },
        uBand2: { value: new THREE.Color() },
        uBand3: { value: new THREE.Color() },
        uFlow: { value: 0 },
        uStorm: { value: 0 },
        uAtmo: { value: new THREE.Color() },
        uAtmoStrength: { value: 0 },
        uDetail: { value: 0 },
      },
    });
    const group = new THREE.Group();
    const body = new THREE.Mesh(sphereLow, mat);
    group.add(body);
    const cloudMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: { uSeedLo: { value: 0 }, uSeedHi: { value: 0 }, uCover: { value: 0 }, uDrift: { value: 0 }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uTint: { value: new THREE.Color(1, 1, 1) } },
      transparent: true,
      depthWrite: false,
    });
    const clouds = new THREE.Mesh(sphereLow, cloudMat);
    clouds.scale.setScalar(1.012);
    group.add(clouds);
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: { uAtmo: { value: new THREE.Color() }, uStrength: { value: 0 }, uSunDir: { value: new THREE.Vector3(1, 0, 0) } },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const atmo = new THREE.Mesh(sphereLow, atmoMat);
    atmo.scale.setScalar(1.045);
    group.add(atmo);

    let ring: THREE.Mesh | null = null;
    let ringMat: THREE.ShaderMaterial | null = null;
    if (p.rings) {
      ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uInner: { value: p.rings.inner },
          uOuter: { value: p.rings.outer },
          uOpacity: { value: p.rings.opacity },
          uSeed: { value: (p.seed % 1000) / 10 },
          uColor: { value: new THREE.Color(0.86, 0.8, 0.68) },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uPlanetPos: { value: new THREE.Vector3() },
          uPlanetR: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      ring = new THREE.Mesh(new THREE.RingGeometry(p.rings.inner, p.rings.outer, 160, 1), ringMat);
      group.add(ring);
    }

    const axis = spinAxis(p.orbit, p.axialTilt, p.seed);
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.BufferAttribute(orbitPolyline(p.orbit, 0, 256), 3));
    const orbit = new THREE.Line(orbitGeo, new THREE.LineBasicMaterial({ color: 0x6fa8dc, transparent: true, opacity: 0.32, depthWrite: false }));
    orbit.frustumCulled = false;

    const moons = p.moons.map((m) => {
      const mesh = new THREE.Mesh(sphereMoon, new THREE.MeshStandardMaterial({ color: new THREE.Color(...moonColor(m)), roughness: 0.95, metalness: 0, emissive: m.kind === 'volcanic' ? new THREE.Color(0.25, 0.08, 0.0) : new THREE.Color(0, 0, 0) }));
      const pts = orbitPolyline(m.orbit, 0, 128);
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const mo = new THREE.Line(og, new THREE.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.22, depthWrite: false }));
      mo.frustumCulled = false;
      return { ref: { kind: 'moon', g: sys.g, s: sys.s, p: idx, m: m.index } as EntityRef, mesh, orbit: mo, index: m.index };
    });

    // Orbital habitat ring: thin, dim, lit by the star (not self-luminous, so it doesn't bloom).
    const habitat = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.004, 6, 160), new THREE.MeshStandardMaterial({ color: 0x9fd8e8, metalness: 0.6, roughness: 0.35, emissive: 0x0b3a40 }));
    habitat.visible = false;
    group.add(habitat);
    const satGeo = new THREE.BufferGeometry();
    satGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    satGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const sats = new THREE.Points(satGeo, new THREE.PointsMaterial({ color: 0xbfe9ff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.4, depthWrite: false }));
    sats.frustumCulled = false;
    sats.visible = false;
    group.add(sats);

    return {
      index: idx,
      ref: { kind: 'planet', g: sys.g, s: sys.s, p: idx },
      group,
      body,
      mat,
      clouds,
      cloudMat,
      atmo,
      atmoMat,
      ring,
      ringMat,
      orbit,
      orbitBuiltAt: NaN,
      moons,
      axis,
      lookStamp: '',
      lookCheckedAt: -Infinity,
      lookYears: NaN,
      lifeStage: 0,
      pos: [0, 0, 0],
      displayR: 0,
      trueR: p.radiusE * R_EARTH_AU,
      habitat,
      sats,
      satCount: -1,
      cityStamp: '',
    };
  }

  clear() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== sphereLow && m.geometry !== sphereHigh && m.geometry !== sphereMoon) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && 'dispose' in mat) mat.dispose();
    });
    for (const c of [...this.scene.children]) if (!(c instanceof THREE.AmbientLight)) this.scene.remove(c);
    this.planets = [];
    this.belts = [];
    this.bodies = [];
    this.key = null;
    this.sys = null;
    this.starMesh = null;
    this.corona = null;
  }

  /** Position of the focused body inside the system (AU, star-centred frame). */
  bodyPositionAU(ref: EntityRef, clock: SimTime, years: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const sys = this.sys ?? (ref.g !== undefined && ref.s !== undefined ? this.sim.queries.getSystem(ref.g, ref.s) : null);
    out[0] = out[1] = out[2] = 0;
    if (!sys || ref.p === undefined) return out;
    const p = sys.planets[ref.p];
    if (!p) return out;
    orbitalPosition(p.orbit, clock, years, out);
    if (ref.kind === 'moon' && ref.m !== undefined && p.moons[ref.m]) {
      const mp = orbitalPosition(p.moons[ref.m].orbit, clock, years);
      out[0] += mp[0];
      out[1] += mp[1];
      out[2] += mp[2];
    }
    return out;
  }

  /**
   * Per-frame update. `focusAU` is the camera focus inside this system (AU, star frame);
   * `camRel` the camera position relative to the focus (AU).
   */
  update(clock: SimTime, years: number, focusAU: Vec3, camRel: Vec3, pixel: number, yearsPerFrame: number, selected: EntityRef | null) {
    const sys = this.sys;
    if (!sys) return;
    const sim = this.sim;
    this.bodies = [];
    this.objectCount = 0;
    const cam = camRel;
    const distTo = (p: Vec3) => Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);

    // Planet positions (Kepler + precession) and the star's barycentric reflex motion.
    const ppos: Vec3[] = sys.planets.map((p) => orbitalPosition(p.orbit, clock, years));
    const reflex = stellarReflex(ppos, sys.planets.map((p) => p.massE * EARTH_MASS_IN_SUN), sys.star.mass);
    this.starPos = [reflex[0] - focusAU[0], reflex[1] - focusAU[1], reflex[2] - focusAU[2]];

    // ---- star ----
    const st = sim.queries.starState(sys.g, sys.s, years);
    if (st && this.starMesh && this.corona && this.starMat && this.coronaMat) {
      const trueR = Math.max(st.radius * R_SUN_AU, 1e-7);
      const visible = st.phase !== 'unborn' && st.phase !== 'destroyed';
      const dr = Math.max(trueR, distTo(this.starPos) * 0.0045);
      this.starDisplayR = dr;
      this.starMesh.position.set(...this.starPos);
      this.starMesh.scale.setScalar(dr);
      this.starMesh.visible = visible && st.phase !== 'black-hole';
      const col = st.phase === 'black-hole' ? [1, 0.55, 0.2] : blackbodyRGB(st.temperature);
      (this.starMat.uniforms.uColor.value as THREE.Color).setRGB(col[0], col[1], col[2]);
      this.starMat.uniforms.uTime.value = phase(clock, 0.05) * 6;
      this.corona.position.copy(this.starMesh.position);
      // Corona: generous when the star is drawn at true size, restrained when its disc is
      // inflated for visibility (otherwise bloom floods the frame).
      const inflated = dr > trueR * 1.5;
      this.corona.scale.setScalar(dr * (inflated ? 2.2 : st.phase === 'red-giant' ? 3 : 4.5));
      this.corona.visible = visible;
      (this.coronaMat.uniforms.uColor.value as THREE.Color).setRGB(col[0], col[1], col[2]);
      this.coronaMat.uniforms.uIntensity.value = (st.phase === 'white-dwarf' || st.phase === 'neutron-star' ? 0.5 : st.phase === 'black-hole' ? 0.7 : 0.9) * (inflated ? 0.55 : 1);
      if (visible) this.bodies.push({ ref: { kind: 'star', g: sys.g, s: sys.s }, pos: this.starPos, radius: dr, label: `${sim.queries.starState(sys.g, sys.s, years)?.spectral ?? ''}`, kind: 'star' });
      this.objectCount += 2;
    }
    if (this.hz) {
      this.hz.position.set(...this.starPos);
      // Only meaningful (and only legible) when viewing the whole system.
      this.hz.visible = this.showHZ && st?.phase === 'main-sequence' && Math.hypot(...camRel) > sys.habitableZone[1] * 0.6;
    }

    // ---- planets ----
    for (const pv of this.planets) {
      const p = sys.planets[pv.index];
      const pos = ppos[pv.index];
      const rel: Vec3 = [pos[0] - focusAU[0], pos[1] - focusAU[1], pos[2] - focusAU[2]];
      pv.pos = rel;
      const exists = years >= p.formation && st?.phase !== 'destroyed';
      const d = distTo(rel);
      const dr = Math.max(pv.trueR, d * (p.composition === 'gaseous' ? 0.0042 : 0.003));
      pv.displayR = dr;
      pv.group.position.set(...rel);
      pv.group.visible = exists;
      pv.body.scale.setScalar(dr);
      pv.clouds.scale.setScalar(dr * 1.012);
      pv.atmo.scale.setScalar(dr * (p.composition === 'gaseous' ? 1.03 : 1.045));
      // LOD: dense mesh only when the planet is large on screen.
      const screenPx = (dr / Math.max(1e-12, d)) * pixel;
      const geo = screenPx > 90 ? sphereHigh : sphereLow;
      pv.body.geometry = geo;
      pv.clouds.geometry = geo;
      pv.atmo.geometry = geo;
      pv.mat.uniforms.uDetail.value = screenPx > 300 ? 1 : 0;

      // Spin: align object y with the spin axis, then rotate about it.
      const ang = rotationAngle(p.rotationHours, clock, p.seed);
      _vAxis.set(pv.axis[0], pv.axis[1], pv.axis[2]);
      _qAlign.setFromUnitVectors(_vUp, _vAxis);
      _qSpin.setFromAxisAngle(_vUp, ang);
      pv.body.quaternion.copy(_qAlign).multiply(_qSpin);
      pv.clouds.quaternion.copy(pv.body.quaternion);
      // Sun direction (world, layer frame).
      const sun = _sun.set(this.starPos[0] - rel[0], this.starPos[1] - rel[1], this.starPos[2] - rel[2]).normalize();
      pv.mat.uniforms.uSunDir.value.copy(sun);
      pv.cloudMat.uniforms.uSunDir.value.copy(sun);
      pv.atmoMat.uniforms.uSunDir.value.copy(sun);
      pv.mat.uniforms.uSeason.value = subsolarLatitude(pv.axis, pos);
      pv.mat.uniforms.uFlow.value = phase(clock, Math.abs(p.rotationHours) / 8766 * 40) * TAU;
      pv.cloudMat.uniforms.uDrift.value = phase(clock, Math.abs(p.rotationHours) / 8766 * 25) * TAU;
      if (pv.ring && pv.ringMat) {
        pv.ring.scale.setScalar(dr);
        pv.ring.quaternion.setFromUnitVectors(_vZ, _vAxis);
        pv.ringMat.uniforms.uSunDir.value.copy(sun);
        (pv.ringMat.uniforms.uPlanetPos.value as THREE.Vector3).set(...rel);
        pv.ringMat.uniforms.uPlanetR.value = dr;
      }

      // Visual state derived from the simulated planet — re-derived a few times per second
      // (or immediately after a time jump), not every frame.
      const wall = performance.now();
      const needLook = wall - pv.lookCheckedAt > LOOK_REFRESH_MS || !(Math.abs(years - pv.lookYears) < 1e6);
      const dyn = needLook ? sim.queries.planetAt(sys.g, sys.s, pv.index, years) : null;
      if (needLook) {
        pv.lookCheckedAt = wall;
        pv.lookYears = years;
      }
      if (dyn) {
        pv.lifeStage = dyn.life.stage;
        const stamp = `${dyn.type}:${dyn.life.stage}:${Math.round(dyn.climate.surfaceTemp)}:${Math.round(dyn.climate.liquidWater * 200)}:${Math.round(dyn.climate.ice * 100)}:${Math.round(dyn.climate.pressure * 100)}:${dyn.starPhase}`;
        if (stamp !== pv.lookStamp) {
          pv.lookStamp = stamp;
          this.applyLook(pv, dyn);
        }
      }
      this.updateCivVisuals(pv, years, dr);

      // Orbit line (rebuilt periodically to follow apsidal precession).
      if (this.showOrbits) {
        if (!(Math.abs(years - pv.orbitBuiltAt) < 2e3)) {
          pv.orbit.geometry.dispose();
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(orbitPolyline(p.orbit, years, 256), 3));
          pv.orbit.geometry = g;
          pv.orbitBuiltAt = years;
        }
        pv.orbit.position.set(...this.starPos);
        const sel = selected?.kind === 'planet' && selected.p === pv.index;
        const fast = (yearsPerFrame / p.orbit.period) > 0.08;
        const lm = pv.orbit.material as THREE.LineBasicMaterial;
        lm.opacity = sel ? 0.8 : fast ? 0.5 : 0.28;
        lm.color.set(sel ? 0xffd27a : pv.lifeStage >= 2 ? 0x6fdc9a : 0x6fa8dc);
        pv.orbit.visible = exists;
        // When the orbit is unresolvable at this speed, show the planet as a ghost on its track.
        (pv.body.material as THREE.ShaderMaterial).transparent = false;
      } else pv.orbit.visible = false;

      if (exists) {
        this.bodies.push({ ref: pv.ref, pos: rel, radius: dr, label: p.id.split('-').pop()!, kind: 'planet' });
        this.objectCount += 4;
      }

      // ---- moons ----
      for (const mv of pv.moons) {
        const moon = p.moons[mv.index];
        const mp = orbitalPosition(moon.orbit, clock, years);
        const mrel: Vec3 = [rel[0] + mp[0], rel[1] + mp[1], rel[2] + mp[2]];
        const md = distTo(mrel);
        const mdr = Math.max(moon.radiusE * R_EARTH_AU, md * 0.0014);
        const visible = exists && moon.orbit.a > dr * 1.3;
        mv.mesh.visible = visible;
        mv.orbit.visible = visible && this.showOrbits;
        mv.mesh.position.set(...mrel);
        mv.mesh.scale.setScalar(mdr);
        mv.orbit.position.set(...rel);
        if (visible) {
          this.bodies.push({ ref: mv.ref, pos: mrel, radius: mdr, label: moon.id.split('-').pop()!, kind: 'moon' });
          this.objectCount++;
        }
      }
    }

    // ---- belts: rebase the epoch so the shader's float32 time stays small ----
    for (const b of this.belts) {
      if (!(Math.abs(years - b.epoch) < 1000)) {
        b.epoch = years;
        const attr = b.points.geometry.getAttribute('aAngles') as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        for (let i = 0; i < b.n.length; i++) {
          const M = b.M0[i] + b.n[i] * years; // float64
          arr[i * 3 + 1] = M - TAU * Math.floor(M / TAU);
        }
        attr.needsUpdate = true;
      }
      b.mat.uniforms.uDt.value = years - b.epoch;
      b.mat.uniforms.uPixel.value = pixel;
      b.points.position.set(...this.starPos);
      this.objectCount += b.n.length;
    }

    // A light so standard materials (moons, habitats) are lit by the star.
    let light = this.scene.getObjectByName('starlight') as THREE.PointLight | undefined;
    if (!light) {
      light = new THREE.PointLight(0xffffff, 2.2, 0, 0);
      light.name = 'starlight';
      this.scene.add(light);
    }
    light.position.set(...this.starPos);
  }

  private applyLook(pv: PlanetVis, dyn: NonNullable<ReturnType<Simulation['queries']['planetAt']>>) {
    const L = planetLook(dyn);
    const u = pv.mat.uniforms;
    u.uSeedLo.value = L.seed & 0xffff;
    u.uSeedHi.value = (L.seed >>> 16) & 0xffff;
    u.uKind.value = L.kind;
    u.uSea.value = L.seaLevel;
    u.uIceLat.value = L.iceLat;
    (u.uDeep.value as THREE.Color).setRGB(...L.deep);
    (u.uShallow.value as THREE.Color).setRGB(...L.shallow);
    (u.uLow.value as THREE.Color).setRGB(...L.low);
    (u.uHigh.value as THREE.Color).setRGB(...L.high);
    (u.uPeak.value as THREE.Color).setRGB(...L.peak);
    u.uVegetation.value = L.vegetation;
    u.uLava.value = L.lava;
    (u.uBand1.value as THREE.Color).setRGB(...L.band1);
    (u.uBand2.value as THREE.Color).setRGB(...L.band2);
    (u.uBand3.value as THREE.Color).setRGB(...L.band3);
    u.uStorm.value = L.storm;
    (u.uAtmo.value as THREE.Color).setRGB(...L.atmo);
    u.uAtmoStrength.value = L.atmoStrength * 0.6;
    pv.cloudMat.uniforms.uSeedLo.value = L.seed & 0xffff;
    pv.cloudMat.uniforms.uSeedHi.value = (L.seed >>> 16) & 0xffff;
    pv.cloudMat.uniforms.uCover.value = L.clouds;
    (pv.cloudMat.uniforms.uTint.value as THREE.Color).setRGB(...L.cloudTint);
    pv.clouds.visible = L.clouds > 0.02 && L.kind === 0;
    (pv.atmoMat.uniforms.uAtmo.value as THREE.Color).setRGB(...L.atmo);
    pv.atmoMat.uniforms.uStrength.value = L.atmoStrength * 0.45;
    pv.atmo.visible = L.atmoStrength > 0.02;
    pv.cityStamp = '';
  }

  /** Night-side city lights, orbital habitats and satellites from civilization state. */
  private updateCivVisuals(pv: PlanetVis, years: number, dr: number) {
    const sys = this.sys!;
    const civs = this.sim.civs;
    const home = civs.aliveIds.map((id) => civs.civs[id]).find((c) => c.capital.g === sys.g && c.capital.s === sys.s && c.capital.p === pv.index && c.born <= years);
    const colonized = civs.aliveIds.some((id) => civs.civs[id].colonies.some((k) => k.kind === 'planet' && k.g === sys.g && k.s === sys.s && k.p === pv.index));
    const u = pv.mat.uniforms;
    if (!home) {
      u.uCityLights.value = colonized ? 0.4 : 0;
      if (!colonized) u.uCityCount.value = 0;
      pv.habitat.visible = false;
      pv.sats.visible = false;
      return;
    }
    const L = techLevel(home.tech);
    const stamp = `${home.id}:${L}:${Math.round(Math.log10(Math.max(1, home.population)) * 4)}:${Math.round(home.territory * 20)}:${pv.lookStamp}`;
    if (stamp !== pv.cityStamp) {
      pv.cityStamp = stamp;
      const seed = (u.uSeedLo.value as number) | ((u.uSeedHi.value as number) << 16);
      const sea = u.uSea.value as number;
      const sites = citySites(seed >>> 0, sea, home.seed);
      const geo = civGeography(home, sites, seed >>> 0, sea);
      const arr = u.uCities.value as THREE.Vector4[];
      // Angular radius of each metropolitan area (rad): ~70–350 km on an Earth-sized world.
      geo.cities.slice(0, 32).forEach((c, i) => arr[i].set(c.dir[0], c.dir[1], c.dir[2], 0.008 + 0.03 * c.size * (L >= 2 ? 1 : 0.4)));
      u.uCityCount.value = Math.min(32, geo.cities.length);
      u.uCityLights.value = L >= 2 ? Math.min(1, 0.4 + 0.15 * L) : L === 1 ? 0.25 : 0.08;
    }
    pv.habitat.visible = home.colonies.some((k) => k.kind === 'orbital' && k.p === pv.index && k.s === sys.s);
    pv.habitat.scale.setScalar(dr);
    _vAxis.set(pv.axis[0], pv.axis[1], pv.axis[2]);
    pv.habitat.quaternion.setFromUnitVectors(_vZ, _vAxis);
    // Satellites: a swarm whose size follows the civ's satellite count.
    const nSat = home.satellites > 0 ? Math.min(220, 8 + Math.round(Math.sqrt(home.satellites) * 1.2)) : 0;
    if (nSat !== pv.satCount) {
      pv.satCount = nSat;
      const rng = new Rng(hash32(home.seed, 0x5a7));
      const pts = new Float32Array(nSat * 3);
      const params: number[] = [];
      for (let i = 0; i < nSat; i++) params.push(rng.range(1.08, 1.9), rng.range(0, TAU), rng.range(0, TAU), rng.range(-1.2, 1.2));
      pv.sats.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      pv.sats.geometry = g;
      pv.sats.userData.params = params;
    }
    pv.sats.visible = nSat > 0;
    if (nSat > 0) {
      const params = pv.sats.userData.params as number[];
      const attr = pv.sats.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const tt = phase(this.sim.clock, 1 / 365.25 / 12) * TAU; // ~2 h orbital period
      for (let i = 0; i < nSat; i++) {
        const r = params[i * 4] * dr, node = params[i * 4 + 1], m0 = params[i * 4 + 2], inc = params[i * 4 + 3];
        const a = m0 + tt * Math.pow(params[i * 4], -1.5);
        const x = Math.cos(a) * r, y0 = Math.sin(a) * r;
        arr[i * 3] = x * Math.cos(node) - y0 * Math.cos(inc) * Math.sin(node);
        arr[i * 3 + 1] = y0 * Math.sin(inc);
        arr[i * 3 + 2] = x * Math.sin(node) + y0 * Math.cos(inc) * Math.cos(node);
      }
      attr.needsUpdate = true;
    }
  }

  planetScreenInfo(index: number): { pos: Vec3; displayR: number } | null {
    const pv = this.planets[index];
    return pv ? { pos: pv.pos, displayR: pv.displayR } : null;
  }

  starInfo() {
    return { pos: this.starPos, displayR: this.starDisplayR };
  }
}
