import { AU, G, GM_SUN_AU3_YR2, M_EARTH, M_SUN, R_EARTH, YEAR_S } from '../core/constants';
import { TAU, Vec3, wrapAngle } from '../core/math';
import { SimTime, phase } from '../core/time';

/**
 * Two-body Keplerian orbits with secular corrections.
 *
 * Units inside this module: AU, years, solar masses (G·M☉ = 4π² AU³/yr²).
 * Moons use the same machinery with the planet's mass as the central mass.
 */

export interface OrbitalElements {
  /** Semi-major axis (AU). */
  a: number;
  /** Eccentricity [0,1). */
  e: number;
  /** Inclination (rad). */
  i: number;
  /** Longitude of ascending node Ω (rad). */
  node: number;
  /** Argument of periapsis ω at epoch (rad). */
  argPeri: number;
  /** Mean anomaly at t = 0 (rad). */
  M0: number;
  /** Orbital period (years). */
  period: number;
  /** Apsidal precession rate (rad/yr) from secular perturbations (0 if none). */
  precession: number;
}

/** Kepler's third law: P = 2π √(a³ / GM). centralMass in solar masses. */
export function orbitalPeriodYears(aAU: number, centralMassSun: number): number {
  return TAU * Math.sqrt((aAU * aAU * aAU) / (GM_SUN_AU3_YR2 * centralMassSun));
}

/** Vis-viva: v = √(GM (2/r − 1/a)), returned in km/s. */
export function visVivaKmS(rAU: number, aAU: number, centralMassSun: number): number {
  const gm = G * centralMassSun * M_SUN;
  const v = Math.sqrt(gm * (2 / (rAU * AU) - 1 / (aAU * AU)));
  return v / 1000;
}

/**
 * Solve Kepler's equation E − e·sin E = M for the eccentric anomaly.
 * Newton–Raphson with a robust starting guess (E0 = π for high e), converging to
 * |residual| < 1e-12 in ≤ ~6 iterations for e ≤ 0.97.
 */
