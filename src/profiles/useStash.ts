import { defaultGroup } from './stashModel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeLibrary, writeServiceStash } from './serviceSubscriptions';
import useProtectedSlot from '../useProtectedSlot';
import { protectedSubscriptionEntries } from './subscriptionReferences';
import { materializeRefresh } from './refreshPreparation';
import { primePolicyRefresh } from '../graph/policySources';
import type { GraphState } from '../graph/types';
import { prepareImport, parseImport, mergeServiceStash } from './importClient';
import {
  mergeImport,
  serializeStash,
  seedStashSerialization,
  stashByteLength,
  MAX_STASH,
  MAX_ENTRIES,
  type ImportResult,
  type Stash,
  type StashGroup,
} from './import';
const empty = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: [defaultGroup()],
});
export default function useStash() {
  const [stash, setStash] = useState<Stash>(empty);
  const [base, setBase] = useState('');
  const source = useRef('');
  const [serviceError, setServiceError] = useState('');
  const current = useRef(stash);
  const runtimeGraph = useRef<GraphState | undefined>(undefined);
  const commit = (value: Stash) => {
    current.current = value;
    setStash(value);
  };
  const serialize = useMemo(() => {
    let text: string | undefined;
    return () => (text ??= serializeStash(stash));
  }, [stash]);
  const storage = useProtectedSlot(
    'stash',
    serialize,
    async (text) => {
      if (text !== null) {
        const result = await parseImport(text, 'Saved stash', true);
        source.current = text;
        setBase(text);
        commit({
          format: 'wayrill.stash',
          version: 3,
          groups: result.groups,
        });
      }
    },
    base,
  );
  useEffect(() => {
    let active = true;
    let syncing = Promise.resolve();
    const remove = subscribeLibrary((change) => {
      const synchronize = async () => {
        while (active) {
          const snapshot = current.current;
          const parsed = await mergeServiceStash(change.base, snapshot, change.text);
          if (!active) return;
          if (current.current !== snapshot) continue;
          source.current = change.text;
          setBase(change.text);
          if (parsed) commit({ format: 'wayrill.stash', version: 3, groups: parsed.groups });
          setServiceError('');
          return;
        }
      };
      const next = syncing.then(synchronize);
      syncing = next.catch((error: unknown) => {
        if (active)
          setServiceError(
            error instanceof Error ? error.message : 'Could not synchronize the service library.',
          );
      });
      return next;
    });
    return () => {
      active = false;
      remove();
    };
  }, []);
  function importResult(result: ImportResult, replaceId?: string, expected?: StashGroup) {
    if (!storage.ready)
      throw new Error('Protected stash is not available. Existing data was preserved.');
    if (expected && current.current.groups.find((g) => g.id === replaceId) !== expected)
      throw new Error(
        'This group changed while its update was processing. Existing entries were preserved; try again.',
      );
    const next = mergeImport(current.current, result, replaceId);
    commit(next);
    return next;
  }
  async function importText(
    text: string,
    name: string,
    previous?: StashGroup,
    signal?: AbortSignal,
    graph?: GraphState,
  ) {
    if (!storage.ready) throw new Error('Protected stash is not available.');
    const snapshot = current.current;
    if (previous && !snapshot.groups.includes(previous))
      throw new Error('This group changed. Try its update again.');
    const prepared = await prepareImport(
      {
        text,
        name,
        stash: snapshot,
        replaceId: previous?.id,
        graph,
        protectedEntries: [...protectedSubscriptionEntries(snapshot, runtimeGraph.current)],
      },
      signal,
    );
    signal?.throwIfAborted();
    if (current.current !== snapshot)
      throw new Error(
        'The stash changed while its update was processing. Existing entries were preserved; try again.',
      );
    const next = materializeRefresh(snapshot, prepared);
    seedStashSerialization(next, prepared.serialization);
    primePolicyRefresh(next, prepared.patches);
    commit(next);
    return prepared;
  }
  function update(transform: (current: Stash) => Stash) {
    if (!storage.ready) throw new Error('Protected stash is not available.');
    const next = transform(current.current);
    if (next === current.current) return next;
    if (
      next.groups.length > 500 ||
      next.groups.reduce((n, g) => n + g.entries.length, 0) > MAX_ENTRIES
    )
      throw new Error('The stash supports 500 subscription groups and 50,000 outbounds total.');
    if (stashByteLength(next) > MAX_STASH) throw new Error('The stash exceeds 64 MiB.');
    commit(next);
    return next;
  }
  return {
    stash,
    setRuntimeGraph: (value: GraphState | undefined) => {
      runtimeGraph.current = value;
    },
    get: () => current.current,
    getBase: () => source.current,
    serialize,
    flush: () => writeServiceStash(serializeStash(current.current), source.current),
    ready: storage.ready,
    loading: storage.loading,
    error: serviceError || storage.error,
    saving: storage.status === 'saving',
    importResult,
    importText,
    update,
  };
}
