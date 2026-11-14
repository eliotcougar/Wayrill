import { useEffect, useRef, useState } from 'react';
import { parseGraph } from '../graph/model';
import { errorText } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import type useStash from './useStash';
import { readSubscriptionDocument } from './serviceSubscriptions';
import type { GraphState } from '../graph/types';

/** Read-only protection of applied references; the service owns activation. */
export default function useAppliedSubscriptionGraph(
  store: Pick<ReturnType<typeof useStash>, 'setRuntimeGraph'>,
  runtime: RuntimeController,
  ready: boolean,
  appliedRevision?: number | null,
  sourceHash?: string | null,
) {
  const current = useRef({ store, runtime });
  const [applied, setApplied] = useState<{
    revision?: number | null;
    sourceHash?: string | null;
    graph?: GraphState;
  }>();
  current.current = { store, runtime };
  useEffect(() => {
    if (!ready || !runtime.connected) return;
    const stopped = runtime.snapshot?.recovery?.desiredState === 'stopped';
    if (stopped) current.current.store.setRuntimeGraph(undefined);
    let active = true;
    void readSubscriptionDocument('applied')
      .then(({ text }) => {
        if (!active) return;
        const graph = text ? parseGraph(text) : undefined;
        setApplied({ revision: appliedRevision, sourceHash, graph });
        if (!stopped) current.current.store.setRuntimeGraph(graph);
      })
      .catch((error: unknown) => {
        if (active)
          current.current.runtime.setError(
            'Could not read applied subscription links: ' + errorText(error),
          );
      });
    return () => {
      active = false;
    };
  }, [
    ready,
    runtime.connected,
    runtime.snapshot?.recovery?.desiredState,
    appliedRevision,
    sourceHash,
  ]);
  return runtime.connected &&
    applied?.revision === runtime.snapshot?.config.revision &&
    applied?.sourceHash === sourceHash
    ? applied?.graph
    : undefined;
}
