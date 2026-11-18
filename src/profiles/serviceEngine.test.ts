import { expect, it } from 'vitest';
import { subscriptionEngine } from './serviceEngine';
import { parseStash, serializeStash, importProfiles } from './import';
import { runtimeFixture, changedStash } from './subscriptionRuntime.fixture';
import { parseGraph, serializeGraph } from '../graph/model';
import { compileRuntimeGraph } from '../graph/runtime';
import { policyProfileId } from '../graph/profileIdentity';
import { createPolicyExample } from '../graph/policyExample';
import { makeNode } from '../graph/catalog';
import { emptyPolicySources, subscriptionSource } from '../graph/policySources';
import { refreshAppliedSubscriptions } from './subscriptionRuntime';
import { preparedEntry } from '../graph/composites';
import { applyStashedProfile } from './graph';
import { policyProfile } from '../graph/policySources';

it('settles an older pending provider update before an explicit choice from the saved library', () => {
  const { graph, stash } = runtimeFixture();
  const publication = subscriptionEngine({
    operation: 'refresh',
    stash: serializeStash(stash),
    groupId: stash.groups[0].id,
    text: stash.groups[0].entries[0].raw,
  });
  const edited = changedStash(stash, 4080);
  const result = subscriptionEngine({
    operation: 'runtime',
    stash: serializeStash(edited),
    appliedGraph: serializeGraph(graph),
    groupId: stash.groups[0].id,
    groupSnapshot: publication.publications![stash.groups[0].id],
    replacement: {
      nodeId: 'proxy',
      groupId: stash.groups[0].id,
      entryId: stash.groups[0].entries[0].id,
    },
  });
  if (!('graph' in result)) throw new Error('Missing prepared runtime');
  expect(
    parseGraph(result.graph!).nodes.find((node) => node.id === 'proxy')!.data.settings.port,
  ).toBe(4080);
});

it('rejects a deleted selection and leaves a draft-only node out of running routing', () => {
  const { graph, stash } = runtimeFixture();
  const request = {
    operation: 'runtime' as const,
    stash: serializeStash(stash),
    appliedGraph: serializeGraph(graph),
  };
  expect(() =>
    subscriptionEngine({
      ...request,
      replacement: { nodeId: 'proxy', groupId: stash.groups[0].id, entryId: 'removed' },
    }),
  ).toThrow('removed');
  const result = subscriptionEngine({
    ...request,
    replacement: {
      nodeId: 'draft-only',
      groupId: stash.groups[0].id,
      entryId: stash.groups[0].entries[0].id,
    },
  });
  if (!('graph' in result)) throw new Error('Missing prepared runtime');
  expect(result.config).toEqual(compileRuntimeGraph(graph).config);
  expect(parseGraph(result.graph!).nodes).toHaveLength(graph.nodes.length);
  const disabled = structuredClone(stash);
  disabled.groups[0].entries[0].health = {
    status: 'dead',
    checkedAt: Date.now(),
    profileId: policyProfileId(stash.groups[0].entries[0].profile!),
    latencyMs: null,
  };
  expect(() =>
    subscriptionEngine({
      ...request,
      stash: serializeStash(disabled),
      replacement: {
        nodeId: 'proxy',
        groupId: stash.groups[0].id,
        entryId: stash.groups[0].entries[0].id,
      },
    }),
  ).not.toThrow();
});

it('keeps omitted applied entries when the desktop draft no longer uses them', () => {
  const { stash, graph } = runtimeFixture();
  const result = subscriptionEngine({
    operation: 'refresh',
    stash: serializeStash(stash),
    groupId: stash.groups[0].id,
    text: 'socks://192.0.2.2:2080#Replacement',
    appliedGraph: serializeGraph(graph),
    graph: serializeGraph({ name: 'Draft', nodes: [], edges: [] }),
  });
  expect(parseStash(result.stash!).groups[0].entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: stash.groups[0].entries[0].id, retained: true }),
    ]),
  );
});

