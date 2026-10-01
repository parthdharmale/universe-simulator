import { clamp, clamp01, smoothstep } from '../core/math';

/**
 * Zero-dimensional planetary climate model, iterated to a fixed point.
 *
 *  1. Equilibrium temperature   T_eq = 278.6 K · S^¼ · (1 − A)^¼     (S = insolation, Earth = 1)
 *  2. Gray-atmosphere greenhouse T_s  = T_eq · (1 + ¾ τ)^¼            (Eddington approximation)
 *     with optical depth τ = 0.08·P + 0.25·ln(1 + pCO₂/0.3 mbar) + 1.4·pCO₂
 *                           + 0.32·P^0.3·ln(1 + x_H₂O/0.008) + 3·pCH₄
 *     (logarithmic band saturation for CO₂ and H₂O, linear pressure broadening for thick CO₂)
 *  3. Water-vapour feedback      x_H₂O rises exponentially with T (Clausius–Clapeyron)
 *  4. Ice–albedo feedback        ice cover grows as T falls, raising A
 *  5. Carbonate–silicate cycle   with liquid water + active geology, the CO₂ reservoir is
 *                                 locked into carbonates, more strongly when warm
 *                                 (Walker, Hays & Kasting 1981 thermostat)
 *  6. Phase of water             liquid only between ~273 K and the pressure-dependent boiling point
 *
 * Calibrated so that Earth-like inputs give ≈288 K, Venus-like ≈730 K, Mars-like ≈210 K.
 */

export interface ClimateInput {
  /** Insolation relative to Earth (L / a²). */
  insolation: number;
  /** N₂ (+Ar) partial pressure, bar. */
  pN2: number;
  /** Total outgassed CO₂ reservoir, bar (what would be airborne with no weathering). */
  pCO2: number;
  /** CH₄ partial pressure, bar. */
  pCH4: number;
  /** O₂ partial pressure, bar (radiatively inert here, counts toward total pressure). */
  pO2: number;
  /** Water inventory in Earth-ocean units. */
  water: number;
  /** Geological activity 0..1 (drives weathering). */
  geology: number;
  /** External forcing added to surface temperature (K) — user interventions. */
  forcing: number;
  /** If true, CO₂ stays as given (no weathering) — used when the user sets it explicitly. */
  co2Locked?: boolean;
  /**
   * Temperature to start the fixed-point iteration from. The climate is bistable (warm vs.
   * snowball), so a perturbed planet must continue from its *current* state — hysteresis —
   * rather than from the airless equilibrium temperature.
   */
  initialTemp?: number;
}

export interface ClimateResult {
  surfaceTemp: number;
  equilibriumTemp: number;
  albedo: number;
  greenhouseK: number;
  pressure: number;
  liquidWater: number;
  ice: number;
  clouds: number;
  /** Airborne CO₂ partial pressure after weathering (bar). */
  pCO2: number;
  /** Water-vapour mole fraction. */
  h2o: number;
  boilingPoint: number;
}

/** Boiling point from the Clausius–Clapeyron relation (L/R ≈ 4892 K for water). */
export function boilingPointK(pressureBar: number): number {
  if (pressureBar <= 0.006) return 273.15;
  return 1 / (1 / 373.15 - Math.log(pressureBar) / 4892);
}

/** Fraction of the CO₂ reservoir left airborne by silicate weathering at temperature T. */
export function weatheringRetention(T: number): number {
  return clamp(1e-5 * Math.exp(-(T - 288) / 7), 1e-6, 1);
}

interface ClimateState {
  T: number;
  Tnew: number;
  teq: number;
  albedo: number;
  P: number;
  pCO2: number;
  liquid: number;
  ice: number;
  clouds: number;
  h2o: number;
  boil: number;
}

/**
 * Radiative response at a trial surface temperature T: every feedback quantity (water
 * phase, vapour, weathered CO₂, clouds, albedo) is evaluated at T, and the resulting
 * radiative-equilibrium temperature Tnew = f(T) is returned. Equilibria are fixed points
 * f(T) = T.
 */
