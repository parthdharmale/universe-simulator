export type EntityKind = 'universe' | 'galaxy' | 'star' | 'planet' | 'moon' | 'civ';

export interface EntityRef {
  kind: EntityKind;
  g?: number;
  s?: number;
  p?: number;
  m?: number;
  civ?: number;
}

export const refKey = (r: EntityRef | null | undefined) =>
  r ? `${r.kind}:${r.g ?? ''}:${r.s ?? ''}:${r.p ?? ''}:${r.m ?? ''}:${r.civ ?? ''}` : 'none';

export const sameRef = (a: EntityRef | null | undefined, b: EntityRef | null | undefined) => refKey(a) === refKey(b);

export type FeedCategory = 'cosmic' | 'galaxy' | 'star' | 'life' | 'civ' | 'intervention' | 'system';
export type Severity = 'info' | 'notable' | 'warning' | 'critical';

export interface FeedEvent {
  id: number;
  t: number;
  wall: number;
  category: FeedCategory;
  title: string;
  body: string;
  ref?: EntityRef;
  severity: Severity;
}

export interface UniverseStats {
  t: number;
  galaxies: number;
  stars: number;
  remnants: number;
  planets: number;
  moonsEstimate: number;
  habitable: number;
  lifeBearing: number;
  complexLife: number;
  intelligent: number;
  civilizations: number;
  spacefaring: number;
  interstellar: number;
  population: number;
  colonies: number;
  civsEver: number;
  extinctCivs: number;
}
