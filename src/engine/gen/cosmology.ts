import { H0_PER_YEAR, OMEGA_L, OMEGA_M, PRESENT_YEARS } from '../core/constants';

/**
 * Flat ΛCDM scale factor (matter + Λ, radiation neglected):
 *   a(t) = (Ωm/ΩΛ)^(1/3) · sinh^(2/3)( 3/2 · √ΩΛ · H0 · t )
 * normalised so a(present) = 1 exactly.
 */
function rawScale(t: number): number {
  const x = 1.5 * Math.sqrt(OMEGA_L) * H0_PER_YEAR * Math.max(0, t);
  return Math.cbrt(OMEGA_M / OMEGA_L) * Math.pow(Math.sinh(x), 2 / 3);
}
const A_NORM = rawScale(PRESENT_YEARS);

export const scaleFactor = (tYears: number) => rawScale(tYears) / A_NORM;

/** Redshift of light emitted at time t and observed today. */
export const redshift = (tYears: number) => 1 / Math.max(1e-9, scaleFactor(tYears)) - 1;

/** CMB / radiation temperature in Kelvin, T = T0 / a. */
export const radiationTemperature = (tYears: number) => 2.7255 / Math.max(1e-9, scaleFactor(tYears));

/**
 * Scale factor used for *rendering* positions. Physical a(t) → 0 at the Big Bang, which
 * would collapse every galaxy onto one pixel; we keep a small floor so the primordial
 * plasma remains a visible (tiny, hot) volume.
 */
export const visualScale = (tYears: number) => Math.max(0.012, scaleFactor(tYears));

export interface Epoch {
  start: number;
  name: string;
  description: string;
}

export const EPOCHS: Epoch[] = [
  { start: 0, name: 'Planck / Inflation', description: 'Spacetime expands exponentially; quantum fluctuations seed all future structure.' },
  { start: 1e-30, name: 'Quark–gluon plasma', description: 'The universe is a hot soup of quarks, gluons and leptons.' },
  { start: 3 / (365.25 * 86400) * 60, name: 'Nucleosynthesis', description: 'Protons and neutrons fuse into helium and trace lithium in the first minutes.' },
  { start: 5e4, name: 'Photon–baryon plasma', description: 'Matter and radiation are coupled; the universe is opaque.' },
  { start: 3.8e5, name: 'Recombination', description: 'Electrons bind to nuclei; light decouples and becomes the cosmic microwave background.' },
  { start: 1e6, name: 'Dark Ages', description: 'Neutral hydrogen collapses into dark-matter halos. No stars yet shine.' },
  { start: 1.5e8, name: 'Cosmic Dawn', description: 'The first (Population III) stars ignite inside the densest halos.' },
  { start: 5e8, name: 'Reionization', description: 'Starlight from young galaxies re-ionizes the intergalactic medium.' },
  { start: 1.5e9, name: 'Galaxy Assembly', description: 'Galaxies merge and grow; cosmic star formation peaks near 3.5 Gyr.' },
  { start: 6e9, name: 'Stelliferous Era', description: 'Star formation declines; metal-rich disks host rocky planets and life.' },
  { start: 9.8e9, name: 'Dark-Energy Era', description: 'Cosmic acceleration dominates; star formation continues to fade.' },
];

export function epochAt(tYears: number): Epoch {
  let e = EPOCHS[0];
  for (const ep of EPOCHS) if (tYears >= ep.start) e = ep;
  return e;
}
