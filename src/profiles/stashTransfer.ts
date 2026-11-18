import { mergeImport, type Profile, type Stash } from './import';
import {
  findStashEntry,
  putStashEntry,
  removeStashEntries,
  type StashEntryEdit,
} from './stashModel';
import type { StashEntry } from './import';
import { graphDependencies } from './workspaceDependencies';
import { refreshStashComposites } from '../graph/policySources';
import type { StashLink } from '../graph/types';

export function replaceStashServer(stash: Stash, target: StashEntryEdit, replacement: StashEntry) {
  return refreshStashComposites(
    putStashEntry(
      stash,
      {
        ...replacement,
        id: target.entry.id,
        name: target.entry.name,
      },
      target.link,
      target.entry,
    ),
    new Set([target.link.groupId]),
  );
}

export function selectedStashEntries(stash: Stash, links: readonly StashLink[]): Stash {
  const selected = new Map<string, Set<string>>();
  const profiles: Profile[] = [];
  for (const link of links) {
    const entry = findStashEntry(stash, link);
    if (!entry) throw new Error('A selected outbound was removed. Select it again.');
    const ids = selected.get(link.groupId) ?? new Set<string>();
    ids.add(link.entryId);
    selected.set(link.groupId, ids);
    if (entry.profile) profiles.push(entry.profile);
    if (entry.draft) profiles.push(entry.draft);
  }
  const dependencies = graphDependencies(
    { name: '', nodes: [], edges: [] },
    stash,
    new Set(),
    profiles,
  );
  for (const group of dependencies.groups) {
    const ids = selected.get(group.id) ?? new Set<string>();
    for (const entry of group.entries) ids.add(entry.id);
    selected.set(group.id, ids);
  }
  return {
    ...stash,
    groups: stash.groups
      .filter((group) => selected.has(group.id))
      .map((group) => ({
        ...group,
        entries: group.entries.filter((entry) => selected.get(group.id)!.has(entry.id)),
      })),
  };
}

export function transferStashEntries(
  target: Stash,
  source: Stash,
  links: StashLink[],
  move: boolean,
) {
  const selected = selectedStashEntries(source, links);
  const remaining = move ? removeStashEntries(source, links) : source;
  if (move) {
    const profiles = remaining.groups.flatMap((group) =>
      group.entries.flatMap((entry) =>
        [entry.profile, entry.draft].filter((value) => value != null),
      ),
    );
    const referenced = graphDependencies(
      { name: '', nodes: [], edges: [] },
      source,
      new Set(),
      profiles,
    );
    for (const link of links) {
      const entry = findStashEntry(referenced, link);
      if (entry)
        throw new Error(
          entry.name +
            ' is still used by a policy group or chain in the source Stash. Copy it instead.',
        );
    }
  }
  const stash = refreshStashComposites(
    mergeImport(target, {
      groups: selected.groups,
      duplicates: 0,
      rejected: 0,
      problems: [],
    }),
  );
  return { stash, source: remaining };
}
