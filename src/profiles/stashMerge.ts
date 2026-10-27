import { parseStash, serializeStash, type Stash, type ImportResult } from './import';
import { policyProfileId } from '../graph/profileIdentity';
import { maintenanceDefaults } from './subscriptionState';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Apply local edits to the latest library, retaining concurrent maintenance.
 * IDs, rather than array positions, identify groups and entries. Conflicting
 * edits are never resolved by replacing an entire stale library.
 */
function merge(base: unknown, local: unknown, remote: unknown, path: string): unknown {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;
  if (path.endsWith('.health') && local === undefined) return undefined;
  if (path.endsWith('.health') || path.endsWith('.lastTestAt') || path.endsWith('.testCycleAt'))
    return remote;
  if (record(base) && record(local) && record(remote)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
        .map((key) => [key, merge(base[key], local[key], remote[key], `${path}.${key}`)])
        .filter(([, value]) => value !== undefined),
    );
  }
  if (
    (path === 'stash.groups' || path.endsWith('.entries')) &&
    Array.isArray(base) &&
    Array.isArray(local) &&
    Array.isArray(remote)
  ) {
    const index = (rows: unknown[]) =>
      new Map(
        rows.map((row) => {
          if (!record(row) || typeof row.id !== 'string')
            throw new Error('Invalid library identity.');
          return [row.id, row] as const;
        }),
      );
    const [b, l, r] = [index(base), index(local), index(remote)];
    const unchangedOrder = same([...b.keys()], [...l.keys()]);
    const order = [
      ...new Set(unchangedOrder ? [...r.keys(), ...l.keys()] : [...l.keys(), ...r.keys()]),
    ];
    return order.flatMap((id) => {
      const original = b.get(id),
        edited = l.get(id),
        latest = r.get(id);
      // A lock clicked while maintenance was running must protect the version
      // the user saw, just as a lock saved before the refresh would.
      if (
        path.endsWith('.entries') &&
        original &&
        edited?.locked &&
        !original.locked &&
        !same(original.profile, latest?.profile)
      ) {
        return latest
          ? [
              edited,
              {
                ...latest,
                id: crypto.randomUUID(),
                sourceCopyOf: id,
                locked: false,
                starred: undefined,
              },
            ]
          : [edited];
      }
      const value = merge(b.get(id), l.get(id), r.get(id), `${path}[${id}]`);
      return value === undefined ? [] : [value];
    });
  }
  throw new Error(
    'The same subscription item changed in the service. Reload it before saving; your edits were preserved.',
  );
}

export function mergeStashDocuments(base: string, local: string, remote: string): string {
  if (local === base) return remote;
  if (remote === base || local === remote) return local;
  const original = parseStash(base),
    edited = parseStash(local);
  const merged = merge(original, edited, parseStash(remote), 'stash');
  const stash = parseStash(JSON.stringify(merged));
  const before = new Map(original.groups.map((group) => [group.id, group]));
  const changes = new Map(edited.groups.map((group) => [group.id, group]));
  for (const group of stash.groups) {
    const previous = before.get(group.id),
      changed = changes.get(group.id);
    // Turning removal off ends an unfinished scan while preserving diagnostic results.
    const stopScan =
      changed?.maintenance?.removeUnreachable === false &&
      (previous?.maintenance ?? maintenanceDefaults).removeUnreachable;
    if (stopScan) delete group.testCycleAt;
    for (const entry of group.entries)
      if (
        entry.health &&
        (!entry.profile || entry.health.profileId !== policyProfileId(entry.profile))
      )
        delete entry.health;
  }
  return serializeStash(stash);
}

/** Resolve a lost save reply using the same merge rules as the service. */
export function confirmStashSave(base: string, local: string, remote: string) {
  const current = serializeStash(parseStash(remote));
  if (current === serializeStash(parseStash(local))) return 'applied';
  try {
    if (mergeStashDocuments(base, local, current) === current) return 'applied';
    if (mergeStashDocuments(local, base, current) === current) return 'not-applied';
  } catch {
    // A changed authored field is a real conflict, not evidence of cancellation.
  }
  return 'conflict';
}

/** A save acknowledgement is not a new library edit or an Undo point. */
export function mergeLibraryUpdate(
  base: string,
  local: Stash,
  remote: string,
): ImportResult | null {
  const authored = serializeStash(local);
  const merged = mergeStashDocuments(base, authored, remote);
  if (merged === authored) return null;
  return { ...parseStash(merged), duplicates: 0, rejected: 0, problems: [] };
}
