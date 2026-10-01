import { YEAR_S, PRESENT_YEARS } from '../engine/core/constants';
import { secondsIntoYear } from '../engine/core/time';
import { UniverseConfig } from '../engine/gen/galaxy';
import { Simulation } from '../engine/sim/simulation';
import { EntityRef } from '../engine/sim/types';
import { SurveyCancelled, SurveySignal, runSurvey } from '../engine/survey/surveyPool';
import { InterventionKind, InterventionTarget } from '../engine/sim/interventions';
import { SaveFile, applySave, createSave } from '../engine/persistence/save';
import { observerBaseline, observerSummary, ObserverBaseline } from '../engine/sim/observer';
import { Renderer } from '../render/Renderer';
import { useUI } from '../store/store';

/**
 * Runtime: the bridge between the simulation engine, the renderer and React.
 *
 * Frame loop (requestAnimationFrame):
 *   1. sim.update(realDt)  — advances simulation time by realDt × speed using fixed,
 *                            state-determined civilization steps within a work budget
 *   2. renderer.render()   — reads state; never mutates the simulation
 *   3. every ~125 ms       — publish a snapshot to the UI store (React renders at ≤8 Hz)
 */
class Runtime {
  sim: Simulation | null = null;
  renderer: Renderer | null = null;
  private raf = 0;
  private last = 0;
  private publishAcc = 0;
  private seriesAcc = 10;
  private generation = 0;
  private observer: (ObserverBaseline & { target: number }) | null = null;
  private surveySignal: SurveySignal | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private overlay: HTMLDivElement | null = null;

  attach(canvas: HTMLCanvasElement, overlay: HTMLDivElement) {
    this.canvas = canvas;
    this.overlay = overlay;
  }

  async boot(config: UniverseConfig, save?: SaveFile) {
    if (!this.canvas || !this.overlay) return;
    const gen = ++this.generation;
    // Abort a survey still running for the previous universe (terminates its workers).
    if (this.surveySignal) {
      this.surveySignal.cancelled = true;
      this.surveySignal.onCancel?.();
    }
    const signal: SurveySignal = { cancelled: false };
    this.surveySignal = signal;
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
    this.observer = null;
    const ui = useUI.getState();
    ui.set({ phase: 'surveying', surveyProgress: 0, seed: config.seed, galaxyCount: config.galaxyCount, starDensity: config.starDensity, selected: null, focus: { kind: 'universe' }, feed: [], stats: null, series: [], observer: null, modal: null, error: null });

    const sim = new Simulation(config);
    sim.speed = save?.speed ?? 1e15;
    this.sim = sim;
    const renderer = new Renderer(this.canvas, this.overlay, sim);
    renderer.settings = { ...ui.settings };
    this.renderer = renderer;
    renderer.onSelect = (ref) => useUI.getState().set({ selected: ref, panels: { ...useUI.getState().panels, inspector: true } });
    renderer.onHover = (h) => useUI.getState().set({ hover: h });
    renderer.onFocusChange = (ref) => useUI.getState().set({ focus: ref });
    this.resize();
    this.last = performance.now();
    this.loop();

    try {
      const surveys = await runSurvey(
        sim.universe.galaxies,
        (done, total) => {
          if (gen === this.generation) useUI.getState().set({ surveyProgress: done / total });
        },
        signal,
      );
      if (gen !== this.generation) return;
      sim.attachSurveys(surveys);
      renderer.cosmic.buildStars();
      if (save) {
        applySave(sim, save);
        if (save.focus) {
          useUI.getState().set({ selected: save.focus });
          renderer.focusOn(save.focus);
        }
      }
      sim.pushFeed({ t: sim.now(), category: 'system', title: 'Universe initialised', body: `Seed ${config.seed}: ${sim.universe.galaxies.length} galaxies, ${sim.catalog!.totalStars.toLocaleString('en-US')} stars, ${sim.catalog!.totalPlanets.toLocaleString('en-US')} planets catalogued.`, severity: 'info' });
      useUI.getState().set({ phase: 'ready' });
      this.publish(true);
    } catch (e) {
      if (e instanceof SurveyCancelled) return;
      if (gen === this.generation) useUI.getState().set({ phase: 'error', error: String(e) });
    }
  }

