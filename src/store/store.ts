import { create } from 'zustand';
import { EntityRef, FeedEvent, UniverseStats } from '../engine/sim/types';
import { HoverInfo, RenderSettings } from '../render/Renderer';
import { ObserverSummary } from '../engine/sim/observer';

/**
 * UI state only. The simulation lives outside React (see app/runtime.ts) and is published
 * into this store at a throttled rate (≈8 Hz), so React re-renders never run per frame and
 * never touch simulation internals.
 */

export interface Toast {
  id: number;
  title: string;
  body: string[];
  tone: 'warn' | 'info' | 'good' | 'bad';
}

export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  memoryMB: number | null;
  tps: number;
  stepsLastFrame: number;
  advanceMs: number;
  activeEntities: number;
  generatedEntities: number;
  visibleEntities: number;
  eventQueue: number;
  checkpoints: number;
  geometries: number;
  textures: number;
}

export type Modal = null | 'civmap' | 'observer' | 'saves' | 'new' | 'help';

export interface UIState {
  phase: 'boot' | 'surveying' | 'ready' | 'error';
  error: string | null;
  surveyProgress: number;
  seed: number;
  galaxyCount: number;
  starDensity: number;
  years: number;
  secondsIntoYear: number;
  speed: number;
  paused: boolean;
  direction: 1 | -1;
  lagging: boolean;
  stats: UniverseStats | null;
  series: { t: number; stars: number; life: number; civs: number; habitable: number }[];
  feed: FeedEvent[];
  selected: EntityRef | null;
  focus: EntityRef;
  hover: HoverInfo | null;
  /** Bumped on every publish so derived views (inspector) refresh. */
  revision: number;
  panels: { stats: boolean; feed: boolean; inspector: boolean; debug: boolean };
  modal: Modal;
  civMapCiv: number | null;
  observer: { civ: number; duration: number; running: boolean; progress: number; summary: ObserverSummary | null } | null;
  toasts: Toast[];
  jump: { active: boolean; progress: number; target: number } | null;
  perf: PerfSnapshot;
  settings: RenderSettings;
  set: (p: Partial<UIState>) => void;
  togglePanel: (k: keyof UIState['panels']) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

let toastId = 1;

export const useUI = create<UIState>((set) => ({
  phase: 'boot',
  error: null,
  surveyProgress: 0,
  seed: 847291,
  galaxyCount: 128,
  starDensity: 1,
  years: 0,
  secondsIntoYear: 0,
  speed: 1e15,
  paused: false,
  direction: 1,
  lagging: false,
  stats: null,
  series: [],
  feed: [],
  selected: null,
  focus: { kind: 'universe' },
  hover: null,
  revision: 0,
  panels: { stats: true, feed: true, inspector: true, debug: false },
  modal: null,
  civMapCiv: null,
  observer: null,
  toasts: [],
  jump: null,
  perf: {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    points: 0,
    memoryMB: null,
    tps: 0,
    stepsLastFrame: 0,
    advanceMs: 0,
    activeEntities: 0,
    generatedEntities: 0,
    visibleEntities: 0,
    eventQueue: 0,
    checkpoints: 0,
    geometries: 0,
    textures: 0,
  },
  settings: { bloom: true, labels: true, orbits: true, grid: true, civMarkers: true, habitableZone: true },
  set: (p) => set(p),
  togglePanel: (k) => set((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
  pushToast: (t) =>
    set((s) => {
      const toast = { ...t, id: toastId++ };
      setTimeout(() => useUI.getState().dismissToast(toast.id), 7000);
      return { toasts: [...s.toasts.slice(-3), toast] };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
