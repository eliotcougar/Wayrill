import { describe, expect, it } from 'vitest';
import { importProfiles, mergeImport, parseStash, serializeStash, type Stash } from './import';
import { materializeRefresh, prepareRefresh } from './refreshPreparation';
import { applySubscriptionHealth } from './subscriptionHealth';
import { protectedSubscriptionEntries, stashLinkKey } from './subscriptionReferences';
import { maintenanceDefaults, setGroupMaintenance } from './subscriptionState';
import { entryAvailable } from './subscriptionState';
import { libraryRows, searchLibrary } from './library';
import { makeNode } from '../graph/catalog';
import { enableDefaults } from '../graph/defaults';
import {
  policyProfile,
  policyProfileId,
  emptyPolicySources,
  refreshPolicyGraph,
  readPolicySources,
  subscriptionSource,
  refreshPreparedReference,
  refreshPolicySources,
  refreshStashComposites,
} from '../graph/policySources';
import type { GraphState } from '../graph/types';

const links = 'socks://a.example:1080#First\nsocks://b.example:1080#Second';
const fixture = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: importProfiles(links).groups,
});
const graph = (): GraphState =>
  enableDefaults({ name: 'Maintenance regression', nodes: [], edges: [] });
const refresh = (stash: Stash, text: string, g?: GraphState) =>
  materializeRefresh(
    stash,
    prepareRefresh({ stash, text, name: 'Update', replaceId: stash.groups[0].id, graph: g }),
  );

describe('subscription reconciliation', () => {
  it('does not restart an in-progress scan after every scheduled download', () => {
    const stash = fixture();
    stash.groups[0].testCycleAt = 100;
    const next = refresh(stash, links);
    expect(next.groups[0].testCycleAt).toBe(100);
  });
  it('retains a used omitted entry and updates that same entry when the provider changes its connection', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const node = makeNode('socks-outbound', { x: 0, y: 0 });
    node.data.stashLink = { groupId: group.id, entryId: entry.id };
    const g = { ...graph(), nodes: [node] };
    const omitted = refresh(stash, 'socks://b.example:1080#Second', g);
    expect(omitted.groups[0].entries.find((e) => e.id === entry.id)).toMatchObject({
      retained: true,
      address: 'a.example',
    });
    const returned = refresh(
      omitted,
      'socks://new.example:2080#First\nsocks://b.example:1080#Second',
      g,
    );
    expect(returned.groups[0].entries.find((e) => e.id === entry.id)).toMatchObject({
      address: 'new.example',
    });
    expect(returned.groups[0].entries.find((e) => e.id === entry.id)?.retained).toBeUndefined();
  });
  it('forks a changed locked configuration once, and keeps updating only the new unlocked copy', () => {
    const stash = fixture(),
      locked = stash.groups[0].entries[0];
    locked.locked = true;
    const once = refresh(stash, links.replace('a.example', 'new.example'));
    expect(once.groups[0].entries).toHaveLength(3);
    expect(once.groups[0].entries.find((e) => e.id === locked.id)).toBe(locked);
    const twice = refresh(once, links.replace('a.example', 'new.example'));
    expect(twice.groups[0].entries).toHaveLength(3);
    const third = refresh(twice, links.replace('a.example', 'newer.example'));
    expect(third.groups[0].entries).toHaveLength(3);
    expect(third.groups[0].entries.find((e) => e.id === locked.id)).toBe(locked);
    expect(third.groups[0].entries.some((e) => e.address === 'newer.example')).toBe(true);
  });
  it('consolidates an unreferenced provider copy after unlocking, while preserving an explicitly used copy', () => {
    const stash = fixture(),
      group = stash.groups[0],
      original = group.entries[0];
    original.locked = true;
    const changed = links.replace('a.example', 'changed.example');
    const forked = refresh(stash, changed);
    const copy = forked.groups[0].entries.find((e) => e.sourceCopyOf === original.id)!;
    const unlocked = {
      ...forked,
      groups: [
        {
          ...forked.groups[0],
          entries: forked.groups[0].entries.map((e) =>
            e.id === original.id ? { ...e, locked: false } : e,
          ),
        },
      ],
    };
    const consolidated = refresh(unlocked, changed);
    expect(consolidated.groups[0].entries).toHaveLength(2);
    expect(consolidated.groups[0].entries.find((e) => e.id === original.id)?.address).toBe(
      'changed.example',
    );
    const node = makeNode('socks-outbound', { x: 0, y: 0 });
    node.data.stashLink = { groupId: group.id, entryId: copy.id };
    expect(
      refresh(unlocked, changed, { ...graph(), nodes: [node] }).groups[0].entries.some(
        (e) => e.id === copy.id,
      ),
    ).toBe(true);
  });
  it('does not guess which duplicate name acquired new credentials', () => {
    const stash = fixture();
    stash.groups[0].entries.forEach((e) => {
      e.name = 'Same';
    });
    const result = mergeImport(
      stash,
      importProfiles('socks://other.example:1080#Same'),
      stash.groups[0].id,
    );
    expect(result.groups[0].entries[0].id).not.toBe(stash.groups[0].entries[0].id);
    expect(result.groups[0].entries[0].id).not.toBe(stash.groups[0].entries[1].id);
  });
  it('follows explicitly selected manual and fallback settings and retains omitted dependencies', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const node = makeNode('policy-group', { x: 0, y: 0 });
    node.data.settings.sources = JSON.stringify({
      ...emptyPolicySources(),
      manual: [policyProfile(entry)],
      fallback: policyProfile(entry),
    });
    const g = { ...graph(), nodes: [node] };
    const prepared = prepareRefresh({
      stash,
      graph: g,
      text: links.replace('a.example', 'changed.example'),
      name: 'Update',
      replaceId: group.id,
    });
    const updated = materializeRefresh(stash, prepared);
    const protectedIds = protectedSubscriptionEntries(stash, g);
    expect(protectedIds.has(stashLinkKey({ groupId: group.id, entryId: entry.id }))).toBe(true);
    const patch = prepared.patches.find((p) => p.id === node.id)!;
    const sources = readPolicySources({
      ...node.data,
      settings: { ...node.data.settings, sources: patch.after },
    });
    expect(sources.manual[0]).toMatchObject({
      type: 'profile',
      source: { groupId: group.id, entryId: entry.id },
      profile: { settings: { address: 'changed.example' } },
    });
    expect(sources.fallback).toEqual(sources.manual[0]);
    expect(updated.groups[0].entries[0].id).toBe(entry.id);
  });
});

