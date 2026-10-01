import { useEffect, useRef } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { SPEED_PRESETS } from '../engine/sim/simulation';
import { TopBar } from './TopBar';
import { TimeControls } from './TimeControls';
import { TimeMachine } from './TimeMachine';
import { StatsPanel } from './StatsPanel';
import { EventFeed } from './EventFeed';
import { Inspector } from './Inspector';
import { DebugPanel } from './DebugPanel';
import { CivMapModal } from './CivMap';
import { ObserverModal } from './Observer';
import { SaveLoadModal } from './SaveLoad';
import { NewUniverseModal } from './NewUniverse';
import { HelpModal, JumpOverlay, LoadingOverlay, Toasts, Tooltip } from './Overlays';

function initialConfig() {
  const p = new URLSearchParams(location.search);
  const seed = Number(p.get('seed'));
  const galaxies = Number(p.get('galaxies'));
  const density = Number(p.get('density'));
  return {
    seed: Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : 847291,
    galaxyCount: Number.isFinite(galaxies) && galaxies >= 8 && galaxies <= 400 ? Math.floor(galaxies) : 128,
    starDensity: Number.isFinite(density) && density > 0 && density <= 4 ? density : 1,
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panels = useUI((s) => s.panels);
  const modal = useUI((s) => s.modal);

  useEffect(() => {
    runtime.attach(canvasRef.current!, overlayRef.current!);
    void runtime.boot(initialConfig());
    const onResize = () => runtime.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const ui = useUI.getState();
      if (e.key === ' ') {
        e.preventDefault();
        runtime.togglePause();
      } else if (e.key === 'Escape') {
        if (ui.modal) ui.set({ modal: null });
        else runtime.focusUp();
      } else if (e.key === '`' || e.key === '~') ui.togglePanel('debug');
      else if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      } else if (e.key === 'f' && ui.selected) runtime.select(ui.selected, true);
      else if (e.key === 'h') runtime.select({ kind: 'universe' }, true);
      else if (e.key === '?') ui.set({ modal: ui.modal === 'help' ? null : 'help' });
      else if (e.key === '.') runtime.step();
      else if (e.key === ']' || e.key === '[') {
        const sim = runtime.sim;
        if (!sim) return;
        const idx = SPEED_PRESETS.findIndex((p) => p.value >= sim.speed);
        const next = Math.max(0, Math.min(SPEED_PRESETS.length - 1, (idx < 0 ? SPEED_PRESETS.length - 1 : idx) + (e.key === ']' ? 1 : -1)));
        runtime.setSpeed(SPEED_PRESETS[next].value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <div className="viewport">
        <canvas ref={canvasRef} />
      </div>
      <div className="vignette" />
      <div className="overlay" ref={overlayRef} />
      <div className="overlay">
        <TopBar />
        <TimeControls />
        {panels.stats && <StatsPanel />}
        {panels.feed && <EventFeed />}
        {panels.inspector && <Inspector />}
        {panels.debug && <DebugPanel />}
        <TimeMachine />
        <Tooltip />
        <Toasts />
        <LoadingOverlay />
        <JumpOverlay />
        {modal === 'civmap' && <CivMapModal />}
        {modal === 'observer' && <ObserverModal />}
        {modal === 'saves' && <SaveLoadModal />}
        {modal === 'new' && <NewUniverseModal />}
        {modal === 'help' && <HelpModal />}
      </div>
    </div>
  );
}
