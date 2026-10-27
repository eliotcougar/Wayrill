import { syncStashEdits } from './workspace';
import { refreshPolicyGraph } from '../graph/policySources';
import { resolveGraph } from '../graph/defaults';
import { syncXrayConnections } from '../graph/xrayCompiler';
import type { GraphState } from '../graph/types';
import type { Stash } from './import';

/** Refresh the applied graph, never the user's unrelated canvas draft. */
export function refreshAppliedSubscriptions(
  graph: GraphState,
  stash: Stash,
  scope?: ReadonlySet<string>,
  availability?: ReadonlySet<string>,
): GraphState {
  if (scope?.size === 0) return graph;
  const refreshed = refreshPolicyGraph(
    availability ? graph : syncStashEdits(graph, undefined, stash, scope),
    stash,
    scope,
    availability,
  );
  return refreshed === graph ? graph : syncXrayConnections(resolveGraph(refreshed));
}