describe('health cleanup and preservation', () => {
  it('does not rewrite saved policy definitions when a health update leaves the pool unchanged', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const node = makeNode('policy-group', { x: 0, y: 0 });
    const sources = refreshPolicySources(
      { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
      stash,
    );
    const saved = {
      ...entry,
      id: 'saved-policy',
      protocol: 'policy-group',
      profile: {
        kind: 'policy-group' as const,
        settings: { ...node.data.settings, sources: JSON.stringify(sources) },
      },
    };
    stash.groups.push({ ...group, id: 'manual', entries: [saved] });
    expect(refreshStashComposites(stash)).toBe(stash);
    const checked = applySubscriptionHealth(
      stash,
      graph(),
      group.id,
      [
        {
          entryId: entry.id,
          health: {
            status: 'alive',
            checkedAt: 1,
            profileId: policyProfileId(entry.profile!),
            latencyMs: 20,
          },
        },
      ],
      false,
    );
    expect(refreshStashComposites(checked)).toBe(checked);
    expect(checked.groups[1].entries[0]).toBe(saved);
  });
  it('retains policy membership for every diagnostic-only health change', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const sources = refreshPolicySources(
      { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
      stash,
    );
    const observation = (status: 'alive' | 'dead', checkedAt: number) => [
      {
        entryId: entry.id,
        health: {
          status,
          checkedAt,
          profileId: policyProfileId(entry.profile!),
          latencyMs: status === 'alive' ? 20 : null,
        },
      },
    ];
    const checked = applySubscriptionHealth(
      stash,
      graph(),
      group.id,
      observation('alive', 1),
      false,
    );
    expect(refreshPolicySources(sources, checked)).toBe(sources);
    const checkedAgain = applySubscriptionHealth(
      checked,
      graph(),
      group.id,
      observation('alive', 2),
      false,
    );
    expect(refreshPolicySources(sources, checkedAgain)).toBe(sources);
    const failed = applySubscriptionHealth(
      checkedAgain,
      graph(),
      group.id,
      observation('dead', 3),
      false,
    );
    const without = refreshPolicySources(sources, failed);
    expect(without.subscriptions[0].entries).toHaveLength(2);
    const recovered = applySubscriptionHealth(
      failed,
      graph(),
      group.id,
      observation('alive', 4),
      false,
    );
    expect(refreshPolicySources(without, recovered).subscriptions[0].entries).toHaveLength(2);
  });
  it('does not heal a corrupt saved identity by following its source link', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const ref = policyProfile(entry, { groupId: group.id, entryId: entry.id });
    ref.id = '0'.repeat(32);
    expect(() => refreshPreparedReference(ref, stash)).toThrow('inconsistent identity');
  });
  it('keeps failed retained servers usable in pools and pickers', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const updated = applySubscriptionHealth(
      stash,
      graph(),
      group.id,
      [
        {
          entryId: entry.id,
          health: {
            profileId: policyProfileId(entry.profile!),
            status: 'dead',
            checkedAt: 1234,
            latencyMs: null,
          },
        },
      ],
      false,
    );
    expect(updated.groups[0].entries).toHaveLength(2);
    expect(entryAvailable(updated.groups[0].entries[0])).toBe(true);
    expect(searchLibrary(libraryRows(updated.groups), '', '', true)).toHaveLength(2);
    const sources = refreshPolicySources(
      { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
      updated,
    );
    expect(sources.subscriptions[0].entries).toHaveLength(2);
    const revived = applySubscriptionHealth(
      updated,
      graph(),
      group.id,
      [
        {
          entryId: entry.id,
          health: {
            profileId: policyProfileId(entry.profile!),
            status: 'alive',
            checkedAt: 5678,
            latencyMs: 20,
          },
        },
      ],
      false,
    );
    expect(refreshPolicySources(sources, revived).subscriptions[0].entries).toHaveLength(2);
  });
  it('never applies an old test to replaced credentials', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const updated = refresh(stash, links.replace('a.example', 'new.example'));
    expect(
      applySubscriptionHealth(
        updated,
        graph(),
        group.id,
        [
          {
            entryId: entry.id,
            health: {
              profileId: policyProfileId(entry.profile!),
              status: 'dead',
              checkedAt: 1234,
              latencyMs: null,
            },
          },
        ],
        true,
      ),
    ).toBe(updated);
  });
  it('protects an explicitly referenced fallback from automatic deletion', () => {
    const stash = fixture(),
      group = stash.groups[0];
    const node = makeNode('policy-group', { x: 0, y: 0 });
    node.data.settings.sources = JSON.stringify({
      ...emptyPolicySources(),
      fallback: policyProfile(group.entries[0], {
        groupId: group.id,
        entryId: group.entries[0].id,
      }),
    });
    const observations = group.entries.map((entry) => ({
      entryId: entry.id,
      health: {
        profileId: policyProfileId(entry.profile!),
        status: 'dead' as const,
        checkedAt: 1234,
        latencyMs: null,
      },
    }));
    const updated = applySubscriptionHealth(
      stash,
      { ...graph(), nodes: [node] },
      group.id,
      observations,
      true,
    );
    expect(updated.groups[0].entries).toHaveLength(1);
    expect(updated.groups[0].entries[0].id).toBe(group.entries[0].id);
    const refreshed = refreshPolicyGraph({ ...graph(), nodes: [node] }, updated);
    expect(readPolicySources(refreshed.nodes[0].data).fallback).toBeDefined();
  });
  it('round-trips maintenance settings and rejects invalid retry counts', () => {
    const stash = fixture();
    stash.groups[0].maintenance = {
      ...maintenanceDefaults,
      autoRefresh: true,
      removeUnreachable: true,
    };
    stash.groups[0].lastTestAt = 100;
    const next = parseStash(serializeStash(stash));
    expect(next).toEqual(stash);
    const malicious = JSON.parse(serializeStash(stash));
    malicious.groups[0].maintenance.maxRetries = -1;
    expect(() => parseStash(JSON.stringify(malicious))).toThrow('maintenance');
  });
});

