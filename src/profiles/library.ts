import type { StashEntry, StashGroup } from './import';
import { searchText } from '../text';
import { entryAvailable } from './subscriptionState';

export interface LibraryRow {
  group: StashGroup;
  entry: StashEntry;
  search: string;
}
let indexes = new Map<StashGroup, LibraryRow[]>();
export const libraryTerm = searchText;
// Group objects are immutable stash snapshots. A refresh creates a new group;
// unchanged groups keep their row objects and normalized search text.
export function libraryRows(groups: StashGroup[]): LibraryRow[] {
  const next = new Map<StashGroup, LibraryRow[]>();
  const result = groups.flatMap((group) => {
    let rows = indexes.get(group);
    if (!rows) {
      rows = group.entries.map((entry) => ({
        group,
        entry,
        search: searchText(`${entry.name} ${entry.protocol} ${entry.address} ${group.name}`),
      }));
    }
    next.set(group, rows);
    return rows;
  });
  indexes = next;
  return result;
}
export function searchLibrary(rows: LibraryRow[], query: string, groupId = '', usableOnly = false) {
  const term = libraryTerm(query);
  return rows.filter(
    (row) =>
      (!groupId || row.group.id === groupId) &&
      (!usableOnly || entryAvailable(row.entry)) &&
      (!term || row.search.includes(term)),
  );
}
/** Health timestamps, locks and schedules do not invalidate an existing connectivity result. */
export function sameTestLibrary(before: StashGroup[], after: StashGroup[]) {
  return (
    before === after ||
    (before.length === after.length &&
      before.every((group, i) => {
        const next = after[i];
        return (
          group === next ||
          (group.id === next.id &&
            group.entries.length === next.entries.length &&
            group.entries.every((entry, j) => {
              const candidate = next.entries[j];
              return (
                entry === candidate ||
                (entry.id === candidate.id &&
                  entry.name === candidate.name &&
                  entry.profile === candidate.profile &&
                  entry.draft === candidate.draft)
              );
            }))
        );
      }))
  );
}
