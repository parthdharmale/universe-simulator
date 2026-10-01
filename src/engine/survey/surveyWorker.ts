/// <reference lib="webworker" />
import { Galaxy } from '../gen/galaxy';
import { surveyGalaxy, surveyTransferables } from './survey';

/**
 * Survey worker: receives galaxy descriptors (plain data), returns surveys with all typed
 * arrays transferred (zero-copy). Galaxies are processed one at a time so the main thread
 * gets incremental progress and the pool can load-balance.
 */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<{ id: number; galaxy: Galaxy }>) => {
  const { id, galaxy } = ev.data;
  try {
    const result = surveyGalaxy(galaxy);
    self.postMessage({ id, result }, surveyTransferables(result));
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