describe('maintenance settings edits', () => {
  it('preserves completed tests and scan progress when only refresh/retest timing changes', () => {
    const group = {
      ...fixture().groups[0],
      maintenance: { ...maintenanceDefaults, removeUnreachable: true },
      lastTestAt: 10,
      testCycleAt: 20,
    };
    expect(setGroupMaintenance(group, { ...group.maintenance })).toBe(group);
    expect(setGroupMaintenance(group, { ...group.maintenance, refreshMinutes: 60 })).toMatchObject({
      lastTestAt: 10,
      testCycleAt: 20,
    });
    expect(
      setGroupMaintenance(group, { ...group.maintenance, maxRetries: 0 }).lastTestAt,
    ).toBeUndefined();
  });
  it('turning removal off ends an in-progress scan without changing usability', () => {
    const stash = fixture(),
      group = stash.groups[0],
      entry = group.entries[0];
    const failed = applySubscriptionHealth(
      stash,
      graph(),
      group.id,
      [
        {
          entryId: entry.id,
          health: {
            status: 'dead',
            checkedAt: 1,
            profileId: policyProfileId(entry.profile!),
            latencyMs: null,
          },
        },
      ],
      false,
    ).groups[0];
    const enabled = setGroupMaintenance({ ...failed, testCycleAt: 20 }, maintenanceDefaults);
    expect(enabled.testCycleAt).toBeUndefined();
    expect(enabled.entries.every(entryAvailable)).toBe(true);
  });
});
