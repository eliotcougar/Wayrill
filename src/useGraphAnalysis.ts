import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeGraph,
  emptyAnalysis,
  largeGraph,
  type GraphAnalysis,
  type AnalysisScope,
} from './graph/analysis';
import type { GraphState } from './graph/types';
export default function useGraphAnalysis(
  graph: GraphState,
  enabled = true,
  scope: AnalysisScope = 'runtime',
) {
  const large = enabled && typeof Worker !== 'undefined' && largeGraph(graph);
  const sequence = useRef(0),
    worker = useRef<Worker | null>(null);
  const [completed, setCompleted] = useState<{
    graph: GraphState;
    scope: AnalysisScope;
    result: GraphAnalysis;
  }>();
  const sync = useMemo(
    () => (enabled && !large ? analyzeGraph(graph, scope) : emptyAnalysis()),
    [enabled, large, graph, scope],
  );
  useEffect(() => {
    return () => {
      worker.current?.terminate();
      worker.current = null;
    };
  }, [large]);
  useEffect(() => {
    if (!large) return;
    const id = ++sequence.current;
    let active = true,
      finished = false,
      instance: Worker | null = null,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const retire = () => {
      if (!instance) return;
      instance.onmessage = null;
      instance.onerror = null;
      instance.terminate();
      if (worker.current === instance) worker.current = null;
    };
    const fail = (message: string) => {
      if (active && sequence.current === id) {
        finished = true;
        clearTimeout(timeout);
        retire();
        setCompleted({
          graph,
          scope,
          result: { ...emptyAnalysis(), issues: [{ severity: 'error', message }] },
        });
      }
    };
    const timer = setTimeout(() => {
      try {
        instance =
          worker.current ??
          new Worker(new URL('./graph/analysis.worker.ts', import.meta.url), {
            type: 'module',
          });
        worker.current = instance;
        instance.onmessage = (event: MessageEvent<{ id: number; result: GraphAnalysis }>) => {
          if (active && !finished && event.data.id === id && sequence.current === id) {
            finished = true;
            clearTimeout(timeout);
            setCompleted({ graph, scope, result: event.data.result });
          }
        };
        instance.onerror = () => fail('Graph checks failed. Edit the draft to retry.');
        timeout = setTimeout(
          () => fail('Graph checks timed out. Narrow the candidate set to retry.'),
          60000,
        );
        instance.postMessage({ id, graph, scope });
      } catch {
        fail('Unable to run graph checks. Edit the draft to retry.');
      }
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(timeout);
      if (!finished) retire();
      else if (instance) {
        instance.onmessage = null;
        instance.onerror = null;
      }
    };
  }, [large, graph, scope]);
  const pending = large && (completed?.graph !== graph || completed.scope !== scope);
  return { ...(large ? (pending ? emptyAnalysis() : completed!.result) : sync), pending };
}
