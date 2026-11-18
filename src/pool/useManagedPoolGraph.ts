import { useEffect, useRef, useState } from 'react';
import { parseGraph, serializeGraph, toDocument } from '../graph/model';
import { jsonRecord } from '../graph/xrayJson';
import type { GraphState } from '../graph/types';
import { protectedRead, protectedWrite } from '../protectedStorage';
import { errorText } from '../serviceClient';
import type useGraphEditor from '../useGraphEditor';
import { followPoolGraph, samePoolDocument } from './model';

type Baseline = { graph: GraphState; hash: string; hasPrevious: boolean };

async function readBaseline(): Promise<Baseline | undefined> {
  const text = await protectedRead('pool-base');
  if (!text) return undefined;
  const metadata: unknown = JSON.parse(text);
  if (!jsonRecord(metadata) || typeof metadata.poolBaseHash !== 'string') return undefined;
  return {
    graph: parseGraph(text),
    hash: metadata.poolBaseHash,
    hasPrevious: metadata.hasPrevious === true,
  };
}

/** Follow committed service documents. A graph being edited is never sent back to the service here. */
export default function useManagedPoolGraph(
  editor: ReturnType<typeof useGraphEditor>,
  applied: GraphState | undefined,
  hash: string | null,
  connected: boolean,
  notify: (message: string) => void,
) {
  const current = useRef(editor);
  current.current = editor;
  const baseline = useRef<Promise<Baseline | undefined> | undefined>(undefined);
  const followed = useRef<{ hash: string; request: number } | undefined>(undefined);
  const [request, setRequest] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [hasPrevious, setHasPrevious] = useState(false);
  const [error, setError] = useState('');
  const ready = editor.canFollowPool();
  const graph = editor.graph;
  useEffect(() => {
    if (!connected) {
      followed.current = undefined;
      return;
    }
    if (!applied?.poolId || !hash || !ready) return;
    const last = followed.current;
    if (last?.hash === hash && last.request === request) return;
    // A separately opened file stays editable. Enrollment and Show Pool graph
    // explicitly select the managed workspace, including on the first visit.
    const explicit = last?.request !== request && request > 0;
    if (last && !explicit && !graph.poolId) return;
    let active = true;
    const usable = () =>
      active && current.current.canFollowPool() && current.current.getGraph() === graph;
    async function synchronize(latest: GraphState, source: string) {
      const saved = await (baseline.current ??= readBaseline());
      if (!usable()) return;
      const base = saved?.hash === current.current.poolBaseHash ? saved?.graph : undefined;
      const appliedView = followPoolGraph(latest, graph);
      let next = appliedView;
      let park = !samePoolDocument(graph, next);
      if (
        park &&
        !explicit &&
        base &&
        base.poolId === latest.poolId &&
        graph.poolId === latest.poolId
      ) {
        try {
          if (!samePoolDocument(base, graph)) next = followPoolGraph(latest, graph, base);
          park = false;
        } catch {
          // Show the working delivery. Retain the entire conflicting graph for recovery.
        }
      }
      if (park) {
        await protectedWrite('pool-previous', serializeGraph(graph));
        if (!usable()) return;
      }
      const savedPrevious = park || !!saved?.hasPrevious;
      if (saved?.hash !== source || saved.hasPrevious !== savedPrevious) {
        await protectedWrite(
          'pool-base',
          JSON.stringify({
            ...toDocument(latest),
            poolBaseHash: source,
            hasPrevious: savedPrevious,
          }),
        );
        if (!usable()) return;
      }
      if (!current.current.showPoolGraph(next, source, appliedView)) return;
      baseline.current = Promise.resolve({
        graph: latest,
        hash: source,
        hasPrevious: savedPrevious,
      });
      followed.current = { hash: source, request };
      setHasPrevious(savedPrevious);
      setError('');
      if (park && graph.poolId === latest.poolId) {
        notify(
          'Showing the applied Pool graph. Your previous edits are available under Connection settings → Export previous local graph.',
        );
      }
    }
    void synchronize(applied, hash).catch((reason: unknown) => {
      if (!active) return;
      baseline.current = undefined;
      setError(errorText(reason));
    });
    return () => {
      active = false;
    };
  }, [applied, attempt, connected, graph, hash, notify, ready, request]);
  const syncing =
    connected &&
    !!hash &&
    (!applied ||
      (!!applied.poolId &&
        (!followed.current || !!graph.poolId || followed.current.request !== request) &&
        (followed.current?.hash !== hash || followed.current.request !== request)));
  return {
    hasPrevious,
    error,
    syncing,
    show: () => setRequest((value) => value + 1),
    retry: () => setAttempt((value) => value + 1),
  };
}
