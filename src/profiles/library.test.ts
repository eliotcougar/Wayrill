import { describe, expect, it } from 'vitest';
import { libraryRows, searchLibrary } from './library';
import { importProfiles, mergeImport, refreshSummary, type Stash } from './import';
const empty = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,

  groups: [],
});
const importList = (lines: string[]) => importProfiles(lines.join('\n'), 'Public subscription');
const link = (host: string, name: string) =>
  `vless://public-id@${host}.example.net:443?security=tls#${encodeURIComponent(name)}`;
describe('large library search', () => {
  it('searches 50,000 entries across groups without losing unsupported rows or row identity', () => {
    const original = importList([link('first', 'EU First')]).groups[0];
    const groups = [0, 1].map((n) => ({
      ...original,
      id: `group-${n}`,
      name: n ? 'Second source' : 'First source',
      entries: Array.from({ length: 25000 }, (_, i) => ({
        ...original.entries[0],
        id: `${n}-${i}`,
        name: `EU Node ${i}`,
        address: `server${i}.example.net`,
        profile: i % 100 === 0 ? null : original.entries[0].profile,
      })),
    }));
    const rows = libraryRows(groups);
    expect(rows).toHaveLength(50000);
    expect(searchLibrary(rows, 'NODE 24999')).toHaveLength(2);
    expect(searchLibrary(rows, 'second source', 'group-1')).toHaveLength(25000);
    expect(searchLibrary(rows, '', 'group-0', true)).toHaveLength(24750);
    expect(libraryRows(groups)[49999]).toBe(rows[49999]);
    const refreshed = [groups[0], { ...groups[1], name: 'Renamed source' }];
    expect(libraryRows(refreshed)[0]).toBe(rows[0]);
    expect(searchLibrary(libraryRows(refreshed), 'renamed')).toHaveLength(25000);
  });
});
describe('subscription refresh continuity', () => {
  it('keeps identity through reordering, renaming, and a unique configuration update; scopes replacement', () => {
    const old = importList([link('a', 'EU A'), link('b', 'EU B'), link('gone', 'Removed')])
      .groups[0];
    const untouched = { ...old, id: 'untouched', name: 'Other group' };
    const stash: Stash = { ...empty(), groups: [old, untouched] };
    const incoming = importList([
      link('b', 'EU renamed'),
      link('changed', 'EU A'),
      link('new', 'New'),
    ]);
    const next = mergeImport(stash, incoming, old.id),
      after = next.groups[0];
    expect(after.entries.map((e) => e.id).slice(0, 2)).toEqual([
      old.entries[1].id,
      old.entries[0].id,
    ]);
    expect(next.groups[1]).toBe(untouched);
    expect(stash.groups[0]).toBe(old);
    expect(refreshSummary(old, after)).toEqual({
      added: 1,
      updated: 2,
      removed: 1,
      unchanged: 0,
      unsupported: 0,
    });
  });
  it('does not guess which repeated name was updated', () => {
    const old = importList([link('a', 'Same'), link('b', 'Same')]).groups[0];
    const next = mergeImport(
      { ...empty(), groups: [old] },
      importList([link('c', 'Same'), link('d', 'Same')]),
      old.id,
    );
    expect(refreshSummary(old, next.groups[0])).toMatchObject({ added: 2, updated: 0, removed: 2 });
  });
});
