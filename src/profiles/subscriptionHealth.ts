import { policyProfileId } from '../graph/profileIdentity';
import { protectedSubscriptionEntries, stashLinkKey } from './subscriptionReferences';
import type { HealthObservation } from './subscriptionState';
import type { GraphState } from '../graph/types';
import type { Stash } from './import';
import { reusePolicyMembership } from '../graph/policySources';

/** Results are conditional on exact connection identity, not a name or a row index. */
export function applySubscriptionHealth(
  stash: Stash,
  graph: GraphState,
  groupId: string,
  observations: HealthObservation[],
  removeDead: boolean,
): Stash {
  const updates = new Map(observations.map((r) => [r.entryId, r.health]));
  const protectedIds = removeDead ? protectedSubscriptionEntries(stash, graph) : new Set<string>();
  let changed = false;
  const groups = stash.groups.map((group) => {
    if (group.id !== groupId) return group;
    let membershipChanged = false;
    const entries = group.entries.flatMap((entry) => {
      const health = updates.get(entry.id);
      if (!health || !entry.profile || policyProfileId(entry.profile) !== health.profileId)
        return [entry];
      changed = true;
      if (
        removeDead &&
        health.status === 'dead' &&
        !entry.locked &&
        !entry.manual &&
        !protectedIds.has(stashLinkKey({ groupId, entryId: entry.id }))
      ) {
        membershipChanged = true;
        return [];
      }
      return [{ ...entry, health }];
    });
    if (!changed) return group;
    const next = { ...group, entries };
    if (!membershipChanged) reusePolicyMembership(group, next);
    return next;
  });
  return changed ? { ...stash, groups } : stash;
}
