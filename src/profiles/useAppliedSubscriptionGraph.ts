import { useEffect, useRef } from 'react';
import { parseGraph } from '../graph/model';
import { errorText } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import type useStash from './useStash';
import { readSubscriptionDocument } from './serviceSubscriptions';

/** Read-only protection of applied references; the service owns activation. */
export default function useAppliedSubscriptionGraph(
  store: Pick<ReturnType<typeof useStash>, 'setRuntimeGraph'>,
  runtime: RuntimeController,
  ready: boolean,
  appliedRevision?: number | null,
  sourceHash?: string | null,
) {
  const current = useRef({ store, runtime });
  current.current = { store, runtime };
  useEffect(() => {
    if (!ready || !runtime.connected) return;
    if (runtime.snapshot?.recovery?.desiredState === 'stopped') {
      current.current.store.setRuntimeGraph(undefined);
      return;
    }
    let active = true;
    void readSubscriptionDocument('applied')
      .then(({ text }) => {
        if (active) current.current.store.setRuntimeGraph(text ? parseGraph(text) : undefined);
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
}
