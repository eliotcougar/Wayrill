import { makeNode } from '../graph/catalog';
import { parseEntry } from '../profiles/import';
import { policyProfileId, readPolicySources, subscriptionSource } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import { expect, it } from 'vitest';
import { bundledExamples, createProxyStarter } from '../graph/examples';
import { analyzeGraph } from '../graph/analysis';
import { parseGraph, serializeGraph } from '../graph/model';
import { defaultGroup } from '../profiles/stashModel';
import type { Stash, StashGroup } from '../profiles/import';
import {
  capturePoolBundle,
  capturePoolGraph,
  followPoolGraph,
  poolGroupId,
  poolInputs,
  poolRoutingState,
  preparePoolWorkspace,
} from './model';
import { readRuleTable, tableSettings, type TableRule } from '../graph/rules';
import { compileRuntimeGraph } from '../graph/runtime';

const recipient = '0123456789abcdef0123456789abcdef';
const library = (groups: StashGroup[]): Stash => ({ format: 'wayrill.stash', version: 3, groups });

it('follows a new Pool delivery while carrying local inputs, layout and draft personal rules', () => {
  const provider = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const publish = (name: string) =>
    capturePoolGraph(name, provider, library([]), [], [poolInputs(provider)[0].id]);
  const initial = preparePoolWorkspace(
    publish('Original graph'),
    undefined,
    library([]),
    recipient,
    'proxy',
  );
  const draft = structuredClone(initial.graph);
  const localProxy = poolInputs(draft)[0];
  localProxy.data.settings.port = 12345;
  draft.viewport = { x: 50, y: 60, zoom: 0.9 };
  const filter = draft.nodes.find(({ data }) => data.kind === 'routing-filter')!;
  filter.position.x += 200;
  const rules = readRuleTable(filter.data.settings);
  rules.rules.push({
    id: 'local',
    name: 'Local rule',
    enabled: true,
    matchAll: false,
    conditions: { domain: 'full:local.example' },
    output: rules.defaultOutput,
    poolPlacement: 'before',
  });
  Object.assign(filter.data.settings, tableSettings(rules));
  const sharedFilter = provider.nodes.find(({ id }) => id === filter.id)!;
  const sharedRules = readRuleTable(sharedFilter.data.settings);
  sharedRules.rules.push({
    id: 'updated',
    name: 'Updated rule',
    enabled: true,
    matchAll: false,
    conditions: { domain: 'full:new.example' },
    output: sharedRules.defaultOutput,
  });
  Object.assign(sharedFilter.data.settings, tableSettings(sharedRules));
  provider.nodes.push(makeNode('block-outbound', { x: 600, y: 400 }, 'new-block'));
  const updated = preparePoolWorkspace(
    publish('Updated graph'),
    initial.graph,
    initial.stash,
    recipient,
    'current',
    initial.bindings,
  );
  {
    const editor = followPoolGraph(updated.graph, draft, initial.graph);
    expect(editor.name).toBe('Updated graph');
    expect(editor.viewport).toEqual(draft.viewport);
    expect(editor.nodes.find(({ id }) => id === 'new-block')?.position).toEqual({ x: 600, y: 400 });
    expect(poolInputs(editor)[0].data.settings.port).toBe(12345);
    const updatedFilter = editor.nodes.find(({ id }) => id === filter.id)!;
    expect(updatedFilter.position).toEqual(filter.position);
    const merged = readRuleTable(updatedFilter.data.settings).rules;
    expect(merged[0].id).toBe('local');
    expect(merged.at(-1)?.id).toBe('updated');
  }
  const cold = followPoolGraph(updated.graph, draft);
  expect(poolInputs(cold)[0].data.settings.port).toBe(
    poolInputs(updated.graph)[0].data.settings.port,
  );
  expect(cold.nodes.find(({ id }) => id === filter.id)?.position).toEqual(filter.position);
});

