import { describe, expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { updateGraphNode } from '../graph/model';
import { createPolicyExample } from '../graph/policyExample';
import { importProfiles, mergeImport, parseStash, serializeStash, type Stash } from './import';
import {
  defaultGroup,
  findStashEntry,
  putStashEntry,
  lockStashEntry,
  stashRows,
} from './stashModel';
import { syncGraphEdits, syncStashEdits } from './workspace';
import { applyStashedProfile } from './graph';
import type { GraphState } from '../graph/types';
const empty = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: [defaultGroup()],
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
