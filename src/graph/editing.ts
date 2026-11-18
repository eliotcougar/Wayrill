import { readPolicySources, type PolicyReference } from './policySources';
import { readProxyChain } from './proxyChains';
import { uniqueInboundTag, uniqueOutboundTag } from './catalog';
import { isInboundKind, inboundPreview } from './inbounds';
import { isExecutableOutboundKind, isOutboundKind, outboundPreview } from './outbounds';
import { isProtocolKind, protocolPreview } from './protocols';
import { nativeConfig } from './xrayNodes';
import { xrayInboundConfig, xrayOutboundConfig } from './xrayCompiler';
import { forceProjectionFields } from './xrayProjection';
import type { GraphState, RuleNode } from './types';
import { nodeTag, ensureNodeTags } from './tags';
import { remapNodeTagReferences } from './tagRemap';

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
  let selected = graph.nodes.filter((node) => node.selected && canDuplicateNode(node, graph));
  if (!selected.length) return graph;
  if (graph.nodes.length + selected.length > MAX_GRAPH_NODES) {
    throw new Error(
      `The graph supports at most ${MAX_GRAPH_NODES} nodes. Keep other configurations in the stash.`,
    );
  }
  graph = ensureNodeTags(graph);
  selected = selected.map((node) => graph.nodes.find((candidate) => candidate.id === node.id)!);
  const mapping = new Map(selected.map((node) => [node.id, crypto.randomUUID()]));
  const remap = (ref: PolicyReference): PolicyReference =>
    ref.type === 'node' ? { ...ref, nodeId: mapping.get(ref.nodeId) ?? ref.nodeId } : ref;
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
    if (isOutboundKind(kind)) {
      copy.data.settings.tag = uniqueOutboundTag(nodeTag(copy.data, copy.id), [
        ...graph.nodes,
        ...copies,
      ]);
    }
    if (isInboundKind(kind) || kind === 'xray-inbound') {
      copy.data.settings.tag = uniqueInboundTag(nodeTag(copy.data, copy.id), [
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
      sources.manual = sources.manual.map(remap);
      if (sources.fallback) sources.fallback = remap(sources.fallback);
      copy.data.settings.sources = JSON.stringify(sources);
    } else if (kind === 'proxy-chain') {
      const chain = readProxyChain(copy.data);
      chain.steps = chain.steps.map((step) => ({ ...step, outbound: remap(step.outbound) }));
      copy.data.settings.steps = JSON.stringify(chain);
    }
    copies.push(copy);
  }
  const inboundTags = new Map<string, string>(),
    outboundTags = new Map<string, string>(),
    balancerTags = new Map<string, string>();
  selected.forEach((node, index) => {
    const tag = node.data.settings.tag;
    if (typeof tag !== 'string' || !tag) return;
    const target =
      isInboundKind(node.data.kind) || node.data.kind === 'xray-inbound'
        ? inboundTags
        : node.data.kind === 'policy-group'
          ? balancerTags
          : outboundTags;
    target.set(tag, String(copies[index].data.settings.tag));
  });
  for (const copy of copies)
    remapNodeTagReferences(copy.data, inboundTags, outboundTags, balancerTags);
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
