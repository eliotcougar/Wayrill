import { readPolicySources } from './policySources';
import { uniqueInboundTag, uniqueOutboundTag } from './catalog';
import { isInboundKind, inboundPreview } from './inbounds';
import { isExecutableOutboundKind, outboundPreview } from './outbounds';
import { isProtocolKind, protocolPreview } from './protocols';
import { nativeConfig } from './xrayNodes';
import { xrayInboundConfig, xrayOutboundConfig } from './xrayCompiler';
import { forceProjectionFields } from './xrayProjection';
import type { GraphState, RuleNode } from './types';

export const MAX_GRAPH_NODES = 500;

// These nodes describe a global Xray section, rather than independent graph destinations.
export function canDuplicateNode(node: RuleNode, graph: GraphState): boolean {
  return (
    !['xray-options', 'xray-dns', 'dns-handler', 'observatory', 'ics-tun'].includes(
      node.data.kind,
    ) && !(graph.xray && node.id === graph.xray.routingNodeId)
  );
}

export function duplicateSelection(graph: GraphState): GraphState {
  const selected = graph.nodes.filter((node) => node.selected && canDuplicateNode(node, graph));
  if (!selected.length) return graph;
  if (graph.nodes.length + selected.length > MAX_GRAPH_NODES) {
    throw new Error(
      `The graph supports at most ${MAX_GRAPH_NODES} nodes. Keep other configurations in the stash.`,
    );
  }
  const mapping = new Map(selected.map((node) => [node.id, crypto.randomUUID()]));
  const copies: RuleNode[] = [];
  for (const node of selected) {
    const copy: RuleNode = {
      id: mapping.get(node.id)!,
      type: 'rule',
      selected: true,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      data: structuredClone(node.data),
    };
    delete copy.data.stashLink;
    const kind = copy.data.kind;
    if (isExecutableOutboundKind(kind) || kind === 'policy-group' || kind === 'xray-outbound') {
      copy.data.settings.tag = uniqueOutboundTag(String(copy.data.settings.tag || 'outbound'), [
        ...graph.nodes,
        ...copies,
      ]);
    }
    if (isInboundKind(kind) || kind === 'xray-inbound') {
      copy.data.settings.tag = uniqueInboundTag(String(copy.data.settings.tag || 'inbound'), [
        ...graph.nodes,
        ...copies,
      ]);
    }
    if (node.data.native) {
      // Rebase the snapshot to the edited configuration. Reusing the old tag baseline
      // would make the compiler treat this copy as a rename of the original destination.
      const original =
        isInboundKind(kind) || kind === 'xray-inbound'
          ? xrayInboundConfig(node.data)
          : isExecutableOutboundKind(kind) || kind === 'xray-outbound'
            ? xrayOutboundConfig(node.data)
            : node.data.native.original;
      copy.data.native!.original = forceProjectionFields(
        original,
        { tag: copy.data.settings.tag },
        ['/tag'],
      );
      if (isProtocolKind(kind)) copy.data.native!.projection = protocolPreview(copy.data);
      else if (kind === 'xray-inbound' || kind === 'xray-outbound')
        copy.data.native!.projection = nativeConfig(copy.data);
      else if (isInboundKind(kind)) copy.data.native!.projection = inboundPreview(copy.data);
      else if (isExecutableOutboundKind(kind))
        copy.data.native!.projection = outboundPreview(copy.data);
      else
        copy.data.native!.projection = forceProjectionFields(
          copy.data.native!.projection,
          { tag: copy.data.settings.tag },
          ['/tag'],
        );
    }
    if (kind === 'policy-group') {
      const sources = structuredClone(readPolicySources(copy.data));
      const remap = (ref: (typeof sources.manual)[number]) =>
        ref.type === 'node' ? { ...ref, nodeId: mapping.get(ref.nodeId) ?? ref.nodeId } : ref;
      sources.manual = sources.manual.map(remap);
      if (sources.fallback) sources.fallback = remap(sources.fallback);
      copy.data.settings.sources = JSON.stringify(sources);
    }
    copies.push(copy);
  }
  const connections = graph.edges
    .filter((edge) => mapping.has(edge.source) && mapping.has(edge.target))
    .map((edge) => ({
      ...structuredClone(edge),
      id: crypto.randomUUID(),
      source: mapping.get(edge.source)!,
      target: mapping.get(edge.target)!,
      selected: false,
    }));
  return {
    ...graph,
    nodes: [...graph.nodes.map((node) => ({ ...node, selected: false })), ...copies],
    edges: [...graph.edges.map((edge) => ({ ...edge, selected: false })), ...connections],
  };
}