  resize() {
    if (!this.canvas || !this.renderer) return;
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.renderer.resize(r.width, r.height);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const sim = this.sim, renderer = this.renderer;
    if (!sim || !renderer) return;
    if (!useUI.getState().jump?.active) {
      if (this.observer && sim.ready && !sim.paused) {
        const remaining = this.observer.target - sim.now();
        const dy = (dt * sim.speed) / YEAR_S;
        if (dy >= remaining) {
          sim.advanceTo(this.observer.target);
          this.finishObserver();
        } else sim.update(dt, 10);
      } else sim.update(dt, 8);
    }
    renderer.render(dt);
    this.publishAcc += dt;
    this.seriesAcc += dt;
    if (this.publishAcc > 0.125) {
      this.publishAcc = 0;
      this.publish(false);
    }
  };

  publish(force: boolean) {
    const sim = this.sim, r = this.renderer;
    if (!sim || !r) return;
    const ui = useUI.getState();
    const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const patch: Partial<typeof ui> = {
      years: sim.now(),
      secondsIntoYear: secondsIntoYear(sim.clock),
      speed: sim.speed,
      paused: sim.paused,
      direction: sim.direction,
      lagging: sim.lagging,
      stats: sim.ready ? sim.stats() : null,
      feed: sim.feed.slice(-80),
      revision: ui.revision + 1,
      perf: {
        fps: r.stats.fps,
        frameMs: r.stats.frameMs,
        drawCalls: r.stats.drawCalls,
        triangles: r.stats.triangles,
        points: r.stats.points,
        memoryMB: perfMem ? perfMem.usedJSHeapSize / 1048576 : null,
        tps: sim.metrics.stepsPerSecond,
        stepsLastFrame: sim.metrics.stepsLastFrame,
        advanceMs: sim.metrics.advanceMs,
        activeEntities: sim.civs.aliveIds.length + sim.civs.aliveIds.reduce((s, id) => s + sim.civs.civs[id].colonies.length, 0),
        generatedEntities: (sim.catalog?.totalStars ?? 0) + (sim.catalog?.totalPlanets ?? 0) + sim.queries.systemsGenerated * 12 + sim.civs.civs.length,
        visibleEntities: r.stats.visibleEntities,
        eventQueue: sim.ready ? sim.pendingEventCount() : 0,
        checkpoints: sim.checkpointCount,
        geometries: r.stats.geometries,
        textures: r.stats.textures,
      },
    };
    if (force || this.seriesAcc > 2) {
      this.seriesAcc = 0;
      patch.series = sim.statsSeries(100);
    }
    ui.set(patch);
  }

  // ---- controls ----------------------------------------------------------------------------

  setSpeed(v: number) {
    if (!this.sim) return;
    this.sim.speed = v;
    this.sim.direction = 1;
    this.sim.paused = false;
    this.publish(false);
  }
  togglePause() {
    if (!this.sim) return;
    this.sim.paused = !this.sim.paused;
    this.publish(false);
  }
  rewind() {
    if (!this.sim) return;
    this.sim.direction = this.sim.direction === -1 ? 1 : -1;
    this.sim.paused = false;
    this.publish(false);
  }
  step() {
    if (!this.sim?.ready) return;
    this.sim.paused = true;
    this.sim.tick();
    this.publish(false);
  }
  resetToBigBang() {
    if (!this.sim) return;
    this.sim.resetTime();
    this.sim.paused = false;
    this.publish(true);
  }

  async jumpTo(target: number) {
    const sim = this.sim;
    if (!sim?.ready) return;
    useUI.getState().set({ jump: { active: true, progress: 0, target } });
    try {
      await sim.jumpTo(target, (f) => useUI.getState().set({ jump: { active: true, progress: f, target } }));
    } finally {
      useUI.getState().set({ jump: null });
      this.publish(true);
    }
  }

  jumpToPresent() {
    return this.jumpTo(PRESENT_YEARS);
  }

