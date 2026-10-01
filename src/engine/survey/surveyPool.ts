import { Galaxy } from '../gen/galaxy';
import { GalaxySurvey, surveyGalaxy } from './survey';

export type SurveyProgress = (done: number, total: number, survey: GalaxySurvey) => void;

export class SurveyCancelled extends Error {
  constructor() {
    super('survey cancelled');
  }
}

/** Cooperative cancellation handle (set `cancelled = true` to abort; workers are terminated). */
export interface SurveySignal {
  cancelled: boolean;
  onCancel?: () => void;
}

/** Main-thread survey, time-sliced so the page stays responsive. */
async function surveyOnMainThread(galaxies: Galaxy[], results: GalaxySurvey[], onDone: (r: GalaxySurvey) => void, signal?: SurveySignal) {
  for (const g of galaxies) {
    if (signal?.cancelled) throw new SurveyCancelled();
    if (results[g.index]) continue;
    const r = surveyGalaxy(g);
    results[g.index] = r;
    onDone(r);
    await new Promise((res) => setTimeout(res, 0));
  }
}

/**
 * Runs the survey across a pool of Web Workers (one per core, up to 8), largest galaxies
 * first for load balance. Results are deterministic regardless of which worker processes
 * which galaxy, because each galaxy's survey is a pure function.
 *
 * Robustness:
 *  - cancellation terminates the workers immediately (e.g. "New universe" during a survey);
 *  - if workers cannot be created or crash (CSP, memory), the remaining galaxies are
 *    surveyed on the main thread instead of failing.
 */
export async function runSurvey(galaxies: Galaxy[], onProgress?: SurveyProgress, signal?: SurveySignal): Promise<GalaxySurvey[]> {
  const results: GalaxySurvey[] = new Array(galaxies.length);
  const order = galaxies.slice().sort((a, b) => b.starCount - a.starCount || a.index - b.index);
  let done = 0;
  const onDone = (r: GalaxySurvey) => onProgress?.(++done, galaxies.length, r);

  const canUseWorkers = typeof Worker !== 'undefined' && typeof window !== 'undefined';
  if (!canUseWorkers) {
    await surveyOnMainThread(order, results, onDone, signal);
    return results;
  }

  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  const poolSize = Math.max(1, Math.min(8, hc - 1));
  const workers: Worker[] = [];
  try {
    for (let i = 0; i < poolSize; i++) workers.push(new Worker(new URL('./surveyWorker.ts', import.meta.url), { type: 'module' }));
  } catch {
    for (const w of workers) w.terminate();
    await surveyOnMainThread(order, results, onDone, signal);
    return results;
  }

  let next = 0;
  let workerFailure = false;
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal) signal.onCancel = () => reject(new SurveyCancelled());
      let active = workers.length;
      const retire = (w: Worker) => {
        w.terminate();
        active--;
        if (active === 0) {
          if (done === galaxies.length) resolve();
          else {
            workerFailure = true;
            resolve();
          }
        }
      };
      const dispatch = (w: Worker) => {
        if (signal?.cancelled) {
          reject(new SurveyCancelled());
          return;
        }
        if (next >= order.length) {
          retire(w);
          return;
        }
        const g = order[next++];
        (w as Worker & { current?: number }).current = g.index;
        w.postMessage({ id: g.index, galaxy: g });
      };
      for (const w of workers) {
        w.onmessage = (ev: MessageEvent<{ id: number; result?: GalaxySurvey; error?: string }>) => {
          if (signal?.cancelled) {
            reject(new SurveyCancelled());
            return;
          }
          if (ev.data.error || !ev.data.result) {
            retire(w); // its galaxy will be redone on the main thread
            return;
          }
          results[ev.data.id] = ev.data.result;
          onDone(ev.data.result);
          dispatch(w);
        };
        w.onerror = (e) => {
          e.preventDefault();
          retire(w);
        };
        dispatch(w);
      }
    });
  } finally {
    for (const w of workers) w.terminate();
    if (signal) signal.onCancel = undefined;
  }
  // Note: `results` may be sparse — Array.prototype.some skips holes, so check by index.
  let missing = false;
  for (let i = 0; i < galaxies.length; i++) if (!results[i]) missing = true;
  if (workerFailure || missing) await surveyOnMainThread(order, results, onDone, signal);
  return results;
}
