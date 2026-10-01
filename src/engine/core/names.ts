import { Rng, hash32 } from './rng';

const ONSETS = ['', 'k', 'v', 'th', 'z', 'r', 'm', 'n', 's', 'l', 'd', 'x', 'qu', 'br', 'tr', 'sh', 'kh', 'ph', 'dr', 'gl', 'y', 'c', 'h', 'st'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'ei', 'ou', 'ia', 'y', 'eo'];
const CODAS = ['', '', '', 'n', 'r', 's', 'l', 'th', 'x', 'm', 'k', 'nd', 'rn', 'sh', 'v'];

function syllable(rng: Rng): string {
  return rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(CODAS);
}

export function properName(seed: number, minSyl = 2, maxSyl = 3): string {
  const rng = new Rng(seed);
  const n = rng.int(minSyl, maxSyl);
  let s = '';
  for (let i = 0; i < n; i++) s += syllable(rng);
  if (s.length > 11) s = s.slice(0, 11);
  if (s.length < 3) s += rng.pick(VOWELS) + 'n';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GALAXY_SUFFIX: Record<string, string[]> = {
  spiral: ['Spiral', 'Whorl', 'Pinwheel', 'Spiral'],
  elliptical: ['Ellipse', 'Elliptical', 'Halo', 'Cluster Giant'],
  irregular: ['Cloud', 'Irregular', 'Drift', 'Shoal'],
};

export function galaxyName(seed: number, type: string): string {
  const rng = new Rng(hash32(seed, 77));
  return `${properName(seed, 2, 3)} ${rng.pick(GALAXY_SUFFIX[type] ?? ['Galaxy'])}`;
}

const POLITY = ['Hegemony', 'Commonwealth', 'Collective', 'Concord', 'Dominion', 'Federation', 'Union', 'Assembly', 'Ascendancy', 'Republic', 'Covenant', 'Synod'];

export function speciesName(seed: number): string {
  return properName(hash32(seed, 5), 2, 3);
}

export function civName(seed: number, species: string): string {
  const rng = new Rng(hash32(seed, 9));
  const adj = species.endsWith('i') || species.endsWith('a') ? species + 'n' : species + 'i';
  return `${adj} ${rng.pick(POLITY)}`;
}

/**
 * Short catalogue code like "A-928". The number is a bijection of the civ id
 * (7919 is prime and coprime with 9000), so codes are unique for the first 9000 civs;
 * beyond that a generation suffix keeps them unique.
 */
export function civCode(seed: number, id: number): string {
  const letter = String.fromCharCode(65 + (hash32(seed, 3) % 26));
  const num = ((id % 9000) * 7919) % 9000 + 1000;
  return `${letter}-${num}${id >= 9000 ? '.' + Math.floor(id / 9000) : ''}`;
}

// ---- Hierarchical IDs ------------------------------------------------------------------
// Galaxy  G42
// Star    G42-S1234
// Planet  G42-S1234-b       (exoplanet convention: b, c, d … by orbital order)
// Moon    G42-S1234-b-II    (Roman numerals)

export const planetLetter = (p: number) => String.fromCharCode(98 + p); // 0 → 'b'
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
export const moonNumeral = (m: number) => ROMAN[m] ?? `M${m + 1}`;

export const galaxyId = (g: number) => `G${g}`;
export const starId = (g: number, s: number) => `G${g}-S${s}`;
export const planetId = (g: number, s: number, p: number) => `G${g}-S${s}-${planetLetter(p)}`;
export const moonId = (g: number, s: number, p: number, m: number) => `G${g}-S${s}-${planetLetter(p)}-${moonNumeral(m)}`;

export interface ParsedId {
  g: number;
  s?: number;
  p?: number;
  m?: number;
}

export function parseEntityId(text: string): ParsedId | null {
  const m = /^\s*G(\d+)(?:[\s\-·.:/]*S(\d+)(?:[\s\-·.:/]*([b-z])(?:[\s\-·.:/]*([IVX]+))?)?)?\s*$/i.exec(text);
  if (!m) return null;
  const out: ParsedId = { g: parseInt(m[1], 10) };
  if (m[2] !== undefined) out.s = parseInt(m[2], 10);
  if (m[3] !== undefined) out.p = m[3].toLowerCase().charCodeAt(0) - 98;
  if (m[4] !== undefined) {
    const idx = ROMAN.indexOf(m[4].toUpperCase());
    if (idx >= 0) out.m = idx;
  }
  return out;
}
