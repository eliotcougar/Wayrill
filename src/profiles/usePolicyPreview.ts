import {
  policyPreviewView,
  type PolicyPreviewQuery,
  type PolicyPreviewView,
  type PolicyPreviewSnapshot,
} from './policyPreviewView';
import { useEffect, useMemo, useRef, useState } from 'react';
import { calculatePolicyPreview, type PolicyPreviewInput } from './policyPreview';
import type { GraphState, RuleNode } from '../graph/types';
import type { Stash } from './import';

export default function usePolicyPreview(
  graph: GraphState,
  node: RuleNode,
  stash: Stash,
  input: PolicyPreviewInput,
  enabled: boolean,
) {
  const [query, setQuery] = useState<PolicyPreviewQuery>({ search: '', page: 0 });
  const sent = useRef<PolicyPreviewInput | null>(null);
  const pendingCommit = useRef<((error: Error) => void) | null>(null);
  // Nested prepared definitions can reference subscriptions outside the root set.
  // Copy one complete subscription snapshot to the worker, rather than silently marking those links missing.
  const large =
    enabled &&
    typeof Worker !== 'undefined' &&
    (stash.groups.reduce((count, group) => count + group.entries.length, 0) +
      input.sources.manual.length +
      input.sources.subscriptions.reduce((count, source) => count + source.entries.length, 0) >
      500 ||
      (graph.xray?.outboundPool?.length ?? 0) > 500 ||
      JSON.stringify(input.sources.manual).length > 64 * 1024 ||
      (input.corePreview &&
        graph.nodes.some((n) => String(n.data.settings.sources ?? '').length > 64 * 1024)));
  const worker = useRef<Worker | null>(null),
    sequence = useRef(0),
    creationError = useRef('');
  const [completed, setCompleted] = useState<{
    input: PolicyPreviewInput;
    graph: GraphState;
    node: RuleNode;
    stash: Stash;
    query: PolicyPreviewQuery;
    result?: PolicyPreviewView;
    error?: string;
  }>();
  const sync = useMemo(() => {
    if (!enabled || large) return undefined;
    try {
      return { snapshot: calculatePolicyPreview(graph, node, stash, input) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid outbound set.' };
    }
  }, [enabled, large, graph, node, stash, input]);
  useEffect(() => {
    if (!large) return;
    creationError.current = '';
    sent.current = null;
    let instance: Worker;
    try {
      instance = new Worker(new URL('./policyPreview.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current = instance;
      instance.postMessage({ context: { graph, node, stash: stash } });
    } catch {
      worker.current?.terminate();
      worker.current = null;
      creationError.current =
        'Unable to start policy checks. Close and reopen this editor to retry.';
      return;
    }
    return () => {
      pendingCommit.current?.(new Error('Policy context changed before saving. Try again.'));
      pendingCommit.current = null;
      instance.terminate();
      worker.current = null;
    };
  }, [large, graph, node, stash]);
  useEffect(() => {
    if (!large) return;
    if (creationError.current) {
      setCompleted({ input, graph, node, stash, query, error: creationError.current });
      return;
    }
    if (!worker.current) return;
    const instance = worker.current,
      id = ++sequence.current;
    let active = true;
    const timeout = setTimeout(() => {
      if (active && sequence.current === id) {
        active = false;
        setCompleted({
          input,
          graph,
          node,
          stash,
          query,
          error: 'Policy preview timed out. Narrow the set or reopen this editor.',
        });
      }
    }, 60000);
    instance.onmessage = (
      event: MessageEvent<{ id: number; result?: PolicyPreviewView; error?: string }>,
    ) => {
      if (active && event.data.id === id && sequence.current === id) {
        clearTimeout(timeout);
        setCompleted({
          input,
          graph,
          node,
          stash,
          query,
          result: event.data.result,
          error: event.data.error,
        });
      }
    };
    instance.onerror = () => {
      if (active && sequence.current === id) {
        active = false;
        clearTimeout(timeout);
        const error = new Error(
          'Policy preview worker failed. Close and reopen this editor to retry.',
        );
        pendingCommit.current?.(error);
        setCompleted({ input, graph, node, stash, query, error: error.message });
      }
    };
    // Collapse rapid filter edits before sending a request. Copy only the filter
    // definitions for linked groups; the worker already owns the stash snapshot.
    const timer = setTimeout(() => {
      const linked = new Set(stash.groups.map((g) => g.id));
      const sources = {
        ...input.sources,
        subscriptions: input.sources.subscriptions.map((s) =>
          linked.has(s.groupId) ? { ...s, entries: [] } : s,
        ),
      };
      try {
        instance.postMessage({
          id,
          query,
          ...(sent.current === input
            ? {}
            : { input: { ...input, settings: { ...input.settings, sources: '' }, sources } }),
        });
        sent.current = input;
      } catch {
        active = false;
        clearTimeout(timeout);
        setCompleted({
          input,
          graph,
          node,
          stash,
          query,
          error: 'Unable to prepare this policy draft. Close and reopen the editor to retry.',
        });
      }
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, [large, graph, node, stash, input, query]);
  const state: { result?: PolicyPreviewView; error?: string } | undefined = large
    ? completed
    : sync?.snapshot
      ? { result: policyPreviewView(graph, sync.snapshot, query) }
      : sync;
  async function snapshot(): Promise<PolicyPreviewSnapshot> {
    if (!large) {
      if (!sync?.snapshot) throw new Error(sync?.error ?? 'Policy draft is not ready.');
      return sync.snapshot;
    }
    const instance = worker.current;
    const id = sequence.current;
    if (!instance || completed?.input !== input || completed.query !== query || completed.error)
      throw new Error('Wait for the current policy checks before saving.');
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        done();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('Saving the policy snapshot timed out.')),
        60000,
      );
      const receive = (
        event: MessageEvent<{ commit?: number; snapshot?: PolicyPreviewSnapshot; error?: string }>,
      ) => {
        if (event.data.commit !== id) return;
        done();
        if (event.data.error || !event.data.snapshot)
          reject(new Error(event.data.error ?? 'Policy snapshot is unavailable.'));
        else resolve(event.data.snapshot);
      };
      const done = () => {
        clearTimeout(timer);
        instance.removeEventListener('message', receive);
        pendingCommit.current = null;
      };
      pendingCommit.current = fail;
      instance.addEventListener('message', receive);
      try {
        instance.postMessage({ commit: id });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Could not save the policy snapshot.'));
      }
    });
  }
  return {
    result: state?.result,
    error: state?.error ?? '',
    query,
    setQuery,
    snapshot,
    pending:
      large &&
      (completed?.input !== input ||
        completed.query !== query ||
        completed.graph !== graph ||
        completed.node !== node ||
        completed.stash !== stash),
  };
}
