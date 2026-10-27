import { readPolicySources, type PolicyReference } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import { policyProfileId } from '../graph/profileIdentity';
import type { GraphState, StashLink } from '../graph/types';
import type { Profile, Stash } from './import';

/** Give older explicit snapshots an unambiguous source before reconciliation changes their settings. */
export function bindSubscriptionLinks(
  stash: Stash,
  graph?: GraphState,
  sourceGroupId?: string,
): { stash: Stash; graph?: GraphState } {
  if (!sourceGroupId) return { stash, graph };
  const identities = new Map<string, StashLink | null>();
  for (const group of stash.groups)
    if (group.id === sourceGroupId)
      for (const entry of group.entries) {
        if (!entry.profile) continue;
        const key = policyProfileId(entry.profile);
        identities.set(key, identities.has(key) ? null : { groupId: group.id, entryId: entry.id });
      }
  const reference = (ref: PolicyReference, depth: number): PolicyReference => {
    if (ref.type !== 'profile') return ref;
    if (policyProfileId(ref.profile) !== ref.id) return ref;
    const source = ref.source ?? identities.get(ref.id);
    const next = profile(ref.profile, depth);
    return next === ref.profile && (!source || ref.source)
      ? ref
      : { ...ref, ...(source ? { source } : {}), profile: next, id: policyProfileId(next) };
  };
  const profile = (value: Profile, depth = 0): Profile => {
    if (depth >= 16) return value;
    const data = { ...value, label: '', description: '' };
    try {
      if (value.kind === 'policy-group') {
        const sources = readPolicySources(data);
        const manual = sources.manual.map((r) => reference(r, depth + 1));
        const fallback = sources.fallback && reference(sources.fallback, depth + 1);
        if (manual.every((r, i) => r === sources.manual[i]) && fallback === sources.fallback)
          return value;
        return {
          ...value,
          settings: {
            ...value.settings,
            sources: JSON.stringify({ ...sources, manual, ...(fallback ? { fallback } : {}) }),
          },
        };
      }
      if (value.kind === 'proxy-chain') {
        const chain = readProxyChain(data);
        const steps = chain.steps.map((s) => ({
          ...s,
          outbound: reference(s.outbound, depth + 1),
        }));
        if (steps.every((s, i) => s.outbound === chain.steps[i].outbound)) return value;
        return {
          ...value,
          settings: { ...value.settings, steps: JSON.stringify({ ...chain, steps }) },
        };
      }
    } catch {
      /* Preserve invalid drafts for their existing diagnostics. */
    }
    return value;
  };
  let changed = false;
  const groups = stash.groups.map((group) => {
    let groupChanged = false;
    const entries = group.entries.map((entry) => {
      if (entry.locked || !entry.profile) return entry;
      const next = profile(entry.profile);
      if (next === entry.profile) return entry;
      groupChanged = changed = true;
      return {
        ...entry,
        profile: next,
        ...(entry.draft ? { draft: { ...entry.draft, settings: next.settings } } : {}),
      };
    });
    return groupChanged ? { ...group, entries } : group;
  });
  let graphChanged = false;
  const nodes = graph?.nodes.map((node) => {
    const next = profile(node.data as Profile);
    if (next === node.data) return node;
    graphChanged = true;
    return { ...node, data: { ...node.data, settings: next.settings } };
  });
  return {
    stash: changed ? { ...stash, groups } : stash,
    graph: graph && graphChanged ? { ...graph, nodes: nodes! } : graph,
  };
}
