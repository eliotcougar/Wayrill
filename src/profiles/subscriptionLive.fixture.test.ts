import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { makeNode, makeProxyInbound } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { compileRuntimeGraph } from '../graph/runtime';
import { serializeGraph } from '../graph/model';
import {
  policyProfile,
  emptyPolicySources,
  subscriptionSource,
  refreshPolicyGraph,
} from '../graph/policySources';
import { tableSettings } from '../graph/rules';
import { importProfiles, serializeStash, type Stash } from './import';
import { maintenanceDefaults } from './subscriptionState';
import type { GraphState } from '../graph/types';
it('compiles the installed live-replacement scenario with a shared profile, observed group and chain', () => {
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://127.0.0.1:19285#QA%20Linked', 'QA live provider').groups,
  };
  const provider = stash.groups[0];
  provider.url = 'http://127.0.0.1:19125/sub';
  provider.allowHttp = true;
  provider.maintenance = { ...maintenanceDefaults, autoRefresh: false, refreshMinutes: 1 };
  const entry = provider.entries[0],
    link = { groupId: provider.id, entryId: entry.id };
  const proxy = makeProxyInbound('mixed', { x: 30, y: 200 }, 'qa-input');
  proxy.data.settings.port = 19128;
  proxy.data.settings.tag = 'qa-input';
  const single = makeNode('socks-outbound', { x: 850, y: 30 }, 'qa-single');
  Object.assign(single.data.settings, entry.profile!.settings, { tag: 'qa-single' });
  single.data.label = 'QA linked outbound';
  single.data.stashLink = link;
  const block = makeNode('block-outbound', { x: 850, y: 500 }, 'qa-block');
  block.data.settings.tag = 'qa-block';
  const group = makeNode('policy-group', { x: 850, y: 185 }, 'qa-group');
  Object.assign(group.data.settings, {
    tag: 'qa-group',
    observe: true,
    fallbackEnabled: true,
    selection: 'subscription',
    sources: JSON.stringify({
      ...emptyPolicySources(),
      subscriptions: [subscriptionSource(provider)],
      fallback: { type: 'node', nodeId: block.id },
    }),
  });
  const observation = makeNode('observatory', { x: 1220, y: 190 }, 'qa-observer');
  Object.assign(observation.data.settings, {
    probeURL: 'http://172.30.187.151:19129/health',
    probeInterval: '2s',
    enableConcurrency: true,
  });
  const chain = makeNode('proxy-chain', { x: 850, y: 350 }, 'qa-chain');
  chain.data.settings.tag = 'qa-chain';
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'entry', outbound: policyProfile(entry, link) },
      { id: 'exit', outbound: { type: 'node', nodeId: single.id } },
    ],
  });
  const filter = makeNode('routing-filter', { x: 400, y: 200 }, 'qa-filter');
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'single', name: 'Single' },
        { id: 'group', name: 'Policy' },
        { id: 'chain', name: 'Chain' },
        { id: 'deny', name: 'Blocked' },
      ],
      rules: ['single', 'group', 'chain'].map((output, i) => ({
        id: output,
        name: output,
        enabled: true,
        output,
        matchAll: false,
        conditions: { port: String(19129 + i) },
      })),
      defaultOutput: 'deny',
    }),
  );
  const wire = (source: string, sourceHandle: string, target: string) => ({
    id: source + '-' + sourceHandle + '-' + target,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  const graph = refreshPolicyGraph(
    {
      name: 'Live subscription replacement QA',
      defaults: factoryDefaults(),
      nodes: [proxy, filter, single, group, chain, block, observation],
      edges: [
        wire(proxy.id, 'data', filter.id),
        wire(proxy.id, 'dns', block.id),
        wire(filter.id, 'single', single.id),
        wire(filter.id, 'group', group.id),
        wire(filter.id, 'chain', chain.id),
        wire(filter.id, 'deny', block.id),
        wire(group.id, 'observation', observation.id),
      ],
    } satisfies GraphState,
    stash,
  );
  const config = compileRuntimeGraph(graph).config;
  expect(config.observatory).toBeDefined();
  const outbounds = config.outbounds as Record<string, unknown>[];
  expect(outbounds.find((outbound) => outbound.tag === 'qa-single')).toMatchObject({
    protocol: 'socks',
    settings: { address: '127.0.0.1', port: 19285 },
  });
  const routing = config.routing as { rules: Record<string, unknown>[] };
  expect(routing.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ port: '19129', outboundTag: 'qa-single' }),
      expect.objectContaining({ port: '19130', balancerTag: 'qa-group' }),
      expect.objectContaining({ port: '19131', outboundTag: 'qa-chain' }),
    ]),
  );
  if (process.env.WAYRILL_LIVE_FIXTURE_DIR) {
    writeFileSync(
      process.env.WAYRILL_LIVE_FIXTURE_DIR + '/fixture.wayrill.json',
      serializeGraph(graph),
    );
    writeFileSync(
      process.env.WAYRILL_LIVE_FIXTURE_DIR + '/fixture.stash.json',
      serializeStash(stash),
    );
  }
});
