import { readPolicySources, type PolicyReference } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import type { GraphState } from '../graph/types';
import type { Profile, Stash } from './import';

/** Include referenced entries and complete dynamic subscription pools, not unrelated groups. */
export function graphDependencies(
  graph: GraphState,
  stash: Stash,
  wholeGroups = new Set<string>(),
  profiles: readonly Profile[] = [],
  onReference?: (groupId: string, entryId?: string) => void,
): Stash {
  const groups = new Map(stash.groups.map((g) => [g.id, g]));
  const selected = new Map<string, Set<string>>();
  const visited = new Set<Profile>();
  const entry = (groupId: string, entryId?: string) => {
    onReference?.(groupId, entryId);
    const group = groups.get(groupId);
    if (!group) return;
    if (entryId === undefined) wholeGroups.add(groupId);
    const ids = selected.get(groupId) ?? new Set<string>();
    selected.set(groupId, ids);
    for (const row of group.entries) {
      if ((entryId !== undefined && row.id !== entryId) || ids.has(row.id)) continue;
      ids.add(row.id);
      if (row.profile) visit(row.profile);
      if (row.draft) visit({ kind: row.draft.kind, settings: row.draft.settings });
    }
  };
  const reference = (ref: PolicyReference, depth: number) => {
    if (ref.type !== 'profile') return;
    if (ref.source) entry(ref.source.groupId, ref.source.entryId);
    visit(ref.profile, depth);
  };
  const visit = (profile: Profile, depth = 0) => {
    if (visited.has(profile) || depth >= 16) return;
    visited.add(profile);
    const data = { ...profile, label: '', description: '' };
    if (profile.kind === 'policy-group') {
      const sources = readPolicySources(data);
      for (const ref of sources.manual) reference(ref, depth + 1);
      if (sources.fallback) reference(sources.fallback, depth + 1);
      for (const sub of sources.subscriptions) entry(sub.groupId);
    } else if (profile.kind === 'proxy-chain') {
      for (const step of readProxyChain(data).steps) reference(step.outbound, depth + 1);
    }
  };
  for (const group of [...wholeGroups]) entry(group);
  for (const profile of profiles) visit(profile);
  for (const node of graph.nodes) {
    if (node.data.stashLink) entry(node.data.stashLink.groupId, node.data.stashLink.entryId);
    visit(node.data as Profile);
  }
  return {
    ...stash,
    groups: stash.groups
      .filter((g) => selected.has(g.id))
      .map((g) => ({ ...g, entries: g.entries.filter((e) => selected.get(g.id)!.has(e.id)) })),
  };
}
