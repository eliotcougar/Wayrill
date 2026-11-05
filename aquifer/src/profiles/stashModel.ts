import type { Stash, StashEntry, StashGroup, ProfileKind } from './import';
import type { RuleNodeData, StashLink } from '../graph/types';

export const DEFAULT_GROUP_ID = 'wayrill:default';
export const entryKind = (entry: StashEntry): ProfileKind | undefined =>
  entry.draft?.kind ?? entry.profile?.kind;
export const entryIsPrepared = (entry: StashEntry) =>
  ['policy-group', 'proxy-chain'].includes(entryKind(entry) ?? '');
export function defaultGroup(): StashGroup {
  return {
    id: DEFAULT_GROUP_ID,
    name: 'Default',
    url: '',
    userAgent: '',
    headers: {},
    allowHttp: false,
    updatedAt: null,
    entries: [],
  };
}
type StashRow = { group: StashGroup; entry: StashEntry; link: StashLink };
// Synchronization alternates between before/after snapshots. Keep those two
// indexes without retaining another full index for every Undo revision.
const indexes = new Map<
  Stash,
  { rows: StashRow[]; byLink: Map<string, StashEntry>; byEntry: Map<StashEntry, StashLink> }
>();
const key = (link: StashLink) => JSON.stringify([link.groupId, link.entryId]);
function index(stash: Stash) {
  let cached = indexes.get(stash);
  if (!cached) {
    const rows = stash.groups.flatMap((group) =>
      group.entries.map((entry) => ({
        group,
        entry,
        link: { groupId: group.id, entryId: entry.id },
      })),
    );
    cached = {
      rows,
      byLink: new Map(rows.map((r) => [key(r.link), r.entry])),
      byEntry: new Map(rows.map((r) => [r.entry, r.link])),
    };
  }
  indexes.delete(stash);
  indexes.set(stash, cached);
  if (indexes.size > 2) {
    const oldest = indexes.keys().next().value;
    if (oldest) indexes.delete(oldest);
  }
  return cached;
}
export function stashRows(stash: Stash, kind?: 'policy-group' | 'proxy-chain'): StashRow[] {
  return index(stash).rows.filter((row) =>
    kind ? entryKind(row.entry) === kind : !entryIsPrepared(row.entry),
  );
}
export function findStashEntry(stash: Stash, link: StashLink): StashEntry | undefined {
  return index(stash).byLink.get(key(link));
}
export function entryLink(stash: Stash, entry: StashEntry): StashLink {
  const link = index(stash).byEntry.get(entry);
  if (!link) throw new Error('This Stash entry changed or disappeared. Select it again.');
  return link;
}
export function putStashEntry(
  stash: Stash,
  entry: StashEntry,
  link?: StashLink,
  expected?: StashEntry,
): Stash {
  const groupId = link?.groupId ?? DEFAULT_GROUP_ID;
  const group = stash.groups.find((g) => g.id === groupId);
  if (link && (!group || !group.entries.some((e) => e.id === link.entryId)))
    throw new Error('This Stash entry no longer exists. Reopen it before saving.');
  if (expected && findStashEntry(stash, link!) !== expected)
    throw new Error('This Stash entry changed while editing. Reopen it before saving.');
  const previous = link ? findStashEntry(stash, link) : undefined;
  const next = {
    ...entry,
    ...(previous
      ? {
          locked: previous.locked,
          manual: previous.manual,
          sourceName: previous.sourceName ?? previous.name,
          sourceProtocol: previous.sourceProtocol ?? previous.protocol,
        }
      : { manual: true }),
  };
  const target = group ?? defaultGroup();
  const updated = {
    ...target,
    entries: previous
      ? target.entries.map((e) => (e.id === link!.entryId ? next : e))
      : [...target.entries, next],
  };
  return {
    ...stash,
    groups: group
      ? stash.groups.map((g) => (g === group ? updated : g))
      : [...stash.groups, updated],
  };
}
export function removeStashEntries(stash: Stash, links: StashLink[]): Stash {
  const byGroup = new Map<string, Set<string>>();
  for (const link of links) {
    const ids = byGroup.get(link.groupId) ?? new Set<string>();
    ids.add(link.entryId);
    byGroup.set(link.groupId, ids);
  }
  let changed = false;
  const groups = stash.groups.map((group) => {
    const ids = byGroup.get(group.id);
    if (!ids || !group.entries.some((e) => ids.has(e.id))) return group;
    changed = true;
    return { ...group, entries: group.entries.filter((e) => !ids.has(e.id)) };
  });
  return changed ? { ...stash, groups } : stash;
}
export function lockStashEntry(stash: Stash, link: StashLink): Stash {
  const entry = findStashEntry(stash, link);
  if (!entry) throw new Error('This Stash entry no longer exists.');
  return {
    ...stash,
    groups: stash.groups.map((g) =>
      g.id !== link.groupId
        ? g
        : {
            ...g,
            entries: g.entries.map((e) =>
              e.id === link.entryId ? { ...e, locked: !e.locked } : e,
            ),
          },
    ),
  };
}
export type StashDraft = Pick<RuleNodeData, 'settings' | 'overrides' | 'description' | 'native'> & {
  kind: ProfileKind;
};