it('saves changed library definitions without publishing ordinary graph edits to routing', () => {
  const { stash } = runtimeFixture();
  const edited = changedStash(stash, 2080);
  const result = subscriptionEngine({
    operation: 'merge',
    stash: serializeStash(stash),
    base: serializeStash(stash),
    local: serializeStash(edited),
  });
  expect(result.changedGroups).toContain(stash.groups[0].id);
  expect(result.runtimeGroups).toEqual([]);
  expect(parseStash(result.stash!).groups[0].entries[0].profile!.settings.port).toBe(2080);
});
it('updates only the applied outbounds and preserves an unrelated draft listener edit', () => {
  const { stash, graph } = runtimeFixture(),
    draft = structuredClone(graph);
  draft.nodes[0].data.settings.port = 29999;
  const result = subscriptionEngine({
    operation: 'runtime',
    stash: serializeStash(changedStash(stash)),
    groupId: stash.groups[0].id,
    graph: serializeGraph(draft),
    appliedGraph: serializeGraph(graph),
  });
  if (!('graph' in result) || typeof result.graph !== 'string')
    throw new Error('Missing compiled graph.');
  const updated = parseGraph(result.graph);
  expect(updated.nodes.find((n) => n.id === 'proxy')!.data.settings.port).toBe(2080);
  expect(compileRuntimeGraph(updated).config.inbounds).toEqual(
    compileRuntimeGraph(graph).config.inbounds,
  );
  expect(draft.nodes[0].data.settings.port).toBe(29999);
});
for (const nested of [false, true])
  it(`publishes removals without adopting connection drafts${nested ? ' inside a chain' : ''}`, () => {
    const { stash } = runtimeFixture();
    const group = stash.groups[0];
    group.entries.push(
      ...importProfiles('socks://192.0.2.2:2081#Second\nsocks://192.0.2.3:2082#Third').groups[0]
        .entries,
    );
    let graph = createPolicyExample();
    const policy = graph.nodes.find((node) => node.id === 'test-group')!;
    Object.assign(policy.data.settings, {
      strategy: 'roundRobin',
      sources: JSON.stringify({
        ...emptyPolicySources(),
        manual: [
          policyProfile(group.entries[0], { groupId: group.id, entryId: group.entries[0].id }),
        ],
        subscriptions: [subscriptionSource(group)],
        fallback: { type: 'node', nodeId: 'test-block' },
      }),
    });
    graph = refreshAppliedSubscriptions(graph, stash);
    if (nested) {
      const prepared = preparedEntry(graph, policy.id);
      const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'nested');
      chain.data.settings.steps = JSON.stringify({
        version: 1,
        steps: [
          { id: 'first', outbound: policyProfile(group.entries[0]) },
          { id: 'exit', outbound: policyProfile(prepared) },
        ],
      });
      graph = applyStashedProfile(
        graph,
        preparedEntry({ ...graph, nodes: [...graph.nodes, chain] }, chain.id),
        { x: 0, y: 0 },
        policy.id,
      );
    }
    const edited = structuredClone(stash);
    edited.groups[0].entries[0].profile!.settings.port = 3080;
    const observations = group.entries.slice(1).map((entry) => ({
      entryId: entry.id,
      health: {
        status: 'dead' as const,
        checkedAt: 123,
        latencyMs: null,
        profileId: policyProfileId(entry.profile!),
      },
    }));
    const health = subscriptionEngine({
      operation: 'health',
      removeDead: true,
      stash: serializeStash(edited),
      appliedGraph: serializeGraph(graph),
      groupId: group.id,
      observations,
    });
    const runtime = (appliedGraph: string, stash: string, snapshot: string) => {
      const result = subscriptionEngine({
        operation: 'runtime',
        stash,
        appliedGraph,
        groupId: group.id,
        groupSnapshot: snapshot,
      });
      if (!('graph' in result) || typeof result.graph !== 'string')
        throw new Error('Missing compiled graph.');
      return result.graph;
    };
    const removed = runtime(serializeGraph(graph), health.stash!, health.publications![group.id]);
    const sources = (text: string) => {
      const node = parseGraph(text).nodes.find((node) => node.id === policy.id)!;
      const settings = nested
        ? (JSON.parse(String(node.data.settings.steps)).steps[1].outbound.profile
            .settings as typeof node.data.settings)
        : node.data.settings;
      return JSON.parse(String(settings.sources)) as {
        manual: { profile: { settings: { port: number } } }[];
        subscriptions: { entries: { profile: { settings: { port: number } } }[] }[];
      };
    };
    expect(
      sources(removed).subscriptions[0].entries.map((entry) => entry.profile.settings.port),
    ).toEqual([1080]);
    expect(sources(removed).manual[0].profile.settings.port).toBe(1080);
    expect(parseStash(health.stash!).groups[0].entries[0].profile!.settings.port).toBe(3080);
    const loaded = subscriptionEngine({
      operation: 'refresh',
      stash: health.stash!,
      groupId: group.id,
      text: group.entries.map((entry) => entry.raw).join('\n'),
    });
    const recovered = runtime(removed, loaded.stash!, loaded.publications![group.id]);
    expect(
      sources(recovered).subscriptions[0].entries.map((entry) => entry.profile.settings.port),
    ).toEqual([1080, 2081, 2082]);
    const changed = structuredClone(stash);
    const editedTarget = changed.groups[0].entries[1];
    editedTarget.profile!.settings.port = 3081;
    const deleted = subscriptionEngine({
      operation: 'health',
      stash: serializeStash(changed),
      appliedGraph: serializeGraph(graph),
      groupId: group.id,
      removeDead: true,
      observations: [
        {
          entryId: editedTarget.id,
          health: {
            status: 'dead',
            checkedAt: 789,
            latencyMs: null,
            profileId: policyProfileId(editedTarget.profile!),
          },
        },
      ],
    });
    expect(
      parseStash(deleted.stash!).groups[0].entries.some((entry) => entry.id === editedTarget.id),
    ).toBe(false);
    const kept = runtime(serializeGraph(graph), deleted.stash!, deleted.publications![group.id]);
    expect(
      sources(kept).subscriptions[0].entries.map((entry) => entry.profile.settings.port),
    ).toEqual([1080, 2081, 2082]);
  });