export function solveKepler(M: number, e: number): number {
  const Mw = wrapAngle(M);
  let E = e < 0.8 ? Mw : Math.PI;
  for (let k = 0; k < 30; k++) {
    const f = E - e * Math.sin(E) - Mw;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

export function trueAnomalyFromEccentric(E: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/** Mean anomaly at time t, evaluated with the precision-preserving phase() helper. */
export function meanAnomalyAt(el: OrbitalElements, t: SimTime): number {
  return TAU * phase(t, el.period, el.M0 / TAU);
}

/**
 * Position in the parent's reference frame (AU). The orbital plane is rotated by
 * (Ω, i, ω) using the standard perifocal → reference transformation; ω advances
 * linearly with the secular precession rate.
 * Frame convention: y is "up" (the system's invariable plane is x–z) to match the renderer.
 */
export function orbitalPosition(el: OrbitalElements, t: SimTime, tYears: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const M = meanAnomalyAt(el, t);
  const E = solveKepler(M, el.e);
  const nu = trueAnomalyFromEccentric(E, el.e);
  const r = el.a * (1 - el.e * Math.cos(E));
  const w = el.argPeri + el.precession * tYears;
  return perifocalToFrame(r, nu + w, el, out);
}

function perifocalToFrame(r: number, u: number, el: OrbitalElements, out: Vec3): Vec3 {
  // u = argument of latitude (ν + ω)
  const cosO = Math.cos(el.node), sinO = Math.sin(el.node);
  const cosI = Math.cos(el.i), sinI = Math.sin(el.i);
  const cosU = Math.cos(u), sinU = Math.sin(u);
  // Standard (x, y, z) = r(cosΩcosu − sinΩsinu cos i, sinΩcosu + cosΩsinu cos i, sinu sin i)
  // mapped to the renderer's y-up frame as (x, z, −y), so prograde orbits run
  // counter-clockwise seen from +y and the orbital angular momentum points along +y.
  const x = r * (cosO * cosU - sinO * sinU * cosI);
  const zz = -r * (sinO * cosU + cosO * sinU * cosI);
  const y = r * (sinU * sinI);
  out[0] = x;
  out[1] = y;
  out[2] = zz;
  return out;
}

/** Sample the full ellipse (for orbit lines). Returns flat xyz array (AU). */
export function orbitPolyline(el: OrbitalElements, tYears: number, segments = 256): Float32Array {
  const pts = new Float32Array((segments + 1) * 3);
  const w = el.argPeri + el.precession * tYears;
  const tmp: Vec3 = [0, 0, 0];
  for (let k = 0; k <= segments; k++) {
    // Sample uniformly in eccentric anomaly — denser near periapsis where curvature is high.
    const E = (k / segments) * TAU;
    const nu = trueAnomalyFromEccentric(E, el.e);
    const r = el.a * (1 - el.e * Math.cos(E));
    perifocalToFrame(r, nu + w, el, tmp);
    pts[k * 3] = tmp[0];
    pts[k * 3 + 1] = tmp[1];
    pts[k * 3 + 2] = tmp[2];
  }
  return pts;
}

/** Specific orbital energy ε = −GM/2a (AU²/yr²). Constant along the orbit. */
export const specificEnergy = (aAU: number, centralMassSun: number) => (-GM_SUN_AU3_YR2 * centralMassSun) / (2 * aAU);

/** Hill radius r_H = a(1−e) ∛(m / 3M). Masses in any consistent unit. */
export function hillRadius(aAU: number, e: number, m: number, M: number): number {
  return aAU * (1 - e) * Math.cbrt(m / (3 * M));
}

/** Mutual Hill radius of two adjacent planets (Chambers et al. 1996). */
export function mutualHillRadius(a1: number, a2: number, m1: number, m2: number, M: number): number {
  return Math.cbrt((m1 + m2) / (3 * M)) * ((a1 + a2) / 2);
}

/** Fluid Roche limit d = 2.44 R_p (ρ_p/ρ_s)^(1/3), in the unit of the radius passed in. */
export function rocheLimit(planetRadius: number, planetDensity: number, satelliteDensity: number): number {
  return 2.44 * planetRadius * Math.cbrt(planetDensity / satelliteDensity);
}

/**
 * Leading-order Laplace coefficient b^(1)_{3/2}(α), computed by numerical quadrature of
 *   b = (1/π) ∫₀^{2π} cos ψ / (1 − 2α cos ψ + α²)^{3/2} dψ
 */
export function laplaceB32_1(alpha: number): number {
  const N = 48; // periodic integrand → midpoint rule converges exponentially
  let s = 0;
  for (let k = 0; k < N; k++) {
    const psi = ((k + 0.5) / N) * TAU;
    s += Math.cos(psi) / Math.pow(1 - 2 * alpha * Math.cos(psi) + alpha * alpha, 1.5);
  }
  return (s * (TAU / N)) / Math.PI;
}

/**
 * Secular apsidal precession rate of planet i due to the other planets
 * (Laplace–Lagrange, Murray & Dermott eq. 7.28 diagonal term):
 *   ϖ̇_i = n_i/4 · Σ_j (m_j / (M* + m_i)) · α_ij · ᾱ_ij · b^(1)_{3/2}(α_ij)
 * where α = a_inner/a_outer, ᾱ = α if j is outer, 1 if j is inner.
 * Masses in solar masses, a in AU, returns rad/yr.
 */
export function secularPrecessionRates(as: number[], ms: number[], starMass: number): number[] {
  const out = new Array(as.length).fill(0);
  for (let i = 0; i < as.length; i++) {
    const n = TAU / orbitalPeriodYears(as[i], starMass + ms[i]);
    let s = 0;
    for (let j = 0; j < as.length; j++) {
      if (j === i) continue;
      const outer = as[j] > as[i];
      const alpha = outer ? as[i] / as[j] : as[j] / as[i];
      const alphaBar = outer ? alpha : 1;
      s += (ms[j] / (starMass + ms[i])) * alpha * alphaBar * laplaceB32_1(alpha);
    }
    out[i] = (n / 4) * s;
  }
  return out;
}

/**
 * Tidal locking timescale (Gladman et al. 1996):
 *   t_lock = ω a⁶ I Q / (3 G m_s² k₂ R⁵),  I = 0.4 m_p R²
 * Returns years. Inputs: a (AU), initial spin period (hours), planet mass/radius (Earth),
 * perturber (star) mass (solar).
 */
export function tidalLockTimeYears(aAU: number, spinHours: number, mEarth: number, rEarth: number, starMassSun: number, Q = 100, k2 = 0.3): number {
  const w = TAU / (spinHours * 3600);
  const a = aAU * AU;
  const mp = mEarth * M_EARTH;
  const R = rEarth * R_EARTH;
  const ms = starMassSun * M_SUN;
  const I = 0.4 * mp * R * R;
  const t = (w * Math.pow(a, 6) * I * Q) / (3 * G * ms * ms * k2 * Math.pow(R, 5));
  return t / YEAR_S;
}

/** Barycentric reflex offset of the star given planet positions (AU) and masses (M☉). */
export function stellarReflex(planetPositions: Vec3[], planetMassesSun: number[], starMass: number): Vec3 {
  const o: Vec3 = [0, 0, 0];
  for (let k = 0; k < planetPositions.length; k++) {
    const f = planetMassesSun[k] / starMass;
    o[0] -= planetPositions[k][0] * f;
    o[1] -= planetPositions[k][1] * f;
    o[2] -= planetPositions[k][2] * f;
  }
  return o;
}
