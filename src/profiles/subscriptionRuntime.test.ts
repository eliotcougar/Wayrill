import { refreshPolicyGraph, readPolicySources } from '../graph/policySources';
import { syncGraphEdits, syncStashEdits } from './workspace';
import { prepareRefresh, materializeRefresh } from './refreshPreparation';
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { compileRuntimeGraph } from '../graph/runtime';
import { createPolicyExample } from '../graph/policyExample';
import { emptyPolicySources, subscriptionSource, policyProfile } from '../graph/policySources';
import { refreshAppliedSubscriptions } from './subscriptionRuntime';

import { runtimeFixture, changedStash } from './subscriptionRuntime.fixture';
it('refreshes the applied graph independently of unrelated draft changes', () => {
  const { graph, stash } = runtimeFixture();
  const draft = structuredClone(graph);
  draft.nodes[0].data.settings.port = 29999;
  const refreshed = refreshAppliedSubscriptions(graph, changedStash(stash));
  expect(refreshed.nodes.find((n) => n.id === 'proxy')!.data.settings.port).toBe(2080);
  expect(refreshed.nodes[0].data.settings.port).toBe(graph.nodes[0].data.settings.port);
  expect(draft.nodes[0].data.settings.port).toBe(29999);
  expect(compileRuntimeGraph(refreshed).config.inbounds).toEqual(
    compileRuntimeGraph(graph).config.inbounds,
  );
});
it('refreshes adopted prepared chains without freezing graph-linked hops or changing live shape', () => {
  const { graph, stash } = runtimeFixture();
  const provider = stash.groups[0];
  const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'adopted-chain');
  chain.data.settings.tag = 'adopted-chain';
  const entry = provider.entries[0];
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'entry', outbound: policyProfile(entry, { groupId: provider.id, entryId: entry.id }) },
      { id: 'exit', outbound: { type: 'node', nodeId: 'proxy' } },
    ],
  });
  graph.nodes.push(chain);
  graph.edges[0].target = chain.id;
  const adopted = syncGraphEdits(graph, graph, stash, true);
  const before = compileRuntimeGraph(adopted.graph);
  const next = materializeRefresh(
    adopted.stash,
    prepareRefresh({
      stash: adopted.stash,
      graph: adopted.graph,
      replaceId: provider.id,
      name: provider.name,
      text: 'socks://192.0.2.1:2080#Linked',
    }),
  );
  const after = compileRuntimeGraph(refreshAppliedSubscriptions(adopted.graph, next));
  const outputs = (config: Record<string, unknown>) =>
    config.outbounds as Record<string, unknown>[];
  expect(outputs(after.config).map((o) => o.tag)).toEqual(outputs(before.config).map((o) => o.tag));
  expect(
    outputs(after.config)
      .filter((o) => o.protocol === 'socks')
      .map(
        (o) =>
          (o.settings as { port?: number; servers?: { port: number }[] }).port ??
          (o.settings as { servers: { port: number }[] }).servers[0].port,
      ),
  ).toEqual(
    outputs(before.config)
      .filter((o) => o.protocol === 'socks')
      .map(() => 2080),
  );
  expect(after.config.observatory).toEqual(before.config.observatory);
  expect(after.config.routing).toEqual(before.config.routing);
  expect(after.capture).toEqual(before.capture);
});
it('keeps adopted policy fallbacks as graph references and leaves unrelated manual drafts unapplied', () => {
  const { stash } = runtimeFixture();
  const provider = stash.groups[0];
  let graph = createPolicyExample();
  const group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  group.data.settings.selection = 'subscription';
  group.data.settings.sources = JSON.stringify({
    ...emptyPolicySources(),
    subscriptions: [subscriptionSource(provider)],
    fallback: { type: 'node', nodeId: 'test-block' },
  });
  graph = refreshAppliedSubscriptions(graph, stash);
  const adopted = syncGraphEdits(graph, graph, stash, true),
    before = compileRuntimeGraph(adopted.graph);
  const next = materializeRefresh(
    adopted.stash,
    prepareRefresh({
      stash: adopted.stash,
      graph: adopted.graph,
      replaceId: provider.id,
      name: provider.name,
      text: 'socks://192.0.2.1:2080#Linked',
    }),
  );
  const manual = adopted.graph.nodes.find((n) => n.id === 'test-first')!,
    link = manual.data.stashLink!;
  const dirty = {
    ...next,
    groups: next.groups.map((g) =>
      g.id !== link.groupId
        ? g
        : {
            ...g,
            entries: g.entries.map((e) =>
              e.id !== link.entryId
                ? e
                : {
                    ...e,
                    profile: {
                      ...e.profile!,
                      settings: { ...e.profile!.settings, redirect: '192.0.2.99:9999' },
                    },
                    draft: {
                      ...e.draft!,
                      settings: { ...e.draft!.settings, redirect: '192.0.2.99:9999' },
                    },
                  },
            ),
          },
    ),
  };
  const refreshed = refreshAppliedSubscriptions(adopted.graph, dirty, new Set([provider.id]));
  const after = compileRuntimeGraph(refreshed);
  expect(refreshed.nodes.find((n) => n.id === manual.id)!.data.settings.redirect).toBe(
    manual.data.settings.redirect,
  );
  expect((after.config.outbounds as Record<string, unknown>[]).map((o) => o.tag)).toEqual(
    (before.config.outbounds as Record<string, unknown>[]).map((o) => o.tag),
  );
  expect(after.config.observatory).toEqual(before.config.observatory);
  expect(after.config.routing).toEqual(before.config.routing);
  const ui = refreshPolicyGraph(syncStashEdits(adopted.graph, adopted.stash, next), next);
  expect(readPolicySources(ui.nodes.find((n) => n.id === group.id)!.data).fallback).toEqual({
    type: 'node',
    nodeId: 'test-block',
  });
});
