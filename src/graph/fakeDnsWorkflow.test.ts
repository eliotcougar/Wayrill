import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { compileRuntimeGraph } from './runtime';
import { createFakeDnsExample } from './fakeDnsExample';
import {
  automaticFakeDns,
  automaticFakeDnsPools,
  fakeDnsAddressConflicts,
  fakeDnsPools,
  FAKE_DNS_PORT,
} from './fakeDns';
import { connectionProblem, diagnoseGraph, serializeGraph } from './model';
import { dnsCaptureProblems } from './dnsCapture';
import { newDnsRoute, readDnsFilter } from './dns';
import { protocolConfig } from './protocols';
import { addressInPrefix } from './ipNetwork';
import { importXrayConfig } from './xrayImport';

const withTun = () => {
  const graph = createFakeDnsExample();
  const tun = makeNode('tun-inbound', { x: 0, y: 0 }, 'tun');
  graph.nodes.push(tun);
  graph.edges.push(
    {
      id: 'tun-data',
      source: tun.id,
      sourceHandle: 'traffic',
      target: 'fake-direct',
      targetHandle: 'in',
    },
    {
      id: 'tun-dns',
      source: tun.id,
      sourceHandle: 'dns',
      target: 'fake-handler',
      targetHandle: 'in',
    },
  );
  return { graph, tun };
};
it('the generated configuration round-trips through native import without needing the special graph topology', () => {
  const config = compileRuntimeGraph(createFakeDnsExample()).config;
  const imported = importXrayConfig(JSON.stringify(config));
  expect(compileRuntimeGraph(imported).config).toEqual(config);
});
const setNativeSettings = (node: ReturnType<typeof makeNode>, change: Record<string, unknown>) => {
  const raw = JSON.parse(String(node.data.settings.json));
  Object.assign(raw.settings, change);
  node.data.settings.json = JSON.stringify(raw);
};

it('a dedicated connection generates synthetic answers, real fallback, and name recovery without changing the saved graph', () => {
  const { graph, tun } = withTun();
  const source = serializeGraph(graph);
  const result = compileRuntimeGraph(graph);
  const dns = result.config.dns as any;
  expect(dns.servers).toEqual([
    { address: 'fakedns', domains: ['regexp:.*'], skipFallback: true, finalQuery: false },
    expect.objectContaining({ address: '1.1.1.1', skipFallback: false }),
  ]);
  for (const input of result.config.inbounds as any[]) {
    expect(input.sniffing.enabled).toBe(true);
    expect(input.sniffing.destOverride).toContain('fakedns');
  }
  expect(
    (result.config.inbounds as any[]).find((i) => i.tag === 'local').sniffing.metadataOnly,
  ).toBe(true);
  expect(protocolConfig(tun.data).sniffing).not.toEqual(
    expect.objectContaining({ destOverride: expect.arrayContaining(['fakedns']) }),
  );
  expect(serializeGraph(graph)).toBe(source);
});

it.each([
  ['AsIs', 'ForceIP'],
  ['UseIP', 'ForceIP'],
  ['UseIPv4', 'ForceIPv4'],
  ['UseIPv6', 'ForceIPv6'],
  ['UseIPv4v6', 'ForceIPv4v6'],
  ['UseIPv6v4', 'ForceIPv6v4'],
  ['ForceIPv4', 'ForceIPv4'],
])(
  'Direct uses the real fallback for %s without overwriting an explicit family choice',
  (authored, expected) => {
    const graph = createFakeDnsExample();
    const direct = graph.nodes.find((n) => n.id === 'fake-direct')!;
    direct.data.settings.domainStrategy = authored;
    direct.data.settings.interface = 'Ethernet';
    direct.data.overrides = [...(direct.data.overrides ?? []), 'domainStrategy', 'interface'];
    const source = serializeGraph(graph);
    const outbound = (compileRuntimeGraph(graph).config.outbounds as any[]).find(
      (o) => o.tag === 'direct',
    );
    expect(outbound.streamSettings.sockopt).toMatchObject({
      domainStrategy: expected,
      interface: 'Ethernet',
    });
    expect(serializeGraph(graph)).toBe(source);
    graph.edges = graph.edges.filter((e) => e.sourceHandle !== FAKE_DNS_PORT);
    const manual = (compileRuntimeGraph(graph).config.outbounds as any[]).find(
      (o) => o.tag === 'direct',
    );
    expect(manual.streamSettings.sockopt.domainStrategy).toBe(authored);
  },
);

it('turns off speculative parallel fallbacks only while the dedicated FakeDNS connection exists', () => {
  const graph = createFakeDnsExample();
  graph.nodes.find((n) => n.id === 'fake-routing')!.data.settings.parallel = true;
  const source = serializeGraph(graph);
  expect((compileRuntimeGraph(graph).config.dns as any).enableParallelQuery).toBe(false);
  expect(serializeGraph(graph)).toBe(source);
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== FAKE_DNS_PORT);
  expect((compileRuntimeGraph(graph).config.dns as any).enableParallelQuery).toBe(true);
});

