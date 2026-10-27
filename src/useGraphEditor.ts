import { normalizeMainOutbound } from './quickSwitch';
import { editGraphNode } from './graph/nodeEditing';
import { clearNodePosition } from './graph/placement';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import { makeNode, uniqueInboundTag, uniqueOutboundTag } from './graph/catalog';
import { syncXrayConnections } from './graph/xrayCompiler';
import { updateImportedCoreDefaults } from './graph/nativeCore';
import { refreshPolicyGraph } from './graph/policySources';
import type { Stash } from './profiles/import';
import { isExecutableOutboundKind } from './graph/outbounds';
import { isInboundKind } from './graph/inbounds';
import { applyDefaults, enableDefaults, resolveGraph } from './graph/defaults';
import { createProxyStarter } from './graph/examples';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
  type WorkspaceHistory,
  type WorkspaceRevision,
} from './graph/workspaceHistory';
import { rebaseGraphDraft, syncGraphEdits, syncStashEdits } from './profiles/workspace';
import { removeStashEntries } from './profiles/stashModel';
import { serializeStash } from './profiles/import';
import type useStash from './profiles/useStash';
import { parseGraph, serializeGraph } from './graph/model';
import {
  applyConnectionEdit,
  connectionEditProblem,
  connectionIsEditable,
} from './graph/connectionEditing';
import type { Connection } from '@xyflow/react';
import type {
  GlobalDefaults,
  GraphState,
  NodeKind,
  RuleEdge,
  RuleNode,
  RuleNodeData,
} from './graph/types';

import useProtectedSlot from './useProtectedSlot';
import { canDuplicateNode, duplicateSelection, MAX_GRAPH_NODES } from './graph/editing';

