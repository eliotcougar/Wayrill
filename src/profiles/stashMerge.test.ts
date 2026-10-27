import { expect, it } from 'vitest';
import { mergeStashDocuments, confirmStashSave, mergeLibraryUpdate } from './stashMerge';
import { importProfiles, parseStash, serializeStash, type Stash } from './import';
import { policyProfileId } from '../graph/profileIdentity';
import { maintenanceDefaults, setGroupMaintenance, entryAvailable } from './subscriptionState';

const example = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: importProfiles('socks://192.0.2.1:1080#Example').groups,
});
it('treats identical service acknowledgements as no new library revision', () => {
  const local = example(),
    saved = serializeStash(local);
  expect(mergeLibraryUpdate(saved, local, saved)).toBeNull();
  const newer = structuredClone(local);
  newer.groups[0].name = 'Newer unsaved name';
  expect(mergeLibraryUpdate(saved, newer, saved)).toBeNull();
  const remote = structuredClone(local);
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  const changed = mergeLibraryUpdate(saved, local, serializeStash(remote));
  expect(changed?.groups[0].entries[0].profile!.settings.port).toBe(2080);
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
it('retains newly discovered entries and health while saving a local display name', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].name = 'Preferred';
  remote.groups[0].entries.push({ ...remote.groups[0].entries[0], id: 'new-server' });
  remote.groups[0].entries[0].health = {
    status: 'alive',
    checkedAt: 123,
    profileId: policyProfileId(remote.groups[0].entries[0].profile!),
    latencyMs: 42,
  };
  const result = merge(base, local, remote);
  expect(result.groups[0].entries).toHaveLength(2);
  expect(result.groups[0].entries[0]).toMatchObject({
    name: 'Preferred',
    health: { latencyMs: 42 },
  });
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
it('discards an observation when a local connection edit changes its identity', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].profile!.settings.port = 2080;
  remote.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: 123,
    profileId: policyProfileId(base.groups[0].entries[0].profile!),
    latencyMs: null,
  };
  expect(merge(base, local, remote).groups[0].entries[0].health).toBeUndefined();
});
it('does not resurrect a concurrently deleted entry', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].name = 'Renamed';
  remote.groups[0].entries = [];
  expect(merge(base, local, remote).groups[0].entries).toHaveLength(0);
});
it('preserves provider order when the user only renamed the group', () => {
  const base = example();
  base.groups[0].entries.push({ ...base.groups[0].entries[0], id: 'second' });
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].name = 'My group';
  remote.groups[0].entries.reverse();
  expect(merge(base, local, remote).groups[0].entries.map((e) => e.id)).toEqual(
    remote.groups[0].entries.map((e) => e.id),
  );
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

it('keeps a concurrent lock on the starred original without starring the provider copy', () => {
  const base = example();
  base.groups[0].entries[0].starred = true;
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].locked = true;
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  const entries = merge(base, local, remote).groups[0].entries;
  expect(entries[0]).toMatchObject({
    id: base.groups[0].entries[0].id,
    locked: true,
    starred: true,
  });
  expect(entries[1]).toMatchObject({ sourceCopyOf: entries[0].id, locked: false });
  expect(entries[1].starred).toBeUndefined();
});

it('turning removal off ends a scan and preserves its latest diagnostic result', () => {
  const base = example();
  base.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: true };
  base.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: 123,
    latencyMs: null,
    profileId: policyProfileId(base.groups[0].entries[0].profile!),
  };
  base.groups[0].testCycleAt = 100;
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0] = setGroupMaintenance(local.groups[0], {
    ...maintenanceDefaults,
    removeUnreachable: false,
  });
  remote.groups[0].entries[0].health!.checkedAt = 456;
  remote.groups[0].testCycleAt = 200;
  const group = merge(base, local, remote).groups[0];
  expect(group.maintenance!.removeUnreachable).toBe(false);
  expect(group.entries[0].health?.checkedAt).toBe(456);
  expect(group.testCycleAt).toBeUndefined();
  expect(entryAvailable(group.entries[0])).toBe(true);
});

it('keeps a concurrent manual health result when Keep all was not changed', () => {
  const base = example(),
    local = structuredClone(base),
    remote = structuredClone(base);
  base.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: false };
  local.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: false };
  remote.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: false };
  local.groups[0].name = 'My provider';
  remote.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: 456,
    latencyMs: null,
    profileId: policyProfileId(remote.groups[0].entries[0].profile!),
  };
  expect(merge(base, local, remote).groups[0].entries[0].health).toEqual(
    remote.groups[0].entries[0].health,
  );
});

it('does not clear another entry health when an ordinary profile edit invalidates its own result', () => {
  const base = example();
  base.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: false };
  base.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: 123,
    latencyMs: null,
    profileId: policyProfileId(base.groups[0].entries[0].profile!),
  };
  base.groups[0].entries.push({ ...structuredClone(base.groups[0].entries[0]), id: 'second' });
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0].entries[0].profile!.settings.port = 2080;
  delete local.groups[0].entries[0].health;
  remote.groups[0].entries[1].health!.checkedAt = 456;
  const entries = merge(base, local, remote).groups[0].entries;
  expect(entries[0].health).toBeUndefined();
  expect(entries[1].health).toEqual(remote.groups[0].entries[1].health);
});

it('retains the latest diagnostic result while removal is off', () => {
  const base = example();
  base.groups[0].maintenance = { ...maintenanceDefaults, removeUnreachable: false };
  base.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: 123,
    latencyMs: null,
    profileId: policyProfileId(base.groups[0].entries[0].profile!),
  };
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.groups[0] = setGroupMaintenance(local.groups[0], { ...maintenanceDefaults });
  remote.groups[0].entries[0].health!.checkedAt = 456;
  expect(merge(base, local, remote).groups[0].entries[0].health?.checkedAt).toBe(456);
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
