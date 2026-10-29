import { expect, it } from 'vitest';
import { prepareRefresh, materializeRefresh } from './refreshPreparation';
import {
  importProfiles,
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
