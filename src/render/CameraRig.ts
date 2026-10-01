import { KPC_PER_AU } from '../engine/core/constants';
import { Vec3, clamp } from '../engine/core/math';
import { EntityRef, sameRef } from '../engine/sim/types';

/**
 * Camera rig with hierarchical, precision-safe positions.
 *
 * Scale problem: the universe spans ~10⁴ kpc, a planet's radius is ~10⁻¹³ kpc. Even float64
 * cannot hold both: at 1000 kpc from the origin one ulp is ~7,000 km — an Earth radius.
 * So positions are *anchors*: a star (or galaxy/origin) base in kpc plus a local offset in
 * AU from that star. Layers never see absolute coordinates; they receive the focus point
 * expressed in their own frame (camera-relative rendering):
 *   - cosmic layer: kpc relative to the focus,
 *   - system layer: AU relative to the focus, computed from the anchor's *local* part, which
 *     is exact when the focus is inside that system.
 *
 * Transitions interpolate an *offset from the target* that shrinks to zero
 * (offset = (1 − ease(s)) · (source − target)), so as the camera arrives the remaining error
 * vanishes with it. Log-distance follows an arc that pulls back for long hops.
 */

export interface Anchor {
  /** Star that owns the local frame, or null (galaxy / universe). */
  star: [number, number] | null;
  /** Base position in world kpc (star, galaxy centre or origin). */
  base: Vec3;
  /** Offset from the base in AU (planet / moon positions). */
  local: Vec3;
}

export type AnchorResolver = (ref: EntityRef) => Anchor | null;
export type RadiusResolver = (ref: EntityRef) => number; // kpc
export type StarWorld = (g: number, s: number) => Vec3;

interface Transition {
  from: EntityRef;
  fromAnchor: Anchor;
  fromDist: number;
  to: EntityRef;
  toDist: number;
  t: number;
  duration: number;
  arc: number;
}

/** Difference a − b in kpc, exact when both share a star frame. */
export function anchorDiff(a: Anchor, b: Anchor): Vec3 {
  if (a.star && b.star && a.star[0] === b.star[0] && a.star[1] === b.star[1]) {
    return [(a.local[0] - b.local[0]) * KPC_PER_AU, (a.local[1] - b.local[1]) * KPC_PER_AU, (a.local[2] - b.local[2]) * KPC_PER_AU];
  }
  return [
    a.base[0] - b.base[0] + (a.local[0] - b.local[0]) * KPC_PER_AU,
    a.base[1] - b.base[1] + (a.local[1] - b.local[1]) * KPC_PER_AU,
    a.base[2] - b.base[2] + (a.local[2] - b.local[2]) * KPC_PER_AU,
  ];
}

export class CameraRig {
  focus: EntityRef = { kind: 'universe' };
  anchor: Anchor = { star: null, base: [0, 0, 0], local: [0, 0, 0] };
  /** Transition offset of the focus point from the target anchor (kpc). */
  offset: Vec3 = [0, 0, 0];
  distance = 4500;
  yaw = 0.6;
  pitch = 0.42;
  private yawT = 0.6;
  private pitchT = 0.42;
  private distT = 4500;
  /** Pan of the pivot from the focus (kpc, world axes). */
  pan: Vec3 = [0, 0, 0];
  private panT: Vec3 = [0, 0, 0];
  private transition: Transition | null = null;
  autoRotate = 0;

  constructor(
    private resolve: AnchorResolver,
    /** Framing radius (galaxy radius, planetary-system extent, body radius) in kpc. */
    private radiusOf: RadiusResolver,
    /** Physical surface radius in kpc (stars), for the closest approach. */
    private surfaceOf: RadiusResolver = radiusOf,
  ) {}

  get transitioning() {
    return this.transition !== null;
  }
  get transitionTarget(): EntityRef | null {
    return this.transition?.to ?? null;
  }
  get transitionSource(): EntityRef | null {
    return this.transition?.from ?? null;
  }

  minDistance(ref: EntityRef = this.focus): number {
    const r = this.radiusOf(ref);
    switch (ref.kind) {
      case 'universe':
        return 60;
      case 'galaxy':
        return Math.max(0.05, r * 0.03);
      case 'star':
        return Math.max(this.surfaceOf(ref) * 1.6, r * 1e-5);
      case 'planet':
      case 'moon':
        return r * 1.18;
      default:
        return r * 2;
    }
  }

  maxDistance(ref: EntityRef = this.focus): number {
    const r = this.radiusOf(ref);
    switch (ref.kind) {
      case 'universe':
        return 30000;
      case 'galaxy':
        return Math.max(r * 14, 400);
      case 'star':
        return Math.max(r * 30, 3000 * KPC_PER_AU);
      case 'planet':
      case 'moon':
        return Math.max(r * 6000, 4 * KPC_PER_AU);
      default:
        return r * 100;
    }
  }

  /** Comfortable framing distance when focusing an object. */
  defaultDistance(ref: EntityRef): number {
    const r = this.radiusOf(ref);
    switch (ref.kind) {
      case 'universe':
        return 4500;
      case 'galaxy':
        return r * 2.6;
      case 'star':
        return r * 2.2; // radiusOf(star) = extent of the planetary system
      case 'planet':
        return r * 3.4;
      case 'moon':
        return r * 4;
      default:
        return r * 4;
    }
  }

  setDistance(d: number) {
    this.distT = clamp(d, this.minDistance(), this.maxDistance());
  }

