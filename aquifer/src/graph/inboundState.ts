import { isInboundKind } from './inbounds';
import type { GraphState, RuleNodeData } from './types';

export const isGraphInbound = (kind: string) => isInboundKind(kind) || kind === 'xray-inbound';
export const isDisabledInbound = (data: RuleNodeData) =>
  isGraphInbound(data.kind) && data.enabled === false;

/** Execution-only projection. The saved canvas keeps every node and connection. */
export function enabledInboundGraph(graph: GraphState): GraphState {
  const disabled = new Set(graph.nodes.filter((n) => isDisabledInbound(n.data)).map((n) => n.id));
  if (!disabled.size) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !disabled.has(n.id)),
    edges: graph.edges.filter((e) => !disabled.has(e.source) && !disabled.has(e.target)),
  };
}