it('applies personal precedence around the updated Pool rules and rejects missing outputs', () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const provider = graph.nodes.find(({ data }) => data.kind === 'routing-filter')!;
  const capture = () => capturePoolGraph('Pool', graph, library([]), [], [poolInputs(graph)[0].id]);
  const initial = preparePoolWorkspace(capture(), undefined, library([]), recipient, 'proxy', {
    proxy: poolInputs(graph)[0].id,
  }).graph;
  const baseline = poolRoutingState(initial);
  const filter = initial.nodes.find(({ id }) => id === provider.id)!;
  const table = readRuleTable(filter.data.settings);
  const output = table.outputs.find(({ id }) => id !== table.defaultOutput)!;
  const rule = (id: string, placement: TableRule['poolPlacement']): TableRule => ({
    id,
    name: id,
    enabled: true,
    matchAll: false,
    conditions: { domain: 'full:pool-precedence.example' },
    output: output.id,
    poolPlacement: placement,
  });
  table.rules.push(rule('personal-after', 'after'), rule('personal-before', 'before'));
  filter.data.settings = { ...filter.data.settings, ...tableSettings(table) };
  const applied = parseGraph(serializeGraph(initial));
  expect(poolRoutingState(applied)).toEqual(baseline);
  expect(
    capturePoolGraph('Exported Pool', applied, library([]), [], ['proxy']).graph,
  ).not.toContain('personal-before');

  const next = readRuleTable(provider.data.settings);
  next.rules = [{ ...rule('published', undefined), output: next.defaultOutput }];
  provider.data.settings = { ...provider.data.settings, ...tableSettings(next) };
  const newBundle = capture();
  const updated = preparePoolWorkspace(newBundle, applied, library([]), recipient, 'current', {
    proxy: poolInputs(graph)[0].id,
  }).graph;
  const runtime = compileRuntimeGraph(updated).config.routing as {
    rules: { domain?: string[]; outboundTag?: string }[];
  };
  const matches = runtime.rules.filter(({ domain }) =>
    domain?.includes('full:pool-precedence.example'),
  );
  expect(matches).toHaveLength(3);
  expect(matches[0].outboundTag).toBe(matches[2].outboundTag);
  expect(matches[0].outboundTag).not.toBe(matches[1].outboundTag);

  next.outputs = next.outputs.filter(({ id }) => id !== output.id);
  provider.data.settings = { ...provider.data.settings, ...tableSettings(next) };
  graph.edges = graph.edges.filter(
    ({ source, sourceHandle }) => source !== provider.id || sourceHandle !== output.id,
  );
  expect(() => preparePoolWorkspace(capture(), updated, library([]), recipient, 'current')).toThrow(
    `Personal rule “personal-before” in “${filter.data.label}” uses unavailable output “${output.name}”`,
  );
});

it('recognizes applied changes to Pool routes while allowing device settings and canvas edits', () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const prepared = preparePoolWorkspace(
    capturePoolBundle('Pool', graph, library([]), [], poolInputs(graph)[0].id),
    undefined,
    library([]),
    recipient,
    'proxy',
  ).graph;
  const applied = parseGraph(serializeGraph(prepared));
  const state = poolRoutingState(applied);
  const input = poolInputs(applied)[0];
  input.data.settings.port = 12081;
  input.data.label = 'Personal proxy';
  input.position.x += 120;
  expect(poolRoutingState(applied)).toEqual(state);
  const filter = applied.nodes.find(({ data }) => data.kind === 'routing-filter')!;
  filter.data.settings.rules = '[]';
  expect(poolRoutingState(applied)).not.toEqual(state);
});

it('replaces routing without publishing the administrator’s inputs or changing the subscriber’s capture', () => {
  const provider = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const input = poolInputs(provider)[0];
  const group = {
    ...defaultGroup(),
    id: 'admin',
    name: 'Assigned',
    url: 'https://example.invalid/private',
    headers: { Authorization: 'secret' },
  };
  const bundle = capturePoolBundle(
    'Assigned routes',
    provider,
    library([group]),
    ['admin'],
    input.id,
  );
  expect(JSON.parse(bundle.graph)).not.toHaveProperty('captureOptions');
  expect(bundle.stash).not.toContain('example.invalid');
  expect(bundle.stash).not.toContain('Authorization');

  const device = createProxyStarter();
  device.nodes[0].data.settings.port = 12081;
  const ordinary = {
    ...defaultGroup(),
    id: 'ordinary',
    name: 'Local subscription',
    url: 'https://example.invalid/local',
  };
  const prepared = preparePoolWorkspace(bundle, device, library([ordinary]), recipient, 'current');
  expect(
    prepared.graph.nodes.find((node) => node.data.kind === 'proxy-inbound')?.data.settings.port,
  ).toBe(12081);
  expect(prepared.graph.nodes.some((node) => node.data.kind === 'routing-filter')).toBe(true);
  expect(prepared.stash.groups).toEqual([
    ordinary,
    expect.objectContaining({ id: poolGroupId(recipient, 'admin'), url: '' }),
  ]);
  expect(parseGraph(serializeGraph(prepared.graph)).poolId).toBe(recipient);
  expect(analyzeGraph(prepared.graph).compilation).not.toBeNull();

  const replacement = capturePoolBundle(
    'New routes',
    createProxyStarter(),
    library([]),
    [],
    'proxy',
  );
  const refreshed = preparePoolWorkspace(
    replacement,
    prepared.graph,
    prepared.stash,
    recipient,
    'current',
  );
  expect(refreshed.stash.groups).toEqual([ordinary]);
  expect(
    refreshed.graph.nodes.find((node) => node.data.kind === 'proxy-inbound')?.data.settings.port,
  ).toBe(12081);
  expect(refreshed.graph.nodes.some((node) => node.data.kind === 'routing-filter')).toBe(false);
});

