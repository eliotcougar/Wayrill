import { expect, it } from 'vitest';
import { prepareRefresh, materializeRefresh } from './refreshPreparation';
import {
  importProfiles,
  mergeImport,
  parseStash,
  serializeStash,
  seedStashSerialization,
  stashByteLength,
  type Stash,
} from './import';
import { createPolicyExample } from '../graph/policyExample';
import {
  emptyPolicySources,
  subscriptionSource,
  refreshPolicyGraph,
  refreshPolicySources,
  primePolicyRefresh,
  readPolicySources,
} from '../graph/policySources';
import { syncStashEdits } from './workspace';

const links = 'socks://a.example:1080#First\nsocks://b.example:1080#Second';
const fixture = () =>
  ({ format: 'wayrill.stash', version: 3, groups: importProfiles(links).groups }) as Stash;
it('returns entry deltas, preserves unchanged identities and locks, and prepares the exact policy refresh', () => {
  const stash = fixture();
  stash.groups[0].entries[1].locked = true;
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  node.data.settings.selection = 'subscription';
  node.data.settings.sources = JSON.stringify({
    ...emptyPolicySources(),
    subscriptions: [subscriptionSource(stash.groups[0])],
  });
  const prepared = prepareRefresh({
    text: links.replace('b.example', 'changed.example'),
    name: 'Updated',
    stash,
    replaceId: stash.groups[0].id,
    graph,
  });
  const next = materializeRefresh(stash, structuredClone(prepared));
  expect(next.groups[0].entries[0]).toBe(stash.groups[0].entries[0]);
  expect(next.groups[0].entries.find((entry) => entry.id === stash.groups[0].entries[1].id)).toBe(
    stash.groups[0].entries[1],
  );
  expect(prepared.summary).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 2 });
  const linked = syncStashEdits(graph, stash, next),
    ordinary = refreshPolicyGraph(linked, next);
  primePolicyRefresh(next, prepared.patches);
  expect(refreshPolicyGraph(linked, next)).toEqual(ordinary);
  expect(refreshPolicyGraph(ordinary, next)).toBe(ordinary);
  const edited = {
    ...linked,
    nodes: linked.nodes.map((n) =>
      n.id === node.id
        ? {
            ...n,
            data: {
              ...n.data,
              settings: { ...n.data.settings, sources: JSON.stringify(emptyPolicySources()) },
            },
          }
        : n,
    ),
  };
  expect(
    readPolicySources(refreshPolicyGraph(edited, next).nodes.find((n) => n.id === node.id)!.data)
      .subscriptions,
  ).toEqual([]);
  seedStashSerialization(next, prepared.serialization);
  expect(parseStash(serializeStash(next))).toEqual(next);
  expect(stashByteLength(next)).toBe(new TextEncoder().encode(serializeStash(next)).length);
});
it('retains preparation for only one library revision, independently of Undo history', () => {
  const stash = fixture(),
    graph = createPolicyExample();
  const node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const original = String(node.data.settings.sources);
  const obsolete = JSON.stringify(emptyPolicySources());
  primePolicyRefresh(stash, [
    {
      id: node.id,
      kind: node.data.kind,
      field: 'sources',
      before: original,
      after: obsolete,
    },
  ]);
  const latest = { ...stash };
  primePolicyRefresh(latest, []);
  expect(
    refreshPolicyGraph(graph, stash).nodes.find((n) => n.id === node.id)!.data.settings.sources,
  ).toBe(original);
});
it('produces the same complete merge, counts and export after changed or omitted profiles', () => {
  const stash = fixture(),
    text = 'socks://changed.example:1080#First\nsocks://new.example:1080#Third';
  const prepared = prepareRefresh({ text, name: 'New', stash, replaceId: stash.groups[0].id });
  const actual = materializeRefresh(stash, prepared);
  const expected = mergeImport(stash, importProfiles(text, 'New'), stash.groups[0].id);
  expect(actual.groups[0].entries.map(({ id: _, ...entry }) => entry)).toEqual(
    expected.groups[0].entries.map(({ id: _, ...entry }) => entry),
  );
  expect(prepared.summary).toMatchObject({ added: 1, updated: 1, unchanged: 0, removed: 1 });
});

it('reuses canonical source objects after an ordinary refresh instead of reparsing and serializing unchanged pools', () => {
  const stash = fixture(),
    graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  node.data.settings.selection = 'subscription';
  node.data.settings.sources = JSON.stringify({
    ...emptyPolicySources(),
    subscriptions: [subscriptionSource(stash.groups[0])],
  });
  const updated = refreshPolicyGraph(graph, stash),
    data = updated.nodes.find((n) => n.id === node.id)!.data;
  const sources = readPolicySources(data);
  expect(refreshPolicySources(sources, stash)).toBe(sources);
  expect(refreshPolicyGraph(updated, stash)).toBe(updated);
});
