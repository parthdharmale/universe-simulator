/**
 * Deterministic randomness.
 *
 * Two primitives:
 *  - `hash32(...)`: a stateless integer hash. Used to derive child seeds from a parent
 *    seed plus an index ("hierarchical seeding"). Because every entity's seed is a pure
 *    function of its parent's seed and its own index, entities can be generated lazily,
 *    in any order, on any thread, and still be identical.
 *  - `Rng`: an sfc32 stream generator (small, fast, passes PractRand to 2^40+ bytes).
 *    Its whole state is four uint32 words, so it can be snapshotted and restored exactly.
 *
 * All arithmetic is done with Math.imul and >>> 0 so results are bit-identical across
 * JavaScript engines. Math.random() is never used for simulation state.
 */

/** 32-bit finalizer (lowbias32 by Chris Wellons). Bijective, excellent avalanche. */
export function mix32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash an arbitrary list of integers into a 32-bit seed. Order-sensitive. */
export function hash32(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < parts.length; i++) {
    // Fold non-integers deterministically (e.g. a float seed) via their low bits.
    const p = Number.isInteger(parts[i]) ? parts[i] : Math.floor(parts[i] * 4294967296);
    h = mix32(h ^ mix32((p >>> 0) + Math.imul(i + 1, 0x632be5ab)));
    // Also fold the high part for large integers (> 2^32).
    const hi = Math.floor(p / 4294967296);
    if (hi !== 0) h = mix32(h ^ (hi >>> 0));
  }
  return h >>> 0;
}

/** Stable string hash (FNV-1a then mixed) for named sub-streams. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** Uniform float in [0,1) directly from a hash (no stream needed). */
export function hashFloat(...parts: number[]): number {
  return hash32(...parts) / 4294967296;
}

export type RngState = [number, number, number, number];

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // Seed sfc32 with splitmix-style expansion so nearby seeds produce unrelated streams.
    const s = seed >>> 0;
    this.a = mix32(s ^ 0xa3c59ac3);
    this.b = mix32(s + 0x6a09e667);
    this.c = mix32(s ^ 0xbb67ae85);
    this.d = 1;
    // Warm up to decorrelate from the seed.
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  static fromState(state: RngState): Rng {
    const r = Object.create(Rng.prototype) as Rng;
    r.a = state[0] >>> 0;
    r.b = state[1] >>> 0;
    r.c = state[2] >>> 0;
    r.d = state[3] >>> 0;
    return r;
  }

  /** Full state snapshot. Note: the cached Box–Muller spare is intentionally discarded
   * on snapshot (we never cache it — see gaussian()). */
  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0,1) with 32 bits of entropy. */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Standard normal via Box–Muller. We deliberately do NOT cache the second value:
   * a cached spare would be hidden state that `getState()` cannot capture, which would
   * break exact snapshot/restore of civilization RNG streams.
   */
  gaussian(mean = 0, sd = 1): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal with given median and log-space sigma. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.gaussian(0, sigma));
  }

  /** Log-uniform between min and max (both > 0). */
  logRange(min: number, max: number): number {
    return Math.exp(this.range(Math.log(min), Math.log(max)));
  }

  exponential(mean: number): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    return -Math.log(u) * mean;
  }

  rayleigh(sigma: number): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    return sigma * Math.sqrt(-2 * Math.log(u));
  }

  /**
   * Poisson sample. Knuth for small lambda; normal approximation for large lambda.
   * Used for event counts over variable-length civilization timesteps.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(this.gaussian(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Derive an independent child stream without consuming from this one's sequence order. */
  fork(label: number): Rng {
    return new Rng(hash32(this.a, this.b, this.c, this.d, label));
  }
}