it('binds DNS and traffic separately when an administrator’s routing is used with local TUN', () => {
  const provider = bundledExamples.find((item) => item.id === 'tun')!.create();
  const bundle = capturePoolBundle(
    'TUN template',
    provider,
    library([]),
    [],
    poolInputs(provider)[0].id,
  );
  const prepared = preparePoolWorkspace(
    bundle,
    undefined,
    library([defaultGroup()]),
    recipient,
    'tun',
  );
  const input = prepared.graph.nodes.find((node) => node.data.kind === 'tun-inbound')!;
  const data = prepared.graph.edges.find(
    (edge) => edge.source === input.id && edge.sourceHandle === 'traffic',
  );
  const dns = prepared.graph.edges.find(
    (edge) => edge.source === input.id && edge.sourceHandle === 'dns',
  );
  expect(data?.target).toBe(bundle.routes.data);
  expect(dns?.target).toBe(bundle.routes.dns);
  expect(dns?.target).not.toBe(data?.target);
  const analysis = analyzeGraph(prepared.graph);
  expect(analysis.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
});

it('isolates policy and chain links from a local subscription with the same original identity', () => {
  const provider = createProxyStarter();
  const published = { ...defaultGroup(), id: 'provider', name: 'Assigned' };
  const entry = parseEntry('socks://198.51.100.1:1080#Published');
  published.entries.push(entry);
  const policy = makeNode('policy-group', { x: 0, y: 0 }, 'managed-policy');
  policy.data.settings.sources = JSON.stringify({
    version: 1,
    manual: [],
    subscriptions: [
      subscriptionSource(published),
      { ...subscriptionSource({ ...published, id: 'retired', entries: [] }), missing: true },
    ],
  });
  const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'managed-chain');
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      {
        id: 'first',
        outbound: {
          type: 'profile',
          id: policyProfileId(entry.profile!),
          name: entry.name,
          profile: entry.profile,
          source: { groupId: published.id, entryId: entry.id },
        },
      },
    ],
  });
  provider.nodes.push(policy, chain);
  const local = { ...published, entries: [parseEntry('socks://198.51.100.2:1080#Local')] };
  const bundle = capturePoolBundle('Managed', provider, library([published]), [], 'proxy');
  const retired = { ...local, id: 'retired' };
  const prepared = preparePoolWorkspace(
    bundle,
    undefined,
    library([local, retired]),
    recipient,
    'proxy',
  );
  const groupId = poolGroupId(recipient, published.id);
  const policyNode = prepared.graph.nodes.find((node) => node.id === policy.id)!;
  const [source, missing] = readPolicySources(policyNode.data).subscriptions;
  expect(missing).toMatchObject({
    groupId: poolGroupId(recipient, retired.id),
    missing: true,
    entries: [],
  });
  expect(source.groupId).toBe(groupId);
  expect(source.entries.map((candidate) => candidate.name)).toEqual(['Published']);
  const chainNode = prepared.graph.nodes.find((node) => node.id === chain.id)!;
  expect(readProxyChain(chainNode.data).steps[0].outbound).toMatchObject({
    source: { groupId, entryId: entry.id },
  });
  expect(prepared.stash.groups[0]).toEqual(local);
});
