/** Physical and simulation constants (SI unless noted). */

export const G = 6.674e-11;
export const C_LIGHT = 2.998e8;
export const K_B = 1.380649e-23;
export const M_U = 1.6605e-27; // atomic mass unit, kg
export const SIGMA_SB = 5.670374e-8;

export const M_SUN = 1.989e30;
export const R_SUN = 6.957e8;
export const L_SUN = 3.828e26;
export const T_SUN = 5772;

export const M_EARTH = 5.972e24;
export const R_EARTH = 6.371e6;
export const M_JUPITER_IN_EARTH = 317.8;

export const AU = 1.495978707e11; // m
export const LY = 9.4607e15; // m
export const PC = 3.0857e16; // m
export const KPC = 3.0857e19; // m

export const AU_PER_KPC = KPC / AU; // ≈ 2.06e8
export const KPC_PER_AU = AU / KPC; // ≈ 4.85e-9
export const LY_PER_KPC = KPC / LY; // ≈ 3261.6

export const DAY_S = 86400;
export const YEAR_S = 365.25 * DAY_S; // Julian year, 31 557 600 s

/** Age of the universe "now" (Planck 2018), years. */
export const PRESENT_YEARS = 13.787e9;
/** Hard upper bound on simulated time. Star formation is generated up to here. */
export const MAX_YEARS = 50e9;

/** ΛCDM parameters used for the expansion history. */
export const OMEGA_M = 0.315;
export const OMEGA_L = 0.685;
// 67.4 km/s/Mpc; 1 Mpc = 3.0857e19 km (numerically equal to KPC in metres).
export const H0_PER_YEAR = (67.4 / 3.0857e19) * YEAR_S; // 1/yr

/** Gravitational parameter of the Sun in AU^3 / yr^2 (≈ 4π²). */
export const GM_SUN_AU3_YR2 = (G * M_SUN * YEAR_S * YEAR_S) / (AU * AU * AU);

/** Planet formation delay after star birth (disk lifetime + assembly), years. */
export const PLANET_FORMATION_DELAY = 3e7;
