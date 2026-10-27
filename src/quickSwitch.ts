import { isOutboundKind } from './graph/outbounds';
import type { GraphState, StashLink } from './graph/types';
import type { Stash } from './profiles/import';
import { entryAvailable } from './profiles/subscriptionState';

export function mainOutbound(graph: GraphState) {
  return graph.nodes.find(
    (node) => node.id === graph.mainOutboundId && isOutboundKind(node.data.kind),
  );
}

export function setMainOutbound(graph: GraphState, nodeId?: string): GraphState {
  if (nodeId && !graph.nodes.some((node) => node.id === nodeId && isOutboundKind(node.data.kind)))
    throw new Error('Choose an outbound, policy group or proxy chain as Main.');
  const next = { ...graph };
  if (nodeId) next.mainOutboundId = nodeId;
  else delete next.mainOutboundId;
  return next;
}

export function normalizeMainOutbound(graph: GraphState): GraphState {
  return graph.mainOutboundId && !mainOutbound(graph) ? setMainOutbound(graph) : graph;
}

export interface StarredChoice extends StashLink {
  label: string;
  available: boolean;
}

export function starredChoices(stash: Stash): StarredChoice[] {
  return stash.groups.flatMap((group) =>
    group.entries
      .filter((entry) => entry.starred)
      .map((entry) => ({
        groupId: group.id,
        entryId: entry.id,
        label: `${entry.name} · ${group.name}`,
        available: entryAvailable(entry),
      })),
  );
}