  /**
   * Civilizations are brief on cosmic timescales (most of an advanced civilization's history
   * is spent interstellar), so rising civilizations are rare at any given moment. This jumps
   * to just after the next scheduled emergence and selects it, so its rise can be watched.
   */
  async watchNextEmergence(): Promise<boolean> {
    const sim = this.sim;
    if (!sim?.ready) return false;
    const now = sim.now();
    const next = sim.civs.schedule.find((e) => e.t > now && !sim.civs.spawned.has(e.key));
    if (!next) {
      useUI.getState().pushToast({ title: 'No emergence ahead', body: ['No further civilizations arise in this universe’s future.'], tone: 'info' });
      return false;
    }
    await this.jumpTo(next.t + 1);
    const civ = sim.civs.civs.find((c) => c.g === next.g && c.s === next.s && c.p === next.p && c.born === next.t);
    if (civ) {
      this.select({ kind: 'planet', g: civ.g, s: civ.s, p: civ.p }, true);
      useUI.getState().set({ selected: { kind: 'civ', civ: civ.id } });
      this.setSpeed(1e10);
    }
    return !!civ;
  }

  select(ref: EntityRef | null, focus = true) {
    useUI.getState().set({ selected: ref });
    if (ref && focus) this.renderer?.focusOn(ref);
  }

  focusUp() {
    const r = this.renderer;
    if (!r) return;
    const parent = r.parentOf(r.rig.focus);
    r.focusOn(parent);
    useUI.getState().set({ selected: parent.kind === 'universe' ? null : parent });
  }

  intervene(kind: InterventionKind, target: InterventionTarget, params: Record<string, number>, previous: string, next: string) {
    const sim = this.sim;
    if (!sim?.ready) return;
    if (sim.jumping) {
      useUI.getState().pushToast({ title: 'Time machine busy', body: ['Interventions are disabled while a jump is in progress.'], tone: 'info' });
      return;
    }
    const iv = sim.intervene(kind, target, params, previous, next);
    useUI.getState().pushToast({ title: '⚠ UNIVERSE MODIFIED', body: [`User intervention: ${iv.label}`, sim.describeTarget(target), `Previous: ${previous}`, `New: ${next}`], tone: 'warn' });
    this.publish(true);
    return iv;
  }

  // ---- observer mode -------------------------------------------------------------------------

  startObserver(civ: number, years: number) {
    const sim = this.sim;
    if (!sim?.ready || !sim.civs.civs[civ]) return;
    const b = observerBaseline(sim, civ, years);
    this.observer = { ...b, target: sim.now() + years };
    // Run the observation in ~4 seconds of wall time, regardless of the duration.
    sim.speed = Math.max(1, (years * YEAR_S) / 4);
    sim.direction = 1;
    sim.paused = false;
    useUI.getState().set({ observer: { civ, duration: years, running: true, progress: 0, summary: null }, modal: 'observer' });
  }

  observerProgress(): number {
    if (!this.observer || !this.sim) return 0;
    return Math.min(1, (this.sim.now() - this.observer.t0) / this.observer.duration);
  }

  private finishObserver() {
    const sim = this.sim;
    if (!sim || !this.observer) return;
    const summary = observerSummary(sim, this.observer);
    this.observer = null;
    sim.paused = true;
    useUI.getState().set({ observer: { civ: summary.civ, duration: summary.t1 - summary.t0, running: false, progress: 1, summary } });
  }

  cancelObserver() {
    this.observer = null;
    if (this.sim) this.sim.paused = true;
    useUI.getState().set({ observer: null });
  }

  // ---- persistence ----------------------------------------------------------------------------

  makeSave(name: string): SaveFile | null {
    // Never capture a mid-jump state (the jump would continue after the snapshot).
    if (!this.sim?.ready || this.sim.jumping) return null;
    return createSave(this.sim, name, useUI.getState().selected);
  }

  async loadSave(save: SaveFile) {
    await this.boot(save.config, save);
  }
}

export const runtime = new Runtime();

// Debug handle for the browser console in development builds.
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __runtime: Runtime }).__runtime = runtime;
