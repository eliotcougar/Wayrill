import { parseGraph } from '../graph/model';
import { parseStash } from '../profiles/import';
import { subscriptionEngine } from '../profiles/serviceEngine';
import type { SimulationRequest, SimulationWorkspace } from './simulation';

self.onmessage = ({ data }: MessageEvent<SimulationRequest>) => {
  try {
    const prepared = subscriptionEngine(data);
    if (prepared.poolEntries) {
      self.postMessage({ result: prepared.poolEntries });
    } else if ('graph' in prepared && prepared.graph && prepared.stash) {
      const result: SimulationWorkspace = {
        graph: parseGraph(prepared.graph),
        stash: parseStash(prepared.stash),
      };
      self.postMessage({ result });
    } else {
      throw new Error('Could not prepare the published Pool configuration.');
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Could not process the Pool delivery.',
    });
  }
};
