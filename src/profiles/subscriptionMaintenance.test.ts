import { describe, expect, it } from 'vitest';
import { importProfiles, parseStash, serializeStash, type Stash } from './import';
import { materializeRefresh, prepareRefresh } from './refreshPreparation';
import { applySubscriptionHealth } from './subscriptionHealth';
import { protectedSubscriptionEntries, stashLinkKey } from './subscriptionReferences';
import { maintenanceDefaults, setGroupMaintenance } from './subscriptionState';
import { entryAvailable } from './subscriptionState';
import { makeNode } from '../graph/catalog';
import { enableDefaults } from '../graph/defaults';
import {
  policyProfile,
  policyProfileId,
  emptyPolicySources,
  refreshPolicyGraph,
  readPolicySources,
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
  it('preserves exact matches and refuses to guess among changed entries with the same name', () => {
    const stash: Stash = {
      format: 'wayrill.stash',
      version: 3,
      groups: importProfiles(
        'socks://a.example:1080#Shared\nsocks://b.example:1080#Shared\nsocks://c.example:1080#Shared',
      ).groups,
    };
    const [unchanged, locked, removed] = stash.groups[0].entries;
    unchanged.starred = true;
    locked.locked = true;
    const next = refresh(
      stash,
      'socks://a.example:1080#Shared\nsocks://d.example:1080#Shared\nsocks://e.example:1080#Shared',
    ).groups[0].entries;

    expect(next.find((entry) => entry.address === 'a.example')).toBe(unchanged);
    expect(next.find((entry) => entry.address === 'b.example')).toBe(locked);
    expect(next.find((entry) => entry.address === 'c.example')).toBeUndefined();
    for (const entry of next.filter((item) => ['d.example', 'e.example'].includes(item.address))) {
      expect([unchanged.id, locked.id, removed.id]).not.toContain(entry.id);
      expect(entry.sourceCopyOf).toBeUndefined();
    }
    expect(next.map((entry) => entry.address)).toEqual([
      'a.example',
      'd.example',
      'e.example',
      'b.example',
    ]);
  });

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
  it('keeps the original link when a Stash-format refresh changes a locked entry with the same ID', () => {
    const stash = fixture();
    const provider = structuredClone(stash);
    const original = stash.groups[0].entries[0];
    original.locked = true;
    const replacement = importProfiles('socks://new.example:1080#First').groups[0].entries[0];
    provider.groups[0].entries[0] = { ...replacement, id: original.id };

    const refreshed = refresh(stash, serializeStash(provider));
    const entries = parseStash(serializeStash(refreshed)).groups[0].entries;
    expect(entries.find((entry) => entry.id === original.id)).toEqual(original);
    const copy = entries.find((entry) => entry.address === 'new.example');
    expect(copy).toMatchObject({ sourceCopyOf: original.id });
    expect(copy?.id).not.toBe(original.id);
    const next = refresh(refreshed, serializeStash(provider)).groups[0].entries;
    expect(next.find((entry) => entry.address === 'new.example')?.id).toBe(copy?.id);
    expect(next).toHaveLength(3);
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
});

describe('maintenance settings edits', () => {
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