export default function useGraphEditor(
  stash?: Stash,
  store?: Pick<ReturnType<typeof useStash>, 'get' | 'update'>,
  blocked = false,
) {
  const [history, setHistory] = useState(() => initialWorkspaceHistory(createProxyStarter()));
  const [loadVersion, setLoadVersion] = useState(0);
  const viewportKey = useRef(0);
  const [libraryError, setLibraryError] = useState('');
  const current = useRef(history);
  const locked = useRef(blocked);
  locked.current = blocked;
  const libraryStore = useRef(store);
  libraryStore.current = store;
  const dragStart = useRef<WorkspaceRevision | null>(null);
  const editStart = useRef<WorkspaceRevision | null>(null);
  // Serialize only when saving or exporting; pooled profiles must not block drag frames.
  const serialize = useMemo(() => {
    let text: string | undefined;
    return () => (text ??= serializeGraph(history.present.graph));
  }, [history.present.graph]);
  const storage = useProtectedSlot('workspace', serialize, (text) => {
    if (text !== null) {
      const next = initialWorkspaceHistory(parseGraph(text));
      current.current = next;
      setHistory(next);
    }
    setLoadVersion((version) => version + 1);
  });

  const publish = useCallback((next: WorkspaceHistory, persist = true) => {
    const store = libraryStore.current;
    if (persist && store && next.present.stash && store.get() !== next.present.stash)
      store.update(() => next.present.stash!);
    current.current = next;
    setHistory(next);
  }, []);
  function change(
    transform: (graph: GraphState) => GraphState,
    record = true,
    libraryTransform?: (library: Stash) => Stash,
    adopt = false,
    newViewportKey?: number,
  ) {
    if (storage.loading || locked.current) return false;
    let previous = current.current;
    const library =
      editStart.current || dragStart.current ? previous.present.stash : (store?.get() ?? stash);
    if (library && library !== previous.present.stash && previous.present.stash) {
      const linked = syncStashEdits(previous.present.graph, previous.present.stash, library);
      previous = commitWorkspaceHistory(previous, {
        graph: syncXrayConnections(resolveGraph(refreshPolicyGraph(linked, library))),
        stash: library,
      });
    }
    const base = library && libraryTransform ? libraryTransform(library) : library;
    const graphBefore = previous.present.graph;
    const draft = normalizeMainOutbound(transform(graphBefore));
    const synced =
      record && store && base
        ? syncGraphEdits(graphBefore, draft, base, adopt)
        : { graph: draft, stash: base };
    const graph = record
      ? syncXrayConnections(
          resolveGraph(
            synced.stash ? refreshPolicyGraph(synced.graph, synced.stash) : synced.graph,
          ),
        )
      : synced.graph;
    const present = {
      ...((newViewportKey ?? previous.present.viewportKey) === undefined
        ? {}
        : { viewportKey: newViewportKey ?? previous.present.viewportKey }),
      graph:
        libraryTransform && synced.stash ? syncStashEdits(graph, library, synced.stash) : graph,
      stash: synced.stash,
    };
    const next =
      record && !editStart.current && !dragStart.current
        ? commitWorkspaceHistory(previous, present)
        : { ...previous, present, ...(record ? { future: [] } : {}) };
    publish(next, !editStart.current && !dragStart.current);
    return true;
  }
  useEffect(() => {
    if (blocked || !stash || !storage.ready || editStart.current || dragStart.current) return;
    const store = libraryStore.current;
    try {
      const library = store?.get() ?? stash;
      const previous = current.current;
      if (previous.present.stash === library) return;
      const linked = syncStashEdits(previous.present.graph, previous.present.stash, library);
      const refreshed = refreshPolicyGraph(linked, library);
      const synced =
        store && !previous.present.stash
          ? syncGraphEdits(refreshed, refreshed, library, true)
          : { graph: refreshed, stash: library };
      const present = {
        graph: syncXrayConnections(resolveGraph(synced.graph)),
        stash: synced.stash,
      };
      publish(
        previous.present.stash
          ? commitWorkspaceHistory(previous, present)
          : { ...previous, present },
      );
      setLibraryError('');
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : 'Stash synchronization failed.');
    }
  }, [stash, storage.ready, publish, blocked]);

  function onNodesChange(changes: NodeChange<RuleNode>[]) {
    const record = changes.some(
      (item) =>
        item.type === 'remove' ||
        item.type === 'add' ||
        item.type === 'replace' ||
        (item.type === 'position' && dragStart.current === null),
    );
    change((graph) => ({ ...graph, nodes: applyNodeChanges(changes, graph.nodes) }), record);
  }
  function onEdgesChange(changes: EdgeChange<RuleEdge>[]) {
    const record = changes.some(
      (item) => item.type === 'remove' || item.type === 'add' || item.type === 'replace',
    );
    change((graph) => ({ ...graph, edges: applyEdgeChanges(changes, graph.edges) }), record);
  }
  function beginFieldEdit() {
    editStart.current ??= current.current.present;
  }
  function finishInteraction(before: WorkspaceRevision | null) {
    if (!before) {
      const latest = libraryStore.current?.get();
      const previous = current.current;
      if (latest && latest !== previous.present.stash) {
        const linked = syncStashEdits(previous.present.graph, previous.present.stash, latest);
        publish(
          commitWorkspaceHistory(previous, {
            graph: syncXrayConnections(resolveGraph(refreshPolicyGraph(linked, latest))),
            stash: latest,
          }),
          false,
        );
      }
      return;
    }
    let previous = { ...current.current, present: before };
    let present = current.current.present;
    const latest = libraryStore.current?.get();
    if (latest && before.stash && latest !== before.stash && latest !== present.stash) {
      // A subscription refresh can finish during a field edit or node drag.
      // Record that change first, then apply the user's edit to the current library.
      const refreshed = syncStashEdits(before.graph, before.stash, latest);
      previous = commitWorkspaceHistory(previous, {
        graph: syncXrayConnections(resolveGraph(refreshPolicyGraph(refreshed, latest))),
        stash: latest,
      });
      const draft = rebaseGraphDraft(before.graph, present.graph, previous.present.graph);
      const merged = syncGraphEdits(previous.present.graph, draft, latest);
      const linked = syncStashEdits(merged.graph, present.stash, merged.stash);
      present = {
        graph: syncXrayConnections(resolveGraph(refreshPolicyGraph(linked, merged.stash))),
        stash: merged.stash,
      };
    }
    publish(commitWorkspaceHistory(previous, present));
  }
  function endFieldEdit() {
    finishInteraction(editStart.current);
    editStart.current = null;
  }
  function beginDrag() {
    dragStart.current = current.current.present;
  }
  function endDrag() {
    finishInteraction(dragStart.current);
    dragStart.current = null;
  }
  function addNode(kind: NodeKind, position: { x: number; y: number }) {
    if (kind === 'ics-tun') {
      const existing = current.current.present.graph.nodes.find((n) => n.data.kind === kind);
      if (existing) {
        selectNode(existing.id);
        return existing;
      }
    }
    if (current.current.present.graph.nodes.length >= MAX_GRAPH_NODES)
      throw new Error(
        `The graph supports at most ${MAX_GRAPH_NODES} nodes. Keep other configurations in the stash.`,
      );
    const node = { ...makeNode(kind, position), selected: true };
    change((graph) => {
      node.position = clearNodePosition(graph.nodes, position);
      if (kind === 'fakedns')
        node.data.settings.pools =
          graph.nodes.find((n) => n.data.kind === 'fakedns')?.data.settings.pools ?? '';
      if (isExecutableOutboundKind(kind) || kind === 'policy-group' || kind === 'xray-outbound')
        node.data.settings.tag = uniqueOutboundTag(String(node.data.settings.tag), graph.nodes);
      if (isInboundKind(kind) || kind === 'xray-inbound')
        node.data.settings.tag = uniqueInboundTag(String(node.data.settings.tag), graph.nodes);
      if (kind === 'windivert-inbound') {
        const ports = new Set(
          graph.nodes
            .filter((n) => isInboundKind(n.data.kind))
            .map((n) => Number(n.data.settings.port)),
        );
        let port = Number(node.data.settings.port);
        while (ports.has(port) && port < 65535) port++;
        if (ports.has(port)) throw new Error('Choose an available private relay port.');
        node.data.settings.port = port;
      }
      return {
        ...graph,
        ...(graph.xray && kind === 'xray-dns'
          ? { xray: { ...graph.xray, dnsNodeId: node.id } }
          : {}),
        nodes: [...graph.nodes.map((item) => ({ ...item, selected: false })), node],
        edges: graph.edges.map((item) => ({ ...item, selected: false })),
      };
    });
    return node;
  }
  function updateNode(id: string, update: Partial<RuleNodeData>) {
    change((graph) => editGraphNode(graph, id, update));
  }
  function selectNode(id: string) {
    change(
      (graph) => ({
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          selected: node.id === id,
        })),
        edges: graph.edges.map((edge) => ({ ...edge, selected: false })),
      }),
      false,
    );
  }
  function selectEdge(id: string) {
    change(
      (graph) => ({
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, selected: false })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          selected: edge.id === id,
        })),
      }),
      false,
    );
  }
  function saveConnection(connection: Connection, edgeId?: string): string | null {
    const problem = connectionEditProblem(current.current.present.graph, connection, edgeId);
    if (problem) return problem;
    const id = edgeId ?? crypto.randomUUID();
    // Recheck against the graph in the history updater; a stale command never replaces a path.
    change((graph) => applyConnectionEdit(graph, connection, id, edgeId));
    return null;
  }
  function selectAll() {
    change(
      (graph) => ({
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, selected: true })),
      }),
      false,
    );
  }
  function removeSelected(deleteStash = false) {
    const links = current.current.present.graph.nodes
      .filter((n) => n.selected && n.data.stashLink)
      .map((n) => n.data.stashLink!);
    change(
      (graph) => {
        const selected = new Set(
          graph.nodes.filter((node) => node.selected).map((node) => node.id),
        );
        return {
          ...graph,
          nodes: graph.nodes.filter((node) => !selected.has(node.id)),
          edges: graph.edges.filter(
            (edge) =>
              !(edge.selected && connectionIsEditable(graph, edge)) &&
              !selected.has(edge.source) &&
              !selected.has(edge.target),
          ),
        };
      },
      true,
      deleteStash ? (library) => removeStashEntries(library, links) : undefined,
    );
  }
  function duplicateSelected() {
    const next = duplicateSelection(current.current.present.graph);
    change(() => next);
  }
  function loadGraph(graph: GraphState) {
    const accepted = change(
      (current) =>
        graph.defaults ? graph : applyDefaults(enableDefaults(graph), current.defaults!),
      true,
      undefined,
      true,
      ++viewportKey.current,
    );
    if (accepted) setLoadVersion((version) => version + 1);
    return accepted;
  }
  function restoreWorkspace(graph: GraphState, library: Stash, resetViewport = false) {
    if (storage.loading || !storage.ready || locked.current || !libraryStore.current)
      throw new Error(
        'The workspace is not ready for restoration. Try again after the current operation.',
      );
    if (dragStart.current || editStart.current)
      throw new Error('Finish the current edit before restoring a backup.');
    const previous = current.current;
    // One authored transaction, including its library, for Undo/Redo. Do not
    // re-import/adopt nodes through the outgoing workspace's shared definitions.
    publish(
      commitWorkspaceHistory(previous, {
        ...(resetViewport ? { viewportKey: ++viewportKey.current } : {}),
        graph: syncXrayConnections(resolveGraph(graph)),
        stash: library,
      }),
    );
    if (resetViewport) setLoadVersion((version) => version + 1);
  }
  const finishForClose = () => {
    if (dragStart.current) endDrag();
    endFieldEdit();
  };
  const closeActions = useRef({ finish: finishForClose, library: store });
  closeActions.current = { finish: finishForClose, library: store };
  const closeSerializers = useMemo(
    () => ({
      workspace: () => {
        closeActions.current.finish();
        return serializeGraph(current.current.present.graph);
      },
      stash: () =>
        serializeStash(closeActions.current.library?.get() ?? current.current.present.stash!),
    }),
    [],
  );
  const selectedNodes = history.present.graph.nodes.filter((node) => node.selected);
  const selectedEdges = history.present.graph.edges.filter((edge) => edge.selected);
  return {
    graph: history.present.graph,
    getGraph: () => current.current.present.graph,
    serialize,
    serializeForClose: closeSerializers.workspace,
    serializeStashForClose: closeSerializers.stash,
    saveStatus: storage.status,
    storageError: storage.error || libraryError,
    storageReady: storage.ready,
    loading: storage.loading,
    loadVersion,
    selectedNodes,
    selectedEdges,
    canDuplicate: selectedNodes.some((node) => canDuplicateNode(node, history.present.graph)),
    canUndo: !!history.past.length || !!editStart.current,
    canRedo: !!history.future.length,
    undo: () => {
      if (locked.current) return;
      endFieldEdit();
      const next = undoWorkspaceHistory(current.current);
      const restoreView = next.present.viewportKey !== current.current.present.viewportKey;
      publish(next);
      if (restoreView) setLoadVersion((version) => version + 1);
    },
    redo: () => {
      if (locked.current) return;
      endFieldEdit();
      const next = redoWorkspaceHistory(current.current);
      const restoreView = next.present.viewportKey !== current.current.present.viewportKey;
      publish(next);
      if (restoreView) setLoadVersion((version) => version + 1);
    },
    change,
    onNodesChange,
    onEdgesChange,
    beginFieldEdit,
    endFieldEdit,
    beginDrag,
    endDrag,
    updateDefaults: (defaults: GlobalDefaults) =>
      change((graph) => updateImportedCoreDefaults(graph, defaults)),
    addNode,
    updateNode,
    selectNode,
    selectEdge,
    saveConnection,
    selectAll,
    removeSelected,
    duplicateSelected,
    loadGraph,
    restoreWorkspace,
    setViewport: (viewport: Viewport) => change((graph) => ({ ...graph, viewport }), false),
  };
}
