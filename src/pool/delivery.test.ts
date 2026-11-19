// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { createDnsExample } from '../graph/example';
import { createProxyStarter } from '../graph/examples';
import { parseGraph, serializeGraph } from '../graph/model';
import { cloneJson } from '../graph/xrayJson';
import { poolResourceSettings } from '../graph/poolSettings';
import { factoryResources, resourceDependencies, selectResource } from '../graph/resources';
import { compileRuntimeGraph } from '../graph/runtime';
import { readRuleTable, tableSettings } from '../graph/rules';
import { readDnsFilter, dnsFilterSettings } from '../graph/dns';
import { parseEntry, parseStash, serializeStash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { capturePoolGraph, poolGroupId, preparePoolWorkspace, poolRoutingState } from './model';
import { applyPoolPreferences, personalSettingChoices } from './preferences';
import { prepareDelivery, type Member, type Publisher } from './publisher';
import { resolvePoolDelivery } from './delivery';
import { encodePoolDelivery } from './deliveryCompatibility';
import { subscriptionEngine } from '../profiles/serviceEngine';
import type { ObservedServer } from './accounts';
import { applyStashedEntry } from '../profiles/graph';
import { openGraphLayer } from './graphLayer';

const stash = { format: 'wayrill.stash' as const, version: 3 as const, groups: [] };
const recipient = '0123456789abcdef0123456789abcdef';

it('offers per-user Windows layers through the compatibility extension and applies only selected layers', () => {
  const starter = openGraphLayer(undefined, 'direct');
  const family = 'Microsoft.WindowsStore_8wekyb3d8bbwe';
  const app = { kind: 'executable' as const, value: 'C:\\Apps\\External\\client.exe' };
  const member: Member = {
    id: 'alice',
    name: 'Alice',
    invite: '',
    configurationId: 'first',
    layerIds: ['loop', 'protect'],
  };
  const other = { ...member, id: 'bob', layerIds: ['protect'] };
  const pool: Publisher = {
    id: 'pool',
    name: 'Pool',
    folder: 'C:\\Pool',
    members: [member, other],
    configurations: [
      { id: 'first', bundle: capturePoolGraph('Main', starter.graph, starter.stash, []) },
    ],
    layers: [
      { id: 'loop', name: 'Local proxy access', data: { kind: 'loopback', packages: [family] } },
      {
        id: 'protect',
        name: 'Client protection',
        data: { kind: 'app-protection', protection: { enabled: true, applications: [app] } },
      },
    ],
  };
  const alice = encodePoolDelivery(prepareDelivery(pool, member));
  const bob = encodePoolDelivery(prepareDelivery(pool, other));
  expect(alice.layers).toEqual([]);
  expect(alice.defaultLayers).toEqual([]);
  expect(
    resolvePoolDelivery(alice, undefined, true).options?.deviceLayers?.map(({ id }) => id),
  ).toEqual(['loop', 'protect']);
  expect(
    resolvePoolDelivery(bob, undefined, true).options?.deviceLayers?.map(({ id }) => id),
  ).toEqual(['protect']);
  expect(resolvePoolDelivery(alice).deviceSettings).toBeUndefined();
  const enrolled = resolvePoolDelivery(alice, { graph: 'first', deviceLayers: ['loop'] });
  expect(enrolled.deviceSettings).toEqual({
    loopback: [family],
    protection: { enabled: false, applications: [] },
  });
  const updated = encodePoolDelivery(
    prepareDelivery(
      {
        ...pool,
        layers: [
          {
            id: 'loop',
            name: 'Renamed',
            data: { kind: 'loopback', packages: [family, 'Uninstalled.Test_123456789abcd'] },
          },
          pool.layers![1],
        ],
      },
      member,
    ),
  );
  expect(resolvePoolDelivery(updated, enrolled.selection).deviceSettings?.loopback).toEqual([
    family,
    'Uninstalled.Test_123456789abcd',
  ]);
  expect(resolvePoolDelivery(bob, enrolled.selection).deviceSettings).toBeUndefined();
  const prepared = subscriptionEngine({
    operation: 'poolPrepare',
    bundle: alice,
    stash: '',
    capture: 'proxy',
    recipient,
    poolSelection: { graph: 'first', deviceLayers: ['protect'] },
  });
  expect(prepared).toHaveProperty('poolDeviceSettings', {
    loopback: [],
    protection: { enabled: true, applications: [app] },
  });
  if (!('graph' in prepared)) throw new Error('Expected a prepared Pool graph.');
  const rebind = subscriptionEngine({
    operation: 'poolPrepare',
    bundle: alice,
    stash: '',
    appliedGraph: prepared.graph,
    recipient,
    capture: 'current',
    poolSelection: { graph: 'first' },
  });
  expect(rebind).toHaveProperty('graph', prepared.graph);
  expect(rebind).toHaveProperty('poolDeviceSettings', undefined);
  expect(
    resolvePoolDelivery({ ...alice, extensions: undefined }, enrolled.selection).deviceSettings,
  ).toBeUndefined();
});

it('applies published geofile defaults to traffic and DNS while retaining subscriber defaults', () => {
  const graph = createDnsExample();
  graph.defaults = {
    ...factoryDefaults(),
    resources: selectResource(factoryResources(), 'packaged-ru-geosite', true),
  };
  const traffic = graph.nodes.find(({ id }) => id === 'routes')!;
  const table = readRuleTable(traffic.data.settings);
  table.rules[0].conditions.domain = 'geosite:ru-blocked';
  traffic.data.settings = tableSettings(table);
  const dns = graph.nodes.find(({ id }) => id === 'dns-routes')!;
  const filter = readDnsFilter(dns.data.settings);
  filter.rules[0].domains = 'geosite:ru-blocked';
  filter.rules[0].expectedIPs = 'geoip:ir';
  dns.data.settings = dnsFilterSettings(filter);
  const member: Member = {
    id: 'alice',
    name: 'Alice',
    invite: '',
    configurationId: 'work',
    settings: { geoIpFile: 'ir-geoip.dat' },
  };
  const exported = {
    ...capturePoolGraph('Work', graph, stash, [], ['socks']),
    settings: poolResourceSettings(graph),
  };
  const pool: Publisher = {
    id: 'pool',
    name: 'Pool',
    folder: 'C:\\Pool',
    members: [member],
    configurations: [{ id: 'work', bundle: exported }],
  };
  const local = createProxyStarter();
  local.defaults = {
    ...factoryDefaults(),
    resources: selectResource(factoryResources(), 'packaged-cn-geosite', true),
  };
  const prepared = subscriptionEngine({
    operation: 'poolPrepare',
    stash: '',
    appliedGraph: serializeGraph(local),
    bundle: prepareDelivery(pool, member),
    capture: 'proxy',
    recipient,
    bindings: { proxy: 'socks' },
  });
  expect(prepared).toHaveProperty('graph');
  if (!('graph' in prepared)) throw new Error('Expected a prepared Pool graph.');
  const enrolled = parseGraph(prepared.graph!);
  expect(enrolled.defaults?.resources).toEqual(local.defaults.resources);
  expect(enrolled.poolSettings).toEqual({
    geoSiteFile: 'ru-geosite.dat',
    geoIpFile: 'ir-geoip.dat',
  });
  const compiled = compileRuntimeGraph(enrolled);
  expect(compiled.config.routing).toMatchObject({
    rules: expect.arrayContaining([
      expect.objectContaining({ domain: ['ext:ru-geosite.dat:ru-blocked'] }),
    ]),
  });
  expect(compiled.config.dns).toMatchObject({
    servers: expect.arrayContaining([
      expect.objectContaining({
        domains: ['ext:ru-geosite.dat:ru-blocked'],
        expectedIPs: ['ext:ir-geoip.dat:ir'],
      }),
    ]),
  });
  expect(resourceDependencies(compiled.config)).toEqual(['ir-geoip.dat', 'ru-geosite.dat']);
  const personal = parseGraph(
    serializeGraph({
      ...enrolled,
      defaults: { ...enrolled.defaults!, localPoolSettings: ['geoSiteFile'] },
    }),
  );
  expect(resourceDependencies(compileRuntimeGraph(personal).config)).toEqual([
    'cn-geosite.dat',
    'ir-geoip.dat',
  ]);
  const inherited = preparePoolWorkspace(
    { ...exported, settings: undefined },
    enrolled,
    stash,
    recipient,
    'current',
    { proxy: 'socks' },
  ).graph;
  expect(resourceDependencies(compileRuntimeGraph(inherited).config)).toEqual([
    'cn-geosite.dat',
    'geoip.dat',
  ]);
});

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

function fixture(trafficId = 'rules') {
  const graph = createProxyStarter();
  const inbound = graph.nodes.find((node) => node.id === 'proxy') ?? graph.nodes[0];
  const outbound = graph.nodes.find((node) => node.data.kind === 'direct-outbound')!;
  outbound.data.poolOutbound = true;
  const traffic = makeNode('routing-filter', { x: 2, y: 2 }, trafficId);
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
  applied.defaults!.localPoolSettings = ['logLevel'];
  const personal = subscriptionEngine({
    ...request,
    bundle: delivery,
    appliedGraph: serializeGraph(applied),
  });
  expect(personal).toMatchObject({
    config: { log: { loglevel: 'info' }, env: { WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '0' } },
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

it('carries only authored node preferences, including across a matching publication, until reset', () => {
  const { pool, member, servers } = fixture();
  const bundle = prepareDelivery(pool, member, servers);
  const request = {
    operation: 'poolPrepare' as const,
    stash: '',
    capture: 'proxy' as const,
    recipient,
    bundle,
  };
  const first = subscriptionEngine(request);
  if (!('graph' in first) || !first.graph || !first.poolPreferenceBase)
    throw new Error('Expected Pool enrollment');
  const working = parseGraph(first.graph);
  const edited = parseGraph(first.graph);
  const handler = edited.nodes.find((n) => n.data.kind === 'dns-handler')!;
  handler.data.settings.queryStrategy = 'UseIPv6';
  handler.data.settings.hosts = JSON.stringify({ 'full:printer.home': '192.168.1.60' });
  const legacy = subscriptionEngine({
    ...request,
    operation: 'poolRoutingState',
    appliedGraph: serializeGraph(edited),
  });
  expect(legacy).toMatchObject({
    matchesPublication: true,
    poolPreferenceBase: first.poolPreferenceBase,
  });
  expect(poolRoutingState(edited, true)).toEqual(poolRoutingState(working, true));
  const published = parseGraph(first.graph);
  const newHandler = published.nodes.find((n) => n.id === handler.id)!;
  newHandler.data.settings.disableCache = true;
  newHandler.data.settings.hosts = JSON.stringify({ 'full:resolver.example': '192.0.2.53' });
  newHandler.data.settings.queryStrategy = 'UseIPv6';
  const same = applyPoolPreferences(published, edited, first.poolPreferenceBase);
  newHandler.data.settings.queryStrategy = 'UseIPv4';
  const next = applyPoolPreferences(published, same.graph, same.base);
  const effective = next.graph.nodes.find((n) => n.id === handler.id)!;
  expect(effective.data.settings).toMatchObject({ queryStrategy: 'UseIPv6', disableCache: true });
  expect(JSON.parse(String(effective.data.settings.hosts))).toEqual({
    'full:printer.home': '192.168.1.60',
    'full:resolver.example': '192.0.2.53',
  });
  expect(
    personalSettingChoices(next.graph, next.base)
      .map((item) => item.key)
      .sort(),
  ).toEqual(['hosts/full:printer.home', 'queryStrategy']);
  const reset = applyPoolPreferences(published, next.graph, next.base, {
    [handler.id]: ['queryStrategy', 'hosts/full:printer.home'],
  });
  expect(reset.graph.nodes.find((n) => n.id === handler.id)?.data.settings.queryStrategy).toBe(
    'UseIPv4',
  );
  expect(personalSettingChoices(reset.graph, reset.base)).toEqual([]);
  handler.data.settings.rewriteAddress = '9.9.9.9';
  expect(poolRoutingState(edited, true)).not.toEqual(poolRoutingState(working, true));
  expect(
    subscriptionEngine({
      ...request,
      operation: 'poolRoutingState',
      appliedGraph: serializeGraph(edited),
    }),
  ).toMatchObject({ matchesPublication: false });
});

it('follows new default Stashes and DNS filters after customizing only a traffic filter', () => {
  const { pool, member, servers, traffic, dns, outbound } = fixture();
  const original = prepareDelivery(pool, member, servers);
  const selection = {
    graph: 'first',
    stashOverrides: { one: true },
    filterOverrides: { [traffic.id]: null },
  };
  const later = {
    ...original,
    defaultLayers: [
      { id: 'two' },
      { id: 'traffic', target: traffic.id },
      { id: 'dns', target: dns.id },
    ],
  };
  const choice = resolvePoolDelivery(later, selection, true);
  expect(choice.options?.activeStashes).toEqual(['two', 'one']);
  expect(choice.options?.filters.find((f) => f.id === traffic.id)?.active).toBeUndefined();
  expect(choice.options?.filters.find((f) => f.id === dns.id)?.active).toBe('dns');
  const withdrawn = { ...later, layers: later.layers.filter((l) => l.id !== 'one') };
  expect(resolvePoolDelivery(withdrawn, selection, true).options?.activeStashes).toEqual(['two']);
  expect(() =>
    resolvePoolDelivery(withdrawn, {
      ...selection,
      outbounds: { [outbound.id]: { groupId: defaultGroup().id, entryId: 'one-entry' } },
    }),
  ).toThrow('selected outbound');
});

it('delivers only assigned choices and uses stable selections on each subscriber machine', () => {
  // Imported node IDs can coincide with JavaScript object property names.
  const { pool, member, servers, inbound, outbound, traffic, dns } = fixture('__proto__');
  const delivery = prepareDelivery(pool, member, servers);
  expect(JSON.stringify(delivery)).toContain('alice-secret');
  expect(JSON.stringify(delivery)).not.toMatch(/bob-secret|hidden-entry/);
  const defaults = resolvePoolDelivery(delivery, undefined, true);
  expect(defaults.selection?.graph).toBe('first');
  expect(defaults.options?.graphs.map(({ id }) => id)).toEqual(['first', 'second']);
  expect(defaults.options?.stashes).toHaveLength(2);
  expect(
    defaults.options?.filters.find(({ id }) => id === traffic.id)?.defaultLayer,
  ).toBeUndefined();
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
  const choiceNames = cloneJson(resolvePoolDelivery(delivery, selection).choiceNames);
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

it('imports a Stash assigned to both the user and graph once and preserves existing outbound choices', () => {
  const { pool, member, servers, outbound } = fixture();
  delete member.accounts;
  member.assignments = [{ id: 'one' }, { id: 'two' }];
  const base = pool.configurations[0].bundle;
  if (base.version === 1) throw new Error('Expected a graph that supports linked layers');
  base.linkedLayers = [{ id: 'one' }];
  const publication = encodePoolDelivery(prepareDelivery(pool, member, servers));
  const graphStash = parseStash(publication.graphs[0].bundle.stash);
  const linked = graphStash.groups.find(({ entries }) =>
    entries.some(({ id }) => id === 'one-entry'),
  )!;
  const layer = publication.layers.find(({ id }) => id === 'one')!.data;
  if (layer.kind !== 'stash') throw new Error('Missing assigned Stash');
  const local = parseEntry('socks://local.example.test:1080');
  const previousStash = {
    ...stash,
    groups: [
      ...[linked, ...parseStash(layer.stash).groups].map((group) => ({
        ...group,
        id: poolGroupId(recipient, group.id),
      })),
      { ...defaultGroup(), entries: [local] },
    ],
  };
  const oldLink = { groupId: defaultGroup().id, entryId: 'one-entry' };
  const result = subscriptionEngine({
    operation: 'poolPrepare',
    bundle: publication,
    stash: serializeStash(previousStash),
    poolSelection: { graph: 'first', outbounds: { [outbound.id]: oldLink } },
    recipient,
    capture: 'proxy',
  });
  if (!('graph' in result) || !result.graph || !result.stash)
    throw new Error('Missing prepared Pool configuration');
  const groups = parseStash(result.stash).groups;
  expect(groups.flatMap(({ entries }) => entries.map(({ id }) => id))).toEqual([
    local.id,
    'one-entry',
    'two-entry',
  ]);
  const linkedChoice = { ...oldLink, groupId: linked.id };
  expect(result.poolSelection?.outbounds?.[outbound.id]).toEqual(linkedChoice);
  expect(
    parseGraph(result.graph).nodes.find(({ id }) => id === outbound.id)?.data.stashLink,
  ).toEqual({ ...linkedChoice, groupId: poolGroupId(recipient, linked.id) });

  delete base.linkedLayers;
  const unlinked = resolvePoolDelivery(
    prepareDelivery(pool, member, servers),
    result.poolSelection,
  );
  expect(unlinked.selection?.outbounds?.[outbound.id]).toEqual(oldLink);
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
