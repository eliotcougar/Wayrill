import { describe, expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { updateGraphNode, parseGraph, serializeGraph } from '../graph/model';
import { createPolicyExample } from '../graph/policyExample';
import { xrayOutboundConfig } from '../graph/xrayCompiler';
import { importXrayConfig } from '../graph/xrayImport';
import { importProfiles, mergeImport, parseStash, serializeStash, type Stash } from './import';
import {
  defaultGroup,
  findStashEntry,
  putStashEntry,
  lockStashEntry,
  removeStashEntries,
  stashRows,
} from './stashModel';
import { snapshotGraphEntry, syncGraphEdits, syncStashEdits } from './workspace';
import { applyStashedProfile } from './graph';
import type { GraphState } from '../graph/types';
import { policyProfileId } from '../graph/profileIdentity';
const empty = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: [defaultGroup()],
});
it('serializes restored history and independent documents without stale cached group contents', () => {
  const original: Stash = { ...empty(), groups: [{ ...defaultGroup(), id: 'cache-qa' }] };
  const first = serializeStash(original);
  const edited = { ...original, groups: original.groups.map((g) => ({ ...g, name: 'Changed' })) };
  const second = serializeStash(edited);
  expect(second).not.toBe(first);
  expect(parseStash(second)).toEqual(edited);
  expect(serializeStash(original)).toBe(first);
  const independent = structuredClone(edited);
  independent.groups[0].name = 'Independent';
  expect(parseStash(serializeStash(independent))).toEqual(independent);
  expect(serializeStash(edited)).toBe(second);
});
it('refreshes many equivalent profiles in stable source order and preserves locked entries', () => {
  const base = importProfiles(JSON.stringify({ protocol: 'freedom', tag: 'direct' })).groups[0];
  const group = {
    ...base,
    entries: Array.from({ length: 20000 }, (_, i) => ({
      ...base.entries[0],
      id: `old-${i}`,
      name: `Alias ${i}`,
      ...(i === 7 ? { locked: true } : {}),
    })),
  };
  const incoming = {
    ...base,
    entries: group.entries.map((entry, i) => ({
      ...entry,
      id: `new-${i}`,
      locked: undefined,
    })),
  };
  const updated = mergeImport(
    { format: 'wayrill.stash', version: 3, groups: [group] },
    { groups: [incoming], duplicates: 0, rejected: 0, problems: [] },
    group.id,
  );
  expect(updated.groups[0].entries.map((entry) => entry.id)).toEqual(
    group.entries.map((entry) => entry.id),
  );
  expect(updated.groups[0].entries[7]).toBe(group.entries[7]);
});
function setup() {
  const node = makeNode('socks-outbound', { x: 30, y: 40 }, 'first');
  Object.assign(node.data.settings, {
    address: 'old.example.net',
    port: 1080,
    tag: 'local-a',
  });
  const before: GraphState = {
    name: 'Shared',
    nodes: [],
    edges: [],
    defaults: factoryDefaults(),
  };
  return syncGraphEdits(before, { ...before, nodes: [node] }, empty());
}
describe('Shared outbound definitions', () => {
  it('adopts graph-created and imported outbounds into manual Default entries and ignores layout changes', () => {
    const { graph, stash } = setup(),
      link = graph.nodes[0].data.stashLink!;
    expect(link.groupId).toBe('wayrill:default');
    expect(findStashEntry(stash, link)?.manual).toBe(true);
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) => ({
        ...n,
        position: { x: 300, y: 400 },
        selected: true,
      })),
    };
    expect(syncGraphEdits(graph, moved, stash).stash).toBe(stash);
    expect(parseGraph(serializeGraph(graph)).nodes[0].data.stashLink).toEqual(link);
    expect(parseStash(serializeStash(stash))).toEqual(stash);
  });
  it('shares edits across copies while preserving tags, positions, selection and incoming wires', () => {
    let { graph, stash } = setup();
    const entry = stash.groups[0].entries[0],
      link = graph.nodes[0].data.stashLink!;
    graph = applyStashedProfile(graph, entry, { x: 600, y: 80 }, undefined, link);
    const copy = graph.nodes[1];
    graph.nodes.push(makeNode('proxy-inbound', { x: 0, y: 80 }, 'external'));
    graph.edges = [
      {
        id: 'wire',
        source: 'external',
        sourceHandle: 'data',
        target: copy.id,
        targetHandle: 'in',
      },
    ];
    const tag = copy.data.settings.tag,
      position = copy.position;
    const edited = updateGraphNode(graph, 'first', {
      label: 'Friendly 🧭',
      settings: { ...graph.nodes[0].data.settings, address: 'new.example.net' },
    });
    const next = syncGraphEdits(graph, edited, stash);
    stash = next.stash;
    expect(findStashEntry(stash, link)?.profile?.settings.address).toBe('new.example.net');
    expect(next.graph.nodes[1]).toMatchObject({
      position,
      selected: true,
      data: {
        label: 'Friendly 🧭',
        settings: { address: 'new.example.net', tag },
      },
    });
    expect(next.graph.edges).toEqual(graph.edges);
  });
  it('applies library edits and detaches removed entries without changing working node settings', () => {
    const { graph, stash } = setup(),
      link = graph.nodes[0].data.stashLink!,
      previous = findStashEntry(stash, link)!;
    const nextEntry = {
      ...previous,
      draft: {
        ...previous.draft!,
        settings: { ...previous.draft!.settings, port: 2080 },
      },
    };
    const next = putStashEntry(stash, nextEntry, link, previous),
      updated = syncStashEdits(graph, stash, next);
    expect(updated.nodes[0].data.settings.port).toBe(2080);
    const detached = syncStashEdits(updated, next, removeStashEntries(next, [link]));
    expect(detached.nodes[0].data.stashLink).toBeUndefined();
    expect(detached.nodes[0].data.settings).toEqual(updated.nodes[0].data.settings);
  });
  it('retains incomplete settings as an editable draft rather than erasing a shared configuration', () => {
    const { graph, stash } = setup(),
      link = graph.nodes[0].data.stashLink!;
    const next = syncGraphEdits(
      graph,
      updateGraphNode(graph, 'first', {
        settings: { ...graph.nodes[0].data.settings, address: '' },
      }),
      stash,
    );
    const entry = findStashEntry(next.stash, link)!;
    expect(entry.profile).toBeNull();
    expect(entry.draft?.settings.address).toBe('');
    expect(parseStash(serializeStash(next.stash))).toEqual(next.stash);
  });
  it('saves groups and chains as manual entries with portable candidate and hop definitions', () => {
    const graph = createPolicyExample();
    const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'one', outbound: { type: 'node', nodeId: 'test-first' } },
        { id: 'two', outbound: { type: 'node', nodeId: 'test-group' } },
      ],
    });
    graph.nodes.push(chain);
    const saved = syncGraphEdits({ ...graph, nodes: [] }, graph, empty());
    for (const kind of ['policy-group', 'proxy-chain'] as const) {
      const entry = stashRows(saved.stash, kind)[0].entry;
      expect(entry.manual).toBe(true);
      expect(entry.profile?.kind).toBe(kind);
    }
    expect(parseStash(serializeStash(saved.stash))).toEqual(saved.stash);
  });
  it('updates composite observation connections without disturbing the selected node', () => {
    const original = createPolicyExample();
    const { graph, stash } = syncGraphEdits({ ...original, nodes: [] }, original, empty());
    const node = graph.nodes.find((n) => n.id === 'test-group')!,
      link = node.data.stashLink!,
      entry = findStashEntry(stash, link)!;
    const changed = snapshotGraphEntry(
      updateGraphNode(graph, node.id, {
        settings: {
          ...node.data.settings,
          observe: false,
          fallbackEnabled: false,
          strategy: 'roundRobin',
        },
      }),
      {
        ...node,
        data: {
          ...node.data,
          settings: {
            ...node.data.settings,
            observe: false,
            fallbackEnabled: false,
            strategy: 'roundRobin',
          },
        },
      },
      entry.id,
      entry,
    );
    const after = putStashEntry(stash, changed, link);
    const updated = syncStashEdits(graph, stash, after);
    expect(
      updated.edges.some((e) => e.source === node.id && e.sourceHandle === 'observation'),
    ).toBe(true);
    expect(updated.nodes.find((n) => n.id === node.id)?.selected).toBe(node.selected);
  });
  it('preserves native unknown fields and independently rebases copy tags in an authored graph', () => {
    const imported = importXrayConfig(
      JSON.stringify({
        inbounds: [],
        outbounds: [
          {
            protocol: 'freedom',
            tag: 'native-a',
            sendThrough: '192.0.2.1',
            settings: { domainStrategy: 'UseIPv4', userLevel: 3 },
          },
        ],
        routing: { rules: [] },
      }),
    );
    const node = imported.nodes.find((n) => n.data.kind === 'direct-outbound')!;
    const entry = snapshotGraphEntry(imported, node, 'native-entry');
    expect(entry.profile).not.toBeNull();
    const graph = applyStashedProfile(
      { name: 'New', nodes: [], edges: [], defaults: factoryDefaults() },
      entry,
      { x: 0, y: 0 },
    );
    const copy = applyStashedProfile(graph, entry, { x: 500, y: 0 });
    expect(xrayOutboundConfig(copy.nodes[0].data)).toMatchObject({
      sendThrough: '192.0.2.1',
      settings: { userLevel: 3 },
    });
    expect(xrayOutboundConfig(copy.nodes[1].data).tag).not.toBe(
      xrayOutboundConfig(copy.nodes[0].data).tag,
    );
    expect(parseGraph(serializeGraph(copy)).nodes).toHaveLength(2);
  });
  it('rejects stale library editor saves and does not mutate the prior snapshot', () => {
    const { stash, graph } = setup(),
      link = graph.nodes[0].data.stashLink!,
      entry = findStashEntry(stash, link)!;
    const changed = putStashEntry(
      stash,
      {
        ...entry,
        draft: { ...entry.draft!, settings: { ...entry.draft!.settings, port: 2080 } },
      },
      link,
    );
    expect(() => putStashEntry(changed, { ...entry, name: 'Stale' }, link, entry)).toThrow(
      /changed while editing/,
    );
    expect(findStashEntry(stash, link)).toBe(entry);
    expect(findStashEntry(changed, link)?.draft?.settings.port).toBe(2080);
  });
  it('accepts an editor save after a health update or library round trip and preserves current metadata', () => {
    const { stash, graph } = setup(),
      link = graph.nodes[0].data.stashLink!;
    const entry = findStashEntry(stash, link)!;
    const health = {
      status: 'dead' as const,
      checkedAt: 1234,
      profileId: policyProfileId(entry.profile!),
      latencyMs: null,
    };
    const current = structuredClone(stash);
    Object.assign(findStashEntry(current, link)!, {
      locked: true,
      retained: true,
      sourceName: 'Provider name',
      health,
    });
    const saved = putStashEntry(current, { ...entry, name: 'Renamed' }, link, entry);
    expect(findStashEntry(saved, link)).toMatchObject({
      name: 'Renamed',
      locked: true,
      retained: true,
      sourceName: 'Provider name',
      health,
    });
    expect(findStashEntry(stash, link)).toBe(entry);
    expect(findStashEntry(current, link)?.name).toBe(entry.name);
  });
  it('does not revive removed health and clears current health when connection settings change', () => {
    const { stash, graph } = setup(),
      link = graph.nodes[0].data.stashLink!;
    const entry = findStashEntry(stash, link)!;
    entry.health = {
      status: 'dead',
      checkedAt: 1234,
      profileId: policyProfileId(entry.profile!),
      latencyMs: null,
    };
    const current = structuredClone(stash);
    delete findStashEntry(current, link)!.health;
    expect(
      findStashEntry(putStashEntry(current, { ...entry, name: 'Renamed' }, link, entry), link)
        ?.health,
    ).toBeUndefined();
    const changed = {
      ...entry,
      profile: {
        ...entry.profile!,
        settings: { ...entry.profile!.settings, address: 'new.example.net' },
      },
    };
    expect(
      findStashEntry(putStashEntry(stash, changed, link, entry), link)?.health,
    ).toBeUndefined();
  });
});
describe('Subscription locks', () => {
  const subscription = () => {
    const group = importProfiles(
      'socks://old.example.net:1080#Source\nsocks://gone.example.net:1080#Gone',
    ).groups[0];
    group.url = 'https://public.example.net/sub';
    return { format: 'wayrill.stash', version: 3, groups: [group] } as Stash;
  };
  it('preserves edited locked and omitted locked entries; an unlock allows a subsequent changed URL value', () => {
    let stash = subscription();
    const group = stash.groups[0],
      first = group.entries[0],
      second = group.entries[1];
    const link = { groupId: group.id, entryId: first.id };
    stash = putStashEntry(
      stash,
      {
        ...first,
        name: 'My name',
        profile: {
          ...first.profile!,
          settings: { ...first.profile!.settings, address: 'mine.example.net' },
        },
      },
      link,
    );
    stash = lockStashEntry(stash, link);
    stash = lockStashEntry(stash, { groupId: group.id, entryId: second.id });
    const result = importProfiles('socks://new.example.net:2080#Source');
    const updated = mergeImport(stash, result, group.id);
    expect(updated.groups[0].entries).toHaveLength(3);
    expect(updated.groups[0].entries.find((entry) => entry.id === first.id)).toBe(
      findStashEntry(stash, link),
    );
    expect(updated.groups[0].entries.some((entry) => entry.sourceCopyOf === first.id)).toBe(true);
    const unlocked = lockStashEntry(updated, link),
      refreshed = mergeImport(unlocked, result, group.id);
    expect(refreshed.groups[0].entries.find((entry) => entry.id === first.id)).toMatchObject({
      id: first.id,
      name: 'Source',
      profile: { settings: { address: 'new.example.net', port: 2080 } },
    });
  });
  it('protects prepared definitions in subscription groups and keeps their locks across export/import', () => {
    const graph = createPolicyExample(),
      entry = {
        ...snapshotGraphEntry(
          graph,
          graph.nodes.find((n) => n.id === 'test-group')!,
          'prepared',
        ),
        locked: true,
      };
    const stash: Stash = {
      format: 'wayrill.stash',
      version: 3,
      groups: [
        {
          ...defaultGroup(),
          id: 'distributed',
          name: 'Distributed',
          entries: [entry],
        },
      ],
    };
    const updated = mergeImport(
      stash,
      importProfiles('socks://new.example.net:1080#Other'),
      'distributed',
    );
    expect(stashRows(updated, 'policy-group')[0].entry).toBe(entry);
    expect(parseStash(serializeStash(updated)).groups[0].entries[1].locked).toBe(true);
  });
  it('refreshes linked graph nodes without altering locked nodes or deleting omitted working graph copies', () => {
    let stash = subscription();
    const group = stash.groups[0],
      locked = group.entries[0],
      link = { groupId: group.id, entryId: locked.id };
    let graph = applyStashedProfile(
      { name: 'Sub', nodes: [], edges: [], defaults: factoryDefaults() },
      locked,
      { x: 0, y: 0 },
      undefined,
      link,
    );
    stash = lockStashEntry(stash, link);
    const next = mergeImport(
      stash,
      importProfiles('socks://new.example.net:1080#Source'),
      group.id,
    );
    const updated = syncStashEdits(graph, stash, next);
    expect(updated.nodes[0].data.settings.address).toBe('old.example.net');
    const after = mergeImport(
      lockStashEntry(next, link),
      importProfiles('socks://new.example.net:1080#Source'),
      group.id,
    );
    graph = syncStashEdits(updated, next, after);
    expect(graph.nodes[0].data.settings.address).toBe('new.example.net');
  });
});
