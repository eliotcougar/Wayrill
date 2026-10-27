import { forceProjectionFields } from '../graph/xrayProjection';
import { updateGraphNode } from '../graph/model';
import type { NativeProjection, RuleNode } from '../graph/types';
import { clearNodePosition } from '../graph/placement';
import { makeNode, uniqueOutboundTag } from '../graph/catalog';
import { observationSnapshot, outboundNeedsObservation } from '../graph/composites';
import { bindingsFor } from '../graph/defaults';
import { isOutboundKind } from '../graph/outbounds';
import type { GraphState, StashLink } from '../graph/types';
import type { StashEntry } from './import';
// Graph instances retain identity and tags while sharing their Stash configuration.
export function applyStashedProfile(
  graph: GraphState,
  entry: StashEntry,
  position: { x: number; y: number },
  replaceId?: string,
  link?: StashLink,
): GraphState {
  if (!entry.profile)
    throw new Error(entry.problem || 'This configuration has no executable node yet.');
  const previous = replaceId ? graph.nodes.find((n) => n.id === replaceId) : undefined;
  if (replaceId && (!previous || !isOutboundKind(previous.data.kind)))
    throw new Error('Select a configured outbound node to replace.');
  if (!previous && graph.nodes.length >= 500)
    throw new Error(
      'The graph supports at most 500 nodes. Keep other configurations in the stash.',
    );
  const node = makeNode(entry.profile.kind, previous?.position ?? position, previous?.id);
  if (!previous) node.position = clearNodePosition(graph.nodes, position);
  node.selected = true;
  node.data.label = entry.name;
  const note = previous?.data.description ?? '';
  node.data.description =
    note === 'Fictional placeholder. Replace with a working VLESS profile before testing.'
      ? ''
      : note;
  node.data.settings = {
    ...node.data.settings,
    ...(entry.draft?.settings ?? entry.profile.settings),
  };
  if (link) node.data.stashLink = { groupId: link.groupId, entryId: link.entryId };
  if (entry.draft) node.data.description = entry.draft.description;
  const base = String(
    node.data.settings.tag || entry.profile.kind.replace('-outbound', ''),
  ).replace(/^wayrill-(?:runtime|dns)-/, 'profile-');
  node.data.settings.tag = previous?.data.settings.tag ?? uniqueOutboundTag(base, graph.nodes);
  if (entry.draft?.native) node.data.native = nativeForInstance(entry.draft.native, previous, node);
  node.data.overrides = entry.draft?.overrides
    ? [...entry.draft.overrides]
    : bindingsFor(node.data.kind)
        .filter((b) => Object.hasOwn(entry.profile!.settings, b.nodeKey))
        .map((b) => b.nodeKey);

  let nodes = previous
    ? graph.nodes.map((n) => (n.id === previous.id ? node : { ...n, selected: false }))
    : [...graph.nodes.map((n) => ({ ...n, selected: false })), node];
  const needsObservation = outboundNeedsObservation({ ...graph, nodes }, node);
  const previousObservation =
    previous &&
    graph.edges.find((e) => e.source === previous.id && e.sourceHandle === 'observation');
  const edges = graph.edges
    .filter((e) => !previous || e.source !== previous.id)
    .map((e) => ({ ...e, selected: false }));
  if (needsObservation || (previousObservation && node.data.kind !== 'block-outbound')) {
    let observer =
      graph.nodes.find(
        (n) => n.id === previousObservation?.target && n.data.kind === 'observatory',
      ) ?? graph.nodes.find((n) => n.data.kind === 'observatory');
    if (!observer) {
      observer = makeNode(
        'observatory',
        clearNodePosition(nodes, { x: node.position.x + 360, y: node.position.y + 240 }),
      );
      const settings = observationSnapshot(node.data);
      if (settings) observer.data.settings = settings;
      nodes = [...nodes, observer];
    }
    edges.push({
      id: previousObservation?.id ?? crypto.randomUUID(),
      source: node.id,
      sourceHandle: 'observation',
      target: observer.id,
      targetHandle: 'in',
      selected: false,
    });
  }
  if (nodes.length > 500)
    throw new Error('The graph supports at most 500 nodes, including the shared observatory.');
  const xray = graph.xray && {
    ...graph.xray,
    outboundOrder:
      node.data.kind === 'policy-group'
        ? graph.xray.outboundOrder.filter((id) => id !== node.id)
        : graph.xray.outboundOrder.includes(node.id)
          ? graph.xray.outboundOrder
          : [...graph.xray.outboundOrder, node.id],
    balancerOrder:
      node.data.kind === 'policy-group'
        ? graph.xray.balancerOrder.includes(node.id)
          ? graph.xray.balancerOrder
          : [...graph.xray.balancerOrder, node.id]
        : graph.xray.balancerOrder.filter((id) => id !== node.id),
  };
  return { ...graph, nodes, edges, ...(xray ? { xray } : {}) };
}

/** Preserve a native import's per-instance rename baseline and unknown fields. */
export function nativeForInstance(
  native: NativeProjection,
  previous: RuleNode | undefined,
  node: RuleNode,
): NativeProjection {
  const baseline = previous?.data.native?.original.tag ?? node.data.settings.tag;
  return {
    ...structuredClone(native),
    original: forceProjectionFields(native.original, { tag: baseline }, ['/tag']),
    projection: forceProjectionFields(native.projection, { tag: baseline }, ['/tag']),
  };
}
/** Update a valid shared definition, including observation, without selecting it. */
export function applyStashedEntry(
  graph: GraphState,
  entry: StashEntry,
  node: RuleNode,
  link: StashLink,
): GraphState {
  if (entry.profile) {
    const next = applyStashedProfile(graph, entry, node.position, node.id, link);
    return {
      ...next,
      nodes: next.nodes.map((n) => ({
        ...n,
        selected: graph.nodes.find((old) => old.id === n.id)?.selected,
      })),
      edges: next.edges.map((e) => ({
        ...e,
        selected: graph.edges.find((old) => old.id === e.id)?.selected,
      })),
    };
  }
  if (!entry.draft || entry.draft.kind !== node.data.kind) return graph;
  const data = {
    ...node.data,
    label: entry.name,
    description: entry.draft.description,
    settings: { ...entry.draft.settings, tag: node.data.settings.tag },
    overrides: [...(entry.draft.overrides ?? [])],
  };
  if (entry.draft.native) data.native = nativeForInstance(entry.draft.native, node, node);
  else delete data.native;
  return updateGraphNode(graph, node.id, data);
}