it('keeps real fallback reachable after a manually terminal FakeDNS preference', () => {
  const graph = createFakeDnsExample();
  const node = graph.nodes.find((n) => n.id === 'fake-routing')!;
  const filter = readDnsFilter(node.data.settings);
  filter.outputs.push({ id: 'manual-fake', name: 'Manual synthetic', fallback: false });
  node.data.settings.outputs = JSON.stringify(filter.outputs);
  node.data.settings.rules = JSON.stringify([
    { ...newDnsRoute('manual-fake', 'manual'), domains: 'domain:example.net', finalQuery: true },
  ]);
  graph.edges.push({
    id: 'manual-fake',
    source: node.id,
    sourceHandle: 'manual-fake',
    target: 'fake-resolver',
    targetHandle: 'in',
  });
  const dns = compileRuntimeGraph(graph).config.dns as any;
  expect(dns.servers[0]).toMatchObject({ address: 'fakedns', finalQuery: false });
  expect(dns.servers.at(-1)).toMatchObject({ address: '1.1.1.1', skipFallback: false });
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== FAKE_DNS_PORT);
  expect((compileRuntimeGraph(graph).config.dns as any).servers[0].finalQuery).toBe(true);
});

it('rejects a captured Windows resolver loop while accepting a DNSCrypt service on loopback', () => {
  const { graph, tun } = withTun();
  setNativeSettings(tun, { dns: ['8.8.8.8'] });
  const node = graph.nodes.find((n) => n.id === 'fake-real-dns')!;
  const servers = JSON.parse(String(node.data.settings.servers));
  servers[0].address = 'localhost';
  node.data.settings.servers = JSON.stringify(servers);
  const queryEdges = graph.edges.filter((e) => e.source === node.id);
  graph.edges = graph.edges.filter((e) => e.source !== node.id);
  expect(() => compileRuntimeGraph(graph)).toThrow(/localhost uses Windows DNS/);
  tun.data.enabled = false;
  expect(() => compileRuntimeGraph(graph)).not.toThrow();
  tun.data.enabled = true;
  setNativeSettings(tun, { dns: ['10.90.0.1'] });
  expect(() => compileRuntimeGraph(graph)).not.toThrow();
  setNativeSettings(tun, { dns: ['8.8.8.8'] });
  servers[0].address = '127.0.0.1';
  node.data.settings.servers = JSON.stringify(servers);
  graph.edges.push(...queryEdges);
  expect(() => compileRuntimeGraph(graph)).not.toThrow();
});

it('detects intersections across whole adapter prefixes and rejects loopback or overlapping pools', () => {
  expect(
    fakeDnsAddressConflicts(
      [{ protocol: 'tun', settings: { gateway: ['198.16.0.1/14'] } }],
      [{ ipPool: '198.18.0.0/15' }],
    ),
  ).toHaveLength(1);
  expect(
    fakeDnsAddressConflicts(
      [{ protocol: 'tun', settings: { gateway: ['2001::1/16'] } }],
      [{ ipPool: '2001:2::/48' }],
    ),
  ).toHaveLength(1);
  const fake = createFakeDnsExample().nodes.find((n) => n.data.kind === 'fakedns')!.data;
  for (const pools of [
    [{ ipPool: '127.1.0.0/16', poolSize: 4 }],
    [{ ipPool: '::/120', poolSize: 4 }],
    [
      { ipPool: '198.18.0.0/24', poolSize: 4 },
      { ipPool: '198.18.0.0/25', poolSize: 4 },
    ],
  ])
    expect(() =>
      fakeDnsPools({ ...fake, settings: { ...fake.settings, pools: JSON.stringify(pools) } }),
    ).toThrow(/overlap/);
});

it('Direct through another outbound retains remote DNS rather than resolving before the proxy', () => {
  const graph = createFakeDnsExample();
  const direct = graph.nodes.find((n) => n.id === 'fake-direct')!;
  const proxy = makeNode('socks-outbound', { x: 0, y: 0 }, 'proxy');
  proxy.data.settings.address = '192.0.2.1';
  graph.nodes.push(proxy);
  direct.data.settings.domainStrategy = 'AsIs';
  direct.data.settings.dialerProxy = String(proxy.data.settings.tag);
  const compiled = compileRuntimeGraph(graph).config as any;
  expect(
    compiled.outbounds.find((o: any) => o.tag === 'direct').streamSettings.sockopt,
  ).toMatchObject({ domainStrategy: 'AsIs', dialerProxy: proxy.data.settings.tag });
});

it.each(['always', 'when-unmatched', 'disabled'])(
  'real lookups keep a fallback with authored policy %s and fallback-first order',
  (mode) => {
    const graph = createFakeDnsExample();
    const filter = graph.nodes.find((n) => n.id === 'fake-routing')!;
    filter.data.settings.fallbackMode = mode;
    filter.data.settings.fallbackFirst = true;
    graph.nodes.find((n) => n.id === 'fake-resolver')!.data.settings.servers = '[]';
    const dns = compileRuntimeGraph(graph).config.dns as any;
    expect(dns.disableFallback).toBe(false);
    expect(dns.disableFallbackIfMatch).toBe(false);
    expect(dns.servers[0].address).toBe('fakedns');
    expect(dns.servers[0].finalQuery).toBe(false);
    expect(dns.servers[1].skipFallback).toBe(false);
  },
);

