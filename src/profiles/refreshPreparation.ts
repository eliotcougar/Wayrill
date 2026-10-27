import {
  importProfiles,
  mergeImport,
  refreshSummary,
  serializedStashGroups,
  type ImportResult,
  type Stash,
  type StashEntry,
  type StashGroup,
} from './import';
import { syncStashEdits } from './workspace';
import {
  refreshPolicyGraph,
  refreshStashComposites,
  type PolicyRefreshPatch,
} from '../graph/policySources';
import type { GraphState } from '../graph/types';
import { protectedSubscriptionEntries } from './subscriptionReferences';
import { bindSubscriptionLinks } from './subscriptionLinks';

export interface RefreshRequest {
  text: string;
  name: string;
  stash: Stash;
  replaceId?: string;
  protectedEntries?: string[];
  graph?: GraphState;
}
type GroupDelta = number | { group: Omit<StashGroup, 'entries'>; entries: (number | StashEntry)[] };
export function prepareRefresh(
  request: RefreshRequest,
  result: ImportResult = importProfiles(request.text, request.name),
) {
  const { stash, graph, replaceId } = request;
  const bound = bindSubscriptionLinks(stash, graph, replaceId);
  const next = refreshStashComposites(
    mergeImport(
      bound.stash,
      result,
      replaceId,
      new Set([
        ...protectedSubscriptionEntries(bound.stash, bound.graph),
        ...(request.protectedEntries ?? []),
      ]),
    ),
  );
  const groups: GroupDelta[] = next.groups.map((group) => {
    const index = stash.groups.indexOf(group);
    if (index >= 0) return index;
    const previous = stash.groups.find((g) => g.id === group.id);
    const old = new Map(previous?.entries.map((e, i) => [e, i]));
    const { entries, ...metadata } = group;
    return { group: metadata, entries: entries.map((e) => old.get(e) ?? e) };
  });
  const patches: PolicyRefreshPatch[] = [];
  if (graph) {
    const linked = syncStashEdits(bound.graph!, stash, next);
    const refreshed = refreshPolicyGraph(linked, next);
    linked.nodes.forEach((node, index) => {
      const field =
        node.data.kind === 'policy-group'
          ? 'sources'
          : node.data.kind === 'proxy-chain'
            ? 'steps'
            : undefined;
      if (field)
        patches.push({
          id: node.id,
          kind: node.data.kind,
          field,
          before: String(graph.nodes[index].data.settings[field] ?? ''),
          after: String(refreshed.nodes[index].data.settings[field] ?? ''),
        });
    });
  }
  const before = stash.groups.find((g) => g.id === replaceId);
  const after = next.groups.find((g) => g.id === replaceId);
  return {
    groups,
    serialization: serializedStashGroups(next),
    patches,
    summary: before && after ? refreshSummary(before, after) : undefined,
    ready: result.groups.reduce((n, g) => n + g.entries.filter((e) => e.profile).length, 0),
    retained: result.groups.reduce((n, g) => n + g.entries.filter((e) => !e.profile).length, 0),
    duplicates: result.duplicates,
    rejected: result.rejected,
    problems: result.problems,
  };
}
export type PreparedRefresh = ReturnType<typeof prepareRefresh>;
export function materializeRefresh(before: Stash, prepared: PreparedRefresh): Stash {
  return {
    ...before,
    groups: prepared.groups.map((delta) => {
      if (typeof delta === 'number') return before.groups[delta];
      const old = before.groups.find((g) => g.id === delta.group.id);
      return {
        ...delta.group,
        entries: delta.entries.map((e) => (typeof e === 'number' ? old!.entries[e] : e)),
      };
    }),
  };
}
