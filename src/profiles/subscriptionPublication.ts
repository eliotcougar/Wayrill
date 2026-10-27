import { encodeStashGroup, decodeStashGroups } from './stashEncoding';
import { policyProfileId } from '../graph/profileIdentity';
import type { Stash, StashEntry, StashGroup } from './import';

interface Publication {
  group: StashGroup;
  /** Absent for a complete source load; present for an availability delta. */
  availability?: string[];
}
export function readPublication(text: string): Publication {
  const value = JSON.parse(text) as Publication;
  decodeStashGroups([value.group]);
  return value;
}
function encode({ group, availability }: Publication) {
  return JSON.stringify({ group: JSON.parse(encodeStashGroup(group)) as unknown, availability });
}
const sameConnection = (a?: StashEntry, b?: StashEntry) =>
  !!a?.profile && !!b?.profile && policyProfileId(a.profile) === policyProfileId(b.profile);

/** Completed loads replace definitions. Health publishes only exact-identity
 * availability deltas, independently of the editable library and later retries.
 */
export function preparePublications(
  before: Stash,
  after: Stash,
  changed: ReadonlySet<string>,
  operation: string,
  groupId?: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const oldGroups = new Map(before.groups.map((group) => [group.id, group]));
  const result = new Map<string, string>();
  for (const group of after.groups) {
    const old = oldGroups.get(group.id);
    if (
      (operation === 'refresh' && group.id === groupId) ||
      (old && group.updatedAt !== old.updatedAt)
    ) {
      result.set(group.id, encode({ group }));
      continue;
    }
    if (!old || !changed.has(group.id) || (operation === 'health' && group.id !== groupId))
      continue;
    const oldEntries = new Map(old.entries.map((entry) => [entry.id, entry]));
    const entries = new Map(group.entries.map((entry) => [entry.id, entry]));
    const ids = new Set(
      group.entries
        .filter((entry) => {
          const before = oldEntries.get(entry.id);
          return before && !!before.retained !== !!entry.retained && sameConnection(before, entry);
        })
        .map((entry) => entry.id),
    );
    if (operation === 'health')
      for (const entry of old.entries) if (!entries.has(entry.id)) ids.add(entry.id);
    if (!ids.size) continue;
    const pending = Object.hasOwn(previous, group.id)
      ? readPublication(previous[group.id])
      : undefined;
    if (pending && !pending.availability) {
      // A health batch may finish before its source load reaches routing. Apply
      // its delta to that approved source, never to unrelated newer drafts.
      const updated = pending.group.entries.flatMap((entry) => {
        if (!ids.has(entry.id)) return [entry];
        const current = entries.get(entry.id);
        if (!current) return sameConnection(entry, oldEntries.get(entry.id)) ? [] : [entry];
        return sameConnection(entry, current)
          ? [{ ...entry, health: current.health, retained: current.retained }]
          : [entry];
      });
      result.set(group.id, encode({ group: { ...pending.group, entries: updated } }));
    } else {
      const updates = new Map(pending?.group.entries.map((entry) => [entry.id, entry]));
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry) updates.set(id, entry);
        else {
          // A deletion still carries the failed connection identity. Without
          // this tombstone it could disable a different applied snapshot.
          const removed = oldEntries.get(id);
          if (removed) updates.set(id, { ...removed, retained: true });
        }
      }
      result.set(
        group.id,
        encode({
          group: { ...group, entries: [...updates.values()] },
          availability: [...new Set([...(pending?.availability ?? []), ...ids])],
        }),
      );
    }
  }
  return Object.fromEntries(result);
}
