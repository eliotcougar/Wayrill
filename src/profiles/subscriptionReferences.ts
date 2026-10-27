import { readPolicySources, type PolicyReference } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import { policyProfileId } from '../graph/profileIdentity';
import type { GraphState, StashLink } from '../graph/types';
import type { Profile, Stash } from './import';

export const stashLinkKey = (link: StashLink) => JSON.stringify([link.groupId, link.entryId]);
/** Dynamic subscription pools are intentionally not pins. Explicit members, hops and fallbacks are. */
export function protectedSubscriptionEntries(stash: Stash, graph?: GraphState): Set<string> {
  const protectedIds = new Set<string>();
  const identities = new Map<string, StashLink[]>();
  let indexed = false;
  const legacyLinks = (id: string) => {
    if (!indexed) {
      indexed = true;
      for (const group of stash.groups)
        for (const entry of group.entries) {
          if (!entry.profile) continue;
          const identity = policyProfileId(entry.profile);
          const links = identities.get(identity) ?? [];
          links.push({ groupId: group.id, entryId: entry.id });
          identities.set(identity, links);
        }
    }
    return identities.get(id) ?? [];
  };
  const seen = new Set<Profile>();
  const reference = (ref: PolicyReference, depth: number) => {
    if (ref.type !== 'profile') return;
    if (ref.source) protectedIds.add(stashLinkKey(ref.source));
    else for (const link of legacyLinks(ref.id)) protectedIds.add(stashLinkKey(link));
    visit(ref.profile, depth);
  };
  const visit = (profile: Profile, depth = 0) => {
    if (seen.has(profile) || depth >= 16) return;
    seen.add(profile);
    const data = { ...profile, label: '', description: '' };
    try {
      if (profile.kind === 'policy-group') {
        const sources = readPolicySources(data);
        for (const ref of sources.manual) reference(ref, depth + 1);
        if (sources.fallback) reference(sources.fallback, depth + 1);
      } else if (profile.kind === 'proxy-chain') {
        for (const step of readProxyChain(data).steps) reference(step.outbound, depth + 1);
      }
    } catch {
      /* Unfinished definitions are not rewritten. */
    }
  };
  for (const group of stash.groups)
    for (const entry of group.entries) {
      if (entry.profile) visit(entry.profile);
    }
  for (const node of graph?.nodes ?? []) {
    if (node.data.stashLink) protectedIds.add(stashLinkKey(node.data.stashLink));
    visit(node.data as Profile);
  }
  return protectedIds;
}