it('preferred real resolvers remain ahead of FakeDNS and retain their stop-after-group behavior', () => {
  const graph = createFakeDnsExample();
  const node = graph.nodes.find((n) => n.id === 'fake-routing')!;
  const filter = readDnsFilter(node.data.settings);
  filter.outputs.unshift({ id: 'real-local', name: 'Local names', fallback: false });
  node.data.settings.outputs = JSON.stringify(filter.outputs);
  node.data.settings.rules = JSON.stringify([
    { ...newDnsRoute('real-local', 'local'), domains: 'domain:example.local', finalQuery: true },
  ]);
  graph.edges.push({
    id: 'preferred-real',
    source: node.id,
    sourceHandle: 'real-local',
    target: 'fake-real-dns',
    targetHandle: 'in',
  });
  const dns = compileRuntimeGraph(graph).config.dns as any;
  expect(dns.servers[0]).toMatchObject({
    address: '1.1.1.1',
    domains: ['domain:example.local'],
    finalQuery: true,
  });
  expect(dns.servers[1].address).toBe('fakedns');
  expect(dns.servers[2]).toMatchObject({ address: '1.1.1.1', skipFallback: false });
});

it('disconnecting the optional point restores authored sniffing and resolver settings', () => {
  const graph = createFakeDnsExample();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== FAKE_DNS_PORT);
  expect(automaticFakeDns(graph)).toBe(false);
  const config = compileRuntimeGraph(graph).config as any;
  expect(config.inbounds[0].sniffing.enabled).toBe(false);
  expect(config.dns.servers.some((s: any) => s.address === 'fakedns')).toBe(false);
  expect(diagnoseGraph(graph).some((i) => i.portId === FAKE_DNS_PORT)).toBe(false);
});

it('the dedicated point accepts a FakeDNS node and requires a real DNS fallback', () => {
  const graph = createFakeDnsExample();
  const edge = graph.edges.find((e) => e.sourceHandle === FAKE_DNS_PORT)!;
  const draft = { ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) };
  expect(connectionProblem(draft, edge)).toBeNull();
  expect(connectionProblem(draft, { ...edge, target: 'fake-real-dns' })).toMatch(/FakeDNS node/);
  graph.edges = graph.edges.filter((e) => e.id !== 'fake-real');
  expect(() => compileRuntimeGraph(graph)).toThrow(/real DNS server on Fallback/);
});

it('new ICS addresses avoid the baked-in FakeDNS pools and old/custom collisions are actionable warnings', () => {
  const { graph } = withTun();
  const ics = makeNode('ics-tun', { x: 0, y: 0 }, 'ics');
  const address = (protocolConfig(ics.data).settings as any).gateway[0].split('/')[0];
  for (const family of ['UseIP', 'UseIPv4'])
    for (const pool of automaticFakeDnsPools(family))
      expect(addressInPrefix(address, pool.ipPool)).toBe(false);
  graph.nodes.push(ics);
  expect(dnsCaptureProblems(graph).filter((i) => i.message.includes('overlaps FakeDNS'))).toEqual(
    [],
  );
  setNativeSettings(ics, { gateway: ['198.18.0.1/32'] });
  expect(dnsCaptureProblems(graph)).toContainEqual(
    expect.objectContaining({
      nodeId: 'ics',
      severity: 'warning',
      message: expect.stringContaining('overlaps FakeDNS'),
    }),
  );
  ics.data.enabled = false;
  expect(dnsCaptureProblems(graph).some((i) => i.nodeId === 'ics')).toBe(false);
});

it.each(['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', '10.90.0.1'])(
  'warns that adapter DNS %s bypasses its connected handler',
  (address) => {
    const { graph, tun } = withTun();
    setNativeSettings(tun, { dns: [address] });
    expect(dnsCaptureProblems(graph)).toContainEqual(
      expect.objectContaining({
        nodeId: 'tun',
        severity: 'warning',
        message: expect.stringContaining('bypasses the connected DNS handler and FakeDNS'),
      }),
    );
    graph.edges = graph.edges.filter((e) => e.id !== 'tun-dns');
    expect(dnsCaptureProblems(graph).some((i) => i.message.includes('bypasses'))).toBe(false);
  },
);

it('warns about uncaptured DNS destinations but permits a local real fallback resolver', () => {
  const { graph, tun } = withTun();
  setNativeSettings(tun, { dns: ['8.8.8.8'], autoSystemRoutingTable: ['10.90.0.0/24'] });
  expect(dnsCaptureProblems(graph)).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('outside the captured routes') }),
  );
  setNativeSettings(tun, {
    dns: ['8.8.8.8'],
    autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1'],
  });
  const real = graph.nodes.find((n) => n.id === 'fake-real-dns')!;
  const servers = JSON.parse(String(real.data.settings.servers));
  servers[0].address = '127.0.0.1';
  real.data.settings.servers = JSON.stringify(servers);
  expect(dnsCaptureProblems(graph)).toEqual([]);
});
