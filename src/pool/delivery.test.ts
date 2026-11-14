// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { createProxyStarter } from '../graph/examples';
import { parseGraph, serializeGraph } from '../graph/model';
import { compileRuntimeGraph } from '../graph/runtime';
import { readRuleTable, tableSettings } from '../graph/rules';
import { readDnsFilter, dnsFilterSettings } from '../graph/dns';
import { parseEntry, parseStash, serializeStash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { capturePoolGraph, preparePoolWorkspace } from './model';
import { prepareDelivery, type Member, type Publisher } from './publisher';
import { resolvePoolDelivery } from './delivery';
import { subscriptionEngine } from '../profiles/serviceEngine';
import type { ObservedServer } from './accounts';
import { applyStashedEntry } from '../profiles/graph';
import { openGraphLayer } from './graphLayer';

const stash = { format: 'wayrill.stash' as const, version: 3 as const, groups: [] };
const recipient = '0123456789abcdef0123456789abcdef';

it('publishes the guided starter and compiles the subscriber’s assigned capture path', () => {
  const { graph, stash } = openGraphLayer(undefined, 'traffic');
  const member: Member = { id: 'alice', name: 'Alice', invite: '', configurationId: 'first' };
  const pool: Publisher = {
    id: 'pool',
    name: 'Office Pool',
    folder: 'C:\\Pool',
    members: [member],
    configurations: [{ id: 'first', bundle: capturePoolGraph('Main routing', graph, stash, []) }],
  };
  const delivery = prepareDelivery(pool, member, []);
  const { bundle } = resolvePoolDelivery(delivery);
  const published = parseGraph(bundle.graph);
  const targetKind = (output: string) => {
    const edge = published.edges.find(
      ({ source, sourceHandle }) => source === 'traffic-rules' && sourceHandle === output,
    );
    return published.nodes.find(({ id }) => id === edge?.target)?.data.kind;
  };
  expect(delivery.poolName).toBe('Office Pool');
  expect(published.nodes.find(({ id }) => id === 'direct')?.data.poolOutbound).toBe(true);
  expect(targetKind('default')).toBe('direct-outbound');
  expect(targetKind('preferred')).toBe('block-outbound');
  expect(
    subscriptionEngine({
      operation: 'poolPrepare',
      stash: '',
      capture: 'proxy',
      bundle: delivery,
      recipient,
      bindings: { proxy: 'proxy' },
    }),
  ).toMatchObject({
    config: { inbounds: [expect.objectContaining({ protocol: 'mixed' })] },
  });
});

function fixture() {
  const graph = createProxyStarter();
  const inbound = graph.nodes.find((node) => node.id === 'proxy') ?? graph.nodes[0];
  const outbound = graph.nodes.find((node) => node.data.kind === 'direct-outbound')!;
  outbound.data.poolOutbound = true;
  const traffic = makeNode('routing-filter', { x: 2, y: 2 }, 'rules');
  const dns = makeNode('dns-routing-filter', { x: 5, y: 5 }, 'dns-rules');
  const handler = makeNode('dns-handler', { x: 8, y: 8 }, 'handler');
  const resolver = makeNode('dns-servers', { x: 10, y: 10 }, 'resolver');
  graph.nodes.push(traffic, dns, handler, resolver);
  const table = readRuleTable(traffic.data.settings);
  const filter = readDnsFilter(dns.data.settings);
  const wired = (source: string, port: string, target = outbound.id) => ({
    id: source + '-' + port,
    source,
    sourceHandle: port,
    target,
    targetHandle: 'in',
  });
  graph.edges.push(...table.outputs.map(({ id }) => wired(traffic.id, id)));
  graph.edges = graph.edges.filter(
    (edge) => edge.source !== inbound.id || edge.sourceHandle !== 'dns',
  );
  graph.edges.push(
    wired(inbound.id, 'dns', handler.id),
    wired(handler.id, 'resolver', dns.id),
    wired(dns.id, filter.outputs[0].id, resolver.id),
    wired(resolver.id, 'queries'),
  );
  const first = capturePoolGraph('Default', graph, stash, [], [inbound.id]);
  traffic.data.settings = tableSettings({
    ...table,
    defaultOutput: 'secondary',
    outputs: table.outputs.map((port) =>
      port.id === table.defaultOutput ? { ...port, id: 'secondary' } : port,
    ),
  });
  dns.data.settings = dnsFilterSettings({
    ...filter,
    outputs: [{ id: 'fallback-two', name: 'Fallback', fallback: true }],
  });
  graph.edges = graph.edges.map((edge) =>
    edge.source === traffic.id && edge.sourceHandle === table.defaultOutput
      ? { ...edge, sourceHandle: 'secondary' }
      : edge.source === dns.id
        ? { ...edge, sourceHandle: 'fallback-two' }
        : edge,
  );
  const second = capturePoolGraph('Second', graph, stash, [], [inbound.id]);
  const group = (entry: string) => ({
    ...defaultGroup(),
    entries: [{ ...parseEntry('socks://test:fixture@proxy.example.test:1080'), id: entry }],
  });
  const member: Member = {
    id: 'alice',
    name: 'Alice',
    invite: '',
    configurationId: 'first',
    graphIds: ['second'],
    layerIds: ['one', 'two', 'traffic', 'dns'],
    accounts: [{ server: 'edge', account: 'alice-id' }],
  };
  const pool: Publisher = {
    id: 'pool',
    name: 'Pool',
    folder: 'C:\\Pool',
    members: [member],
    configurations: [
      { id: 'first', bundle: first },
      { id: 'second', bundle: second },
    ],
    layers: [
      {
        id: 'one',
        name: 'First Stash',
        data: { kind: 'stash', stash: serializeStash({ ...stash, groups: [group('one-entry')] }) },
      },
      {
        id: 'two',
        name: 'Second Stash',
        data: { kind: 'stash', stash: serializeStash({ ...stash, groups: [group('two-entry')] }) },
      },
      {
        id: 'traffic',
        name: 'Traffic rules',
        data: { kind: 'traffic', filter: { nodeId: traffic.id, table } },
      },
      { id: 'dns', name: 'DNS rules', data: { kind: 'dns', nodeId: dns.id, filter } },
      {
        id: 'private',
        name: 'Unassigned',
        data: {
          kind: 'stash',
          stash: serializeStash({ ...stash, groups: [group('hidden-entry')] }),
        },
      },
    ],
  };
  const servers: ObservedServer[] = [
    {
      id: 'edge',
      name: 'Edge',
      path: '/etc/xray/config.json',
      host: 'edge.example.test',
      skipped: [],
      accounts: ['alice', 'bob'].map((name) => ({
        id: name + '-id',
        name,
        inbound: 'VLESS',
        revision: '1',
        outbound: {
          protocol: 'vless',
          settings: {
            address: 'edge.example.test',
            port: 443,
            id: name + '-secret',
            encryption: 'none',
          },
        },
      })),
    },
  ];
  return { pool, member, servers, inbound, outbound, traffic, dns };
}

it('applies graph and user settings without replacing subscriber defaults and restores them when removed', () => {
  const { pool, member, servers, inbound } = fixture();
  pool.configurations[0].bundle.settings = {
    routingDomainStrategy: 'IPIfNonMatch',
    udpListenerReceiveKiB: 768,
  };
  pool.configurations[1].bundle.settings = { routingDomainStrategy: 'AsIs' };
  const user = { ...member, settings: { logLevel: 'error', udpListenerReceiveKiB: 0 } };
  const local = createProxyStarter();
  local.defaults!.settings.udpListenerReceiveKiB = 384;
  local.defaults!.settings.logLevel = 'info';
  local.defaults!.settings.maskAddress = 'half';
  const request = {
    operation: 'poolPrepare' as const,
    stash: '',
    recipient,
    capture: 'current' as const,
    bindings: { proxy: inbound.id },
    appliedGraph: serializeGraph(local),
  };
  const delivery = prepareDelivery(pool, user, servers);
  expect(delivery.version).toBe(2);
  expect(prepareDelivery(pool, member, servers).graphs[0].bundle.settings).toEqual({
    routingDomainStrategy: 'IPIfNonMatch',
    udpListenerReceiveKiB: 768,
  });
  expect(resolvePoolDelivery(delivery, { graph: 'second' }).bundle.settings).toEqual({
    routingDomainStrategy: 'AsIs',
    logLevel: 'error',
    udpListenerReceiveKiB: 0,
  });
  const first = subscriptionEngine({ ...request, bundle: delivery });
  expect(first).toMatchObject({
    config: {
      log: { loglevel: 'error', maskAddress: 'half' },
      routing: { domainStrategy: 'IPIfNonMatch' },
      env: { WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '0' },
    },
  });
  if (!('graph' in first) || !first.graph) throw new Error('Missing applied graph');
  const applied = parseGraph(first.graph);
  expect(applied.defaults?.settings).toEqual(local.defaults?.settings);
  expect(compileRuntimeGraph(applied).config).toMatchObject({
    log: { loglevel: 'error', maskAddress: 'half' },
  });

  for (const { bundle } of pool.configurations) delete bundle.settings;
  const update = prepareDelivery(pool, member, servers);
  expect(update.version).toBe(1);
  const restored = subscriptionEngine({ ...request, appliedGraph: first.graph, bundle: update });
  expect(restored).toMatchObject({
    config: {
      log: { loglevel: 'info', maskAddress: 'half' },
      routing: { domainStrategy: 'AsIs' },
      env: { WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '393216' },
    },
  });
});

it('rejects nonportable or invalid settings from a published graph before subscriber activation', () => {
  const { pool, member, servers } = fixture();
  const delivery = prepareDelivery(pool, member, servers);
  const supplied = (settings: unknown) => ({
    ...delivery,
    version: 2,
    graphs: delivery.graphs.map((item) => ({ ...item, bundle: { ...item.bundle, settings } })),
  });
  expect(() => resolvePoolDelivery(supplied({ interface: 'Ethernet' }))).toThrow(
    'cannot be managed by a Pool',
  );
  expect(() => resolvePoolDelivery(supplied({ udpListenerSendKiB: -1 }))).toThrow(
    'UDP listener send buffer',
  );
});

it('delivers only assigned choices and uses stable selections on each subscriber machine', () => {
  const { pool, member, servers, inbound, outbound, traffic, dns } = fixture();
  const delivery = prepareDelivery(pool, member, servers);
  expect(JSON.stringify(delivery)).toContain('alice-secret');
  expect(JSON.stringify(delivery)).not.toMatch(/bob-secret|hidden-entry/);
  const defaults = resolvePoolDelivery(delivery, undefined, true);
  expect(defaults.selection?.graph).toBe('first');
  expect(defaults.options?.graphs.map(({ id }) => id)).toEqual(['first', 'second']);
  expect(defaults.options?.stashes).toHaveLength(2);
  const selection = {
    graph: 'second',
    stashes: ['one', 'two'],
    filters: { [traffic.id]: 'traffic', [dns.id]: 'dns' },
    outbounds: { [outbound.id]: { groupId: defaultGroup().id, entryId: 'two-entry' } },
  };
  const { bundle } = resolvePoolDelivery(delivery, selection);
  const resolved = parseGraph(bundle.graph);
  expect(resolved.nodes.find(({ id }) => id === outbound.id)?.data.kind).toBe('socks-outbound');
  expect(
    readRuleTable(resolved.nodes.find(({ id }) => id === traffic.id)!.data.settings).defaultOutput,
  ).toBe('secondary');
  expect(
    readDnsFilter(resolved.nodes.find(({ id }) => id === dns.id)!.data.settings).outputs[0].id,
  ).toBe('fallback-two');
  expect(
    parseStash(bundle.stash).groups.flatMap(({ entries }) => entries.map(({ id }) => id)),
  ).toEqual(expect.arrayContaining(['one-entry', 'two-entry']));
  const prepared = preparePoolWorkspace(bundle, undefined, stash, recipient, 'proxy', {
    proxy: inbound.id,
  });
  expect(
    prepared.graph.nodes.find(({ id }) => id === outbound.id)?.data.poolOutbound,
  ).toBeUndefined();
  const request = {
    operation: 'poolInspect' as const,
    stash: '',
    capture: 'proxy' as const,
    bundle: delivery,
    poolSelection: selection,
  };
  expect(subscriptionEngine(request)).toMatchObject({ poolEntries: { selection } });
  const preparedByService = subscriptionEngine({
    ...request,
    operation: 'poolPrepare',
    recipient,
    bindings: { proxy: inbound.id },
  });
  expect(preparedByService).toMatchObject({
    poolSelection: selection,
    config: { outbounds: expect.arrayContaining([expect.objectContaining({ protocol: 'socks' })]) },
  });

  const updated = { ...delivery, layers: delivery.layers.filter(({ id }) => id !== 'two') };
  expect(() => resolvePoolDelivery(updated, selection)).toThrow('selected Stash');
  expect(resolvePoolDelivery(updated, selection, true).options?.reviewRequired).toBe(true);
  const removedFilter = {
    ...delivery,
    layers: delivery.layers.filter(({ id }) => id !== 'traffic'),
  };
  const { choiceNames } = resolvePoolDelivery(delivery, selection);
  expect(() => resolvePoolDelivery(removedFilter, selection, false, choiceNames)).toThrow(
    /Traffic rules.*Routing filter.*no longer available/,
  );
  expect(
    resolvePoolDelivery(removedFilter, selection, true, choiceNames).options?.unavailable,
  ).toEqual([expect.stringContaining('Traffic rules')]);
});

it('keeps the subscriber outbound slot through a linked Stash rebuild and graph-layer resave', () => {
  const { pool, member, servers, outbound } = fixture();
  const { graph } = openGraphLayer(pool.configurations[1].bundle);
  const node = graph.nodes.find(({ id }) => id === outbound.id)!;
  const entry = parseEntry('socks://test:fixture@proxy.example.test:1080');
  const rebuilt = applyStashedEntry(graph, entry, node, {
    groupId: defaultGroup().id,
    entryId: entry.id,
  });
  pool.configurations[1].bundle = capturePoolGraph('Second', rebuilt, stash, []);
  const delivery = prepareDelivery(pool, member, servers);
  const resolved = resolvePoolDelivery(delivery, {
    graph: 'second',
    stashes: ['one'],
    outbounds: { [outbound.id]: { groupId: defaultGroup().id, entryId: 'one-entry' } },
  });
  expect(resolved.selection?.outbounds?.[outbound.id]?.entryId).toBe('one-entry');
});

it('requires separate Aquifer accounts for different Pool users', () => {
  const { pool, member, servers } = fixture();
  expect(() =>
    prepareDelivery(
      {
        ...pool,
        members: [member, { ...member, id: 'bob' }],
      },
      member,
      servers,
    ),
  ).toThrow('assigned to another user');
});

it('rejects publication when an alternate graph has a disconnected traffic filter', () => {
  const { pool, member, servers, traffic } = fixture();
  const second = pool.configurations[1].bundle;
  const graph = parseGraph(second.graph);
  graph.edges = graph.edges.filter(({ source }) => source !== traffic.id);
  pool.configurations[1].bundle = capturePoolGraph('Second', graph, stash, []);
  expect(() => prepareDelivery(pool, member, servers)).toThrow(/“Second”.*Connect.*path/);
});
