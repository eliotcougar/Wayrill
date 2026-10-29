import { expect, it } from 'vitest';
import { mergeStashDocuments, confirmStashSave } from './stashMerge';
import { importProfiles, parseStash, serializeStash, type Stash } from './import';

const example = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: importProfiles('socks://192.0.2.1:1080#Example').groups,
});
const merge = (base: Stash, local: Stash, remote: Stash) =>
  parseStash(
    mergeStashDocuments(serializeStash(base), serializeStash(local), serializeStash(remote)),
  );
it('retains provider changes while saving an independent group rename', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].name = 'My provider';
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  const result = merge(base, local, remote);
  expect(result.groups[0].name).toBe('My provider');
  expect(result.groups[0].entries[0].profile!.settings.port).toBe(2080);
});
it('rejects conflicting connection edits without overwriting either document', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].profile!.settings.port = 2080;
  remote.groups[0].entries[0].profile!.settings.port = 3080;
  expect(() => merge(base, local, remote)).toThrow(/same subscription item changed/);
  expect(remote.groups[0].entries[0].profile!.settings.port).toBe(3080);
});
it('does not resurrect a concurrently deleted entry', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].name = 'Renamed';
  remote.groups[0].entries = [];
  expect(merge(base, local, remote).groups[0].entries).toHaveLength(0);
});
it('protects a concurrently locked connection and keeps the provider update as a copy', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].locked = true;
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  const entries = merge(base, local, remote).groups[0].entries;
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ id: base.groups[0].entries[0].id, locked: true });
  expect(entries[0].profile!.settings.port).toBe(1080);
  expect(entries[1]).toMatchObject({ locked: false, sourceCopyOf: entries[0].id });
  expect(entries[1].id).not.toBe(entries[0].id);
  expect(entries[1].profile!.settings.port).toBe(2080);
});

it('confirms a lost save reply despite independent provider updates, rejecting true conflicts', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].name = 'Mine';
  remote.groups[0].entries.push({ ...remote.groups[0].entries[0], id: 'new-server' });
  const text = (value: Stash) => serializeStash(value);
  expect(confirmStashSave(text(base), text(local), text(remote))).toBe('not-applied');
  remote.groups[0].name = 'Mine';
  expect(confirmStashSave(text(base), text(local), text(remote))).toBe('applied');
  remote.groups[0].name = 'Another edit';
  expect(confirmStashSave(text(base), text(local), text(remote))).toBe('conflict');
});