function climateAt(T: number, inp: ClimateInput, teq0: number, coverage: number, dryP: number): ClimateState {
  // CO₂ depends on liquid water, which depends on the boiling point, which depends on the
  // pressure, which includes CO₂ — resolve the small loop at fixed T.
  let pCO2 = inp.pCO2;
  let P = dryP + pCO2;
  let boil = boilingPointK(P);
  let liquid = 0, ice = 0, h2o = 0;
  for (let k = 0; k < 4; k++) {
    boil = boilingPointK(P);
    const liquidPossible = P > 0.006;
    const above0 = smoothstep(266, 278, T);
    const belowBoil = liquidPossible ? 1 - smoothstep(boil - 6, boil + 2, T) : 0;
    liquid = coverage * above0 * belowBoil;
    // Polar caps on temperate worlds, complete freeze below ~240 K.
    const capFrac = clamp01((293 - T) / 55);
    ice = Math.min(coverage, Math.max(coverage * capFrac * 0.6, coverage * (1 - above0)));
    if (T > boil) ice = 0;
    liquid = Math.max(0, Math.min(liquid, coverage - ice * 0.5));
    // Weathering needs liquid water in contact with fresh rock.
    const weathering = smoothstep(0.02, 0.12, liquid) * smoothstep(0.05, 0.2, inp.geology);
    pCO2 = inp.pCO2 <= 0 ? 0 : inp.co2Locked ? inp.pCO2 : inp.pCO2 * (1 - weathering + weathering * weatheringRetention(T));
    P = dryP + pCO2;
  }
  // Vapour is bounded by the water actually available.
  const vapourCap = 0.3 * Math.sqrt(coverage);
  const wet = Math.max(liquid, 0.2 * ice, 0.03 * coverage);
  h2o = P > 0 ? Math.min(vapourCap, 0.035 * Math.sqrt(wet) * Math.exp(Math.min(40, (T - 288) / 17))) : 0;
  if (T > boil) h2o = Math.min(vapourCap, 0.12 * Math.sqrt(coverage));

  const clouds = P > 0.05 ? clamp(0.12 + 12 * h2o, 0, 0.85) : 0;
  const land = Math.max(0, 1 - liquid - ice);
  const surfA = 0.06 * liquid + 0.25 * land + 0.6 * ice;
  const haze = 0.55 * smoothstep(5, 60, P); // thick Venus-like cloud decks
  const albedo = clamp(clouds * 0.5 + (1 - clouds) * surfA + haze * (1 - clouds), 0.04, 0.9);
  const teq = teq0 * Math.pow(1 - albedo, 0.25);
  const tau =
    0.08 * P +
    (pCO2 > 0 ? 0.25 * Math.min(1, Math.pow(P, 0.3)) * Math.log(1 + pCO2 / 0.0003) + 1.4 * pCO2 : 0) +
    0.32 * Math.pow(P, 0.3) * Math.log(1 + h2o / 0.008) +
    3 * inp.pCH4;
  const Tnew = teq * Math.pow(1 + 0.75 * tau, 0.25) + inp.forcing;
  return { T, Tnew, teq, albedo, P, pCO2, liquid, ice, clouds, h2o, boil };
}

/**
 * Solve for the climate equilibrium.
 *
 * Instead of a damped fixed-point iteration (which can oscillate forever between the
 * snowball and warm branches near the edges of the habitable zone), the climate is treated
 * as the 1-D dynamical system dT/dt ∝ f(T) − T. Starting from the initial state we follow
 * the flow (walk in the direction of f(T) − T) until it changes sign, then bisect. The
 * result is the *stable* equilibrium in whose basin the planet currently sits:
 *   - newly formed planets start from their airless equilibrium temperature;
 *   - an intervention continues from the planet's current temperature (hysteresis), so a
 *     temperate world is not flipped into a snowball by a numerical artefact.
 */
export function solveClimate(inp: ClimateInput): ClimateResult {
  const teq0 = 278.6 * Math.pow(Math.max(1e-6, inp.insolation), 0.25);
  const coverage = 1 - Math.exp(-1.25 * Math.max(0, inp.water));
  const dryP = Math.max(0, inp.pN2) + Math.max(0, inp.pCH4) + Math.max(0, inp.pO2);
  const at = (T: number) => climateAt(T, inp, teq0, coverage, dryP);

  let lo = Math.max(3, inp.initialTemp ?? teq0);
  let sLo = at(lo);
  let g0 = sLo.Tnew - lo;
  let res: ClimateState = sLo;
  if (Math.abs(g0) > 1e-6) {
    const dir = g0 > 0 ? 1 : -1;
    let hi = lo;
    let found = false;
    // Geometric walk along the flow (≤ ~120 evaluations from 3 K to 6000 K).
    for (let k = 0; k < 160; k++) {
      const next = Math.min(6000, Math.max(3, hi * (dir > 0 ? 1.06 : 1 / 1.06)));
      const s = at(next);
      if ((s.Tnew - next) * dir <= 0) {
        lo = hi;
        hi = next;
        found = true;
        break;
      }
      if (next === hi) break; // clamped at a bound
      hi = next;
      sLo = s;
    }
    if (!found) {
      res = at(hi);
    } else {
      // Bisection on the bracket [lo, hi] (sign of g differs at the ends).
      let a = lo, b = hi;
      const ga = at(a).Tnew - a;
      for (let k = 0; k < 40; k++) {
        const m = 0.5 * (a + b);
        const gm = at(m).Tnew - m;
        if (gm === 0) {
          a = b = m;
          break;
        }
        if ((gm > 0) === (ga > 0)) a = m;
        else b = m;
      }
      res = at(0.5 * (a + b));
    }
    void g0;
  }
  g0 = 0;

  return {
    surfaceTemp: res.T,
    equilibriumTemp: res.teq,
    albedo: res.albedo,
    greenhouseK: res.T - res.teq - inp.forcing,
    pressure: res.P,
    liquidWater: res.liquid,
    ice: res.ice,
    clouds: res.clouds,
    pCO2: res.pCO2,
    h2o: res.h2o,
    boilingPoint: res.boil,
  };
}

/**
 * Atmospheric retention against thermal (Jeans) escape. A gas of molecular mass μ is held
 * over geological time when v_esc ≳ 6 · v_thermal, with v_th = √(3kT/μm_u).
 */
export function retention(vEscKmS: number, exosphereTempK: number, molecularMass: number): number {
  const vth = Math.sqrt((3 * 1.380649e-23 * exosphereTempK) / (molecularMass * 1.6605e-27)) / 1000;
  return smoothstep(4, 7.5, vEscKmS / vth);
}
