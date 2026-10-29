import { describe, expect, it } from 'vitest';
import { createPolicyExample } from './policyExample';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { makeNode } from './catalog';
import { importProfiles } from '../profiles/import';
import type { Stash, StashEntry, StashGroup } from '../profiles/import';
import {
  emptyPolicySources,
  policyProfile,
  policyCandidates,
  policyReferenceSet,
  readPolicySources,
  refreshPolicyGraph,
  refreshPolicySources,
  subscriptionSource,
  type PolicySources,
} from './policySources';

const stash = (groups: StashGroup[]): Stash => ({
  format: 'wayrill.stash',
  version: 3,

  groups,
});
const subscription = () =>
  importProfiles(
    [
      'vless://qa-a@a.example.net:443?security=tls#JP%20Tokyo%20fast',
      'vless://qa-b@b.example.net:443?security=tls#JP%20Tokyo%20slow',
      'vless://qa-c@c.example.net:443?security=tls#DE%20Berlin',
    ].join('\n'),
    'Public sample',
  ).groups[0];
const groupNode = (graph: ReturnType<typeof createPolicyExample>) =>
  graph.nodes.find((n) => n.data.kind === 'policy-group')!;
const configure = (
  graph: ReturnType<typeof createPolicyExample>,
  sources: PolicySources,
  mode = 'subscription',
) => {
  Object.assign(groupNode(graph).data.settings, {
    selection: mode,
    sources: JSON.stringify(sources),
  });
  return graph;
};
const selectors = (config: Record<string, unknown>) =>
  (config.routing as { balancers: { selector: string[] }[] }).balancers[0].selector;

describe('internal outbound sources', () => {
  it('preserves policy weights for imported node IDs that coincide with object property names', () => {
    const graph = createPolicyExample('leastLoad', 'burst'),
      group = groupNode(graph),
      first = graph.nodes.find((node) => node.id === 'test-first')!;
    group.data.settings.costs = JSON.stringify([{ match: 'test-', regexp: true, value: 1 }]);
    group.data.preparedWeightTags = {};
    const original = compileRuntimeGraph(graph).config;
    for (const id of ['constructor', '__proto__', 'toString']) {
      first.id = id;
      const sources = structuredClone(readPolicySources(group.data));
      sources.manual[0] = { type: 'node', nodeId: id };
      group.data.settings.sources = JSON.stringify(sources);
      expect(policyCandidates(graph, group)[0].weightTag).toBe('test-a');
      expect(compileRuntimeGraph(graph).config).toEqual(original);
      group.data.preparedWeightTags = Object.fromEntries([[id, 'original-tag']]);
      expect(policyCandidates(graph, group)[0].weightTag).toBe('original-tag');
      group.data.preparedWeightTags = {};
    }
  });
  it('rejects ambiguous, missing and cyclic dial-through dependencies in internal pools', () => {
    const sub = subscription();
    sub.entries[0].profile!.settings.dialerProxy = 'source-b';
    sub.entries[1].profile!.settings.tag = 'source-b';
    sub.entries[2].profile!.settings.tag = 'source-b';
    const graphWith = (entries: StashEntry[]) =>
      configure(
        createPolicyExample(),
        {
          ...emptyPolicySources(),
          manual: entries.map((entry) => policyProfile(entry)),
          fallback: { type: 'node', nodeId: 'test-block' },
        },
        'manual',
      );
    expect(() => compileRuntimeGraph(graphWith(sub.entries))).toThrow(/matches multiple/);
    expect(() => compileRuntimeGraph(graphWith([sub.entries[0]]))).toThrow(/missing/);
    sub.entries[0].profile!.settings.tag = 'source-a';
    sub.entries[1].profile!.settings.dialerProxy = 'source-a';
    expect(() => compileRuntimeGraph(graphWith(sub.entries.slice(0, 2)))).toThrow(/loop/);
  });
  it('unions a manual set with multiple subscriptions and removes duplicate copies before compilation', () => {
    const sub = subscription(),
      second = { ...sub, id: 'another', name: 'Second group' };
    const first = subscriptionSource(sub),
      extra = subscriptionSource(second);
    first.filter.name = 'Tokyo';
    extra.filter.name = 'Tokyo';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [first, extra],
        manual: [policyProfile(sub.entries[0]), { type: 'node', nodeId: 'test-first' }],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub, second]),
    );
    const graph = configure(createPolicyExample(), sources, 'combined');
    expect(policyReferenceSet(graph, groupNode(graph))).toHaveLength(3);
    const config = compileRuntimeGraph(graph).config;
    expect(selectors(config)).toHaveLength(3);
    expect(config.outbounds).toHaveLength(6);
    expect(compileRuntimeGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
  });
  it('refreshes live subscriptions while retaining independent manual copies and allowing a saved snapshot when the group disappears', () => {
    const sub = subscription(),
      source = subscriptionSource(sub),
      copied = policyProfile(sub.entries[0]);
    source.filter.name = 'fast';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        manual: [copied],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample(), sources, 'combined');
    const changed = subscription();
    changed.id = sub.id;
    changed.entries[0].profile!.settings.address = 'new.example.net';
    const next = refreshPolicyGraph(graph, stash([changed]));
    expect(readPolicySources(groupNode(next).data).manual).toEqual([copied]);
    expect(policyReferenceSet(next, groupNode(next))).toHaveLength(2);
    const absent = refreshPolicyGraph(next, stash([]));
    expect(readPolicySources(groupNode(absent).data).subscriptions[0].missing).toBe(true);
    expect(compileRuntimeGraph(absent).config).toEqual(compileRuntimeGraph(next).config);
    expect(
      compileRuntimeGraph(absent).warnings.some((w) => w.includes('saved outbound snapshot')),
    ).toBe(true);
  });
  it('uses a configured fallback for an empty filtered set and reports an unprotected empty set', () => {
    const sub = subscription(),
      source = subscriptionSource(sub);
    source.filter.name = 'no match';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample('leastPing'), sources);
    const config = compileRuntimeGraph(graph).config;
    expect(selectors(config)).toEqual(['wayrill-policy-empty-test-group']);
    expect(
      (config.routing as { balancers: { fallbackTag: string }[] }).balancers[0].fallbackTag,
    ).toBe('block');
    groupNode(graph).data.settings.fallbackEnabled = false;
    expect(() => compileRuntimeGraph(graph)).toThrow(/No outbound matches/);
  });
  it('shares an internal configuration across groups without duplicating its generated core outbound', () => {
    const sub = subscription(),
      sources = emptyPolicySources();
    sources.manual = [policyProfile(sub.entries[0])];
    sources.fallback = { type: 'node', nodeId: 'test-block' };
    const graph = configure(createPolicyExample(), sources, 'manual'),
      second = makeNode('policy-group', { x: 0, y: 0 }, 'other');
    Object.assign(second.data.settings, {
      tag: 'second',
      selection: 'manual',
      sources: JSON.stringify(sources),
    });
    graph.nodes.push(second);
    const config = compileRuntimeGraph(graph).config;
    expect(config.outbounds).toHaveLength(5);
    expect(
      (config.routing as { balancers: { selector: string[] }[] }).balancers.map((b) => b.selector),
    ).toEqual([selectors(config), selectors(config)]);
  });
});
