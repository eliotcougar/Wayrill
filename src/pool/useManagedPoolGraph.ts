import { useEffect, useRef, useState } from 'react';
import { serializeGraph } from '../graph/model';
import type { GraphState } from '../graph/types';
import { protectedRead, protectedWrite } from '../protectedStorage';
import { errorText } from '../serviceClient';
import type useGraphEditor from '../useGraphEditor';
import { followPoolGraph, samePoolDocument } from './model';

type Delivery = { hash: string; request: number };
type FollowState =
  | { phase: 'waiting' | 'archiving'; accepted?: Delivery }
  | { phase: 'following'; accepted: Delivery }
  | { phase: 'failed'; accepted?: Delivery; error: string };

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
  const [state, setState] = useState<FollowState>({ phase: 'waiting' });
  const accepted = state.accepted;
  const [request, setRequest] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [hasPrevious, setHasPrevious] = useState(false);
  const ready = editor.canFollowPool();
  const graph = editor.graph;
  useEffect(() => {
    if (!connected) return;
    let active = true;
    void protectedRead('pool-previous')
      .then((text) => {
        if (active && text !== null) setHasPrevious(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected]);
  useEffect(() => {
    if (!connected) {
      setState((state) =>
        state.phase === 'waiting' && !state.accepted ? state : { phase: 'waiting' },
      );
      return;
    }
    if (!applied?.poolId || !hash || !ready) return;
    if (accepted?.hash === hash && accepted.request === request) return;
    // A separately opened file stays editable. Enrollment and Show Pool graph
    // explicitly select the managed workspace, including on the first visit.
    const explicit = accepted?.request !== request && request > 0;
    if (accepted && !explicit && !graph.poolId) return;
    let active = true;
    const usable = () =>
      active && current.current.canFollowPool() && current.current.getGraph() === graph;
    async function synchronize(latest: GraphState, source: string) {
      if (!usable()) return;
      const base = current.current.poolBaseline?.graph;
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
        setState({ phase: 'archiving', accepted });
        await protectedWrite('pool-previous', serializeGraph(graph));
        setHasPrevious(true);
        if (!usable()) return;
      }
      if (!current.current.showPoolGraph(next, source, appliedView)) return;
      setState({ phase: 'following', accepted: { hash: source, request } });
      if (park && graph.poolId === latest.poolId) {
        notify(
          'Showing the applied Pool graph. Your previous edits are available under Connection settings → Export previous local graph.',
        );
      }
    }
    void synchronize(applied, hash).catch((reason: unknown) => {
      if (!active) return;
      setState({ phase: 'failed', accepted, error: errorText(reason) });
    });
    return () => {
      active = false;
    };
  }, [accepted, applied, attempt, connected, graph, hash, notify, ready, request]);
  const syncing =
    connected &&
    !!hash &&
    (!applied ||
      (!!applied.poolId &&
        (!accepted || !!graph.poolId || accepted.request !== request) &&
        (accepted?.hash !== hash || accepted.request !== request)));
  return {
    hasPrevious,
    error: state.phase === 'failed' ? state.error : '',
    syncing,
    show: () => setRequest((value) => value + 1),
    retry: () => setAttempt((value) => value + 1),
  };
}