  flyTo(ref: EntityRef, distance?: number) {
    const toAnchor = this.resolve(ref);
    if (!toAnchor) return;
    const toDist = clamp(distance ?? this.defaultDistance(ref), this.minDistance(ref), this.maxDistance(ref));
    if (sameRef(ref, this.focus) && !this.transition) {
      this.distT = toDist;
      this.panT = [0, 0, 0];
      return;
    }
    // Source = the current pivot (focus + transition offset + pan), expressed as an anchor.
    const cur = this.currentAnchor();
    const sep = Math.hypot(...anchorDiff(toAnchor, cur));
    const ratio = Math.abs(Math.log(this.distance / toDist));
    const arc = Math.max(0, Math.log(Math.max(1e-30, sep) / Math.max(this.distance, toDist)) * 0.9 + 0.4);
    this.transition = {
      from: this.focus,
      fromAnchor: cur,
      fromDist: this.distance,
      to: ref,
      toDist,
      t: 0,
      duration: clamp(1.0 + 0.07 * ratio + 0.1 * arc, 1.0, 3.4),
      arc,
    };
    this.focus = ref;
    this.anchor = toAnchor;
    this.pan = [0, 0, 0];
    this.panT = [0, 0, 0];
  }

  /** The current pivot as an anchor (target anchor shifted by offset + pan). */
  private currentAnchor(): Anchor {
    const a = this.anchor;
    const sh: Vec3 = [this.offset[0] + this.pan[0], this.offset[1] + this.pan[1], this.offset[2] + this.pan[2]];
    if (a.star) return { star: a.star, base: a.base, local: [a.local[0] + sh[0] / KPC_PER_AU, a.local[1] + sh[1] / KPC_PER_AU, a.local[2] + sh[2] / KPC_PER_AU] };
    return { star: null, base: [a.base[0] + sh[0], a.base[1] + sh[1], a.base[2] + sh[2]], local: [...a.local] };
  }

  rotate(dx: number, dy: number) {
    this.yawT -= dx * 0.005;
    this.pitchT = clamp(this.pitchT + dy * 0.005, -1.5, 1.5);
  }

  zoom(delta: number) {
    this.distT = clamp(this.distT * Math.exp(delta * 0.0012), this.minDistance(), this.maxDistance() * 1.3);
  }

  panBy(dx: number, dy: number, right: Vec3, up: Vec3, viewportH: number) {
    const s = (this.distance * 1.15) / viewportH;
    for (let k = 0; k < 3; k++) this.panT[k] += (-dx * right[k] + dy * up[k]) * s;
  }

  /** True when the user has zoomed past the outer limit of the current focus. */
  wantsParent(): boolean {
    return !this.transition && this.distT > this.maxDistance() * 1.12 && this.focus.kind !== 'universe';
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 9);
    this.yawT += this.autoRotate * dt;
    this.yaw += (this.yawT - this.yaw) * k;
    this.pitch += (this.pitchT - this.pitch) * k;
    for (let i = 0; i < 3; i++) this.pan[i] += (this.panT[i] - this.pan[i]) * k;

    const tgt = this.resolve(this.focus);
    if (tgt) this.anchor = tgt;
    if (this.transition) {
      const tr = this.transition;
      tr.t = Math.min(1, tr.t + dt / tr.duration);
      const s = tr.t < 0.5 ? 4 * tr.t ** 3 : 1 - Math.pow(-2 * tr.t + 2, 3) / 2; // easeInOutCubic
      // Track a moving source only while it can be resolved.
      const src = this.resolve(tr.from);
      const fromA = src && tr.from.kind !== 'universe' ? src : tr.fromAnchor;
      const diff = anchorDiff(fromA, this.anchor);
      for (let i = 0; i < 3; i++) this.offset[i] = diff[i] * (1 - s);
      const logD = Math.log(tr.fromDist) + (Math.log(tr.toDist) - Math.log(tr.fromDist)) * s + tr.arc * Math.sin(Math.PI * s);
      this.distance = Math.exp(logD);
      this.distT = this.distance;
      if (tr.t >= 1) {
        this.transition = null;
        this.offset = [0, 0, 0];
        this.distance = tr.toDist;
        this.distT = tr.toDist;
      }
    } else {
      this.offset = [0, 0, 0];
      this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.distT) - Math.log(this.distance)) * k);
    }
  }

  /** Unit vector from pivot to camera. */
  direction(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

  /** Focus point in world kpc (cosmic precision only). */
  focusWorld(): Vec3 {
    const a = this.anchor;
    return [a.base[0] + a.local[0] * KPC_PER_AU + this.offset[0], a.base[1] + a.local[1] * KPC_PER_AU + this.offset[1], a.base[2] + a.local[2] * KPC_PER_AU + this.offset[2]];
  }

  /** Camera position relative to the focus point (kpc). */
  cameraRel(): Vec3 {
    const d = this.direction();
    return [this.pan[0] + d[0] * this.distance, this.pan[1] + d[1] * this.distance, this.pan[2] + d[2] * this.distance];
  }

  /**
   * Focus point inside the system of star (g, s), in AU relative to that star.
   * Exact when the focus anchor belongs to the same star.
   */
  focusInSystem(g: number, s: number, starWorld: StarWorld): Vec3 {
    const a = this.anchor;
    let p: Vec3;
    if (a.star && a.star[0] === g && a.star[1] === s) p = [...a.local];
    else {
      const sw = starWorld(g, s);
      p = [(a.base[0] - sw[0]) / KPC_PER_AU + a.local[0], (a.base[1] - sw[1]) / KPC_PER_AU + a.local[1], (a.base[2] - sw[2]) / KPC_PER_AU + a.local[2]];
    }
    return [p[0] + this.offset[0] / KPC_PER_AU, p[1] + this.offset[1] / KPC_PER_AU, p[2] + this.offset[2] / KPC_PER_AU];
  }
}
