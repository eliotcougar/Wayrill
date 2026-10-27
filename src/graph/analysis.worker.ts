import { analyzeGraph, type AnalysisScope } from './analysis';
import type { GraphState } from './types';
let timer: ReturnType<typeof setTimeout>;
self.onmessage = (
  event: MessageEvent<{ id: number; graph: GraphState; scope?: AnalysisScope }>,
) => {
  clearTimeout(timer);
  timer = setTimeout(
    () =>
      self.postMessage({
        id: event.data.id,
        result: analyzeGraph(event.data.graph, event.data.scope),
      }),
    40,
  );
};