it('does not delete failed servers referenced by either saved or applied graph', () => {
  const { stash, graph } = runtimeFixture(),
    entry = stash.groups[0].entries[0];
  const result = subscriptionEngine({
    operation: 'health',
    stash: serializeStash(stash),
    graph: serializeGraph(graph),
    appliedGraph: serializeGraph({ name: 'Other', nodes: [], edges: [] }),
    groupId: stash.groups[0].id,
    removeDead: true,
    observations: [
      {
        entryId: entry.id,
        health: {
          status: 'dead',
          checkedAt: 123,
          latencyMs: null,
          profileId: policyProfileId(entry.profile!),
        },
      },
    ],
  });
  expect(parseStash(result.stash!).groups[0].entries).toHaveLength(1);
});
it('can refresh a second provider while the first has no usable policy candidates', () => {
  const { stash } = runtimeFixture(),
    first = stash.groups[0],
    second = { ...structuredClone(first), id: 'second-provider', name: 'Second provider' };
  stash.groups.push(second);
  let graph = createPolicyExample();
  const policy = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  Object.assign(policy.data.settings, {
    selection: 'subscription',
    fallbackEnabled: false,
    sources: JSON.stringify({
      ...emptyPolicySources(),
      subscriptions: [subscriptionSource(first)],
    }),
  });
  const outbound = makeNode('socks-outbound', { x: 0, y: 0 }, 'second-outbound');
  Object.assign(outbound.data.settings, second.entries[0].profile!.settings, { tag: 'second' });
  outbound.data.stashLink = { groupId: second.id, entryId: second.entries[0].id };
  graph.nodes.push(outbound);
  graph.edges.find((e) => e.sourceHandle === 'dns')!.target = outbound.id;
  graph = refreshAppliedSubscriptions(graph, stash);
  const changed = structuredClone(stash);
  changed.groups[0].entries = [];
  changed.groups[1].entries[0].profile!.settings.port = 2080;
  const request = {
    operation: 'runtime' as const,
    stash: serializeStash(changed),
    appliedGraph: serializeGraph(graph),
  };
  expect(() => subscriptionEngine({ ...request, groupId: first.id })).toThrow(/need attention/);
  const result = subscriptionEngine({ ...request, groupId: second.id });
  if (!('graph' in result) || typeof result.graph !== 'string')
    throw new Error('Missing compiled graph.');
  const refreshed = parseGraph(result.graph);
  expect(refreshed.nodes.find((n) => n.id === outbound.id)!.data.settings.port).toBe(2080);
  expect(refreshed.nodes.find((n) => n.id === policy.id)!.data.settings).toEqual(
    graph.nodes.find((n) => n.id === policy.id)!.data.settings,
  );
});
