import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { compileRuntimeGraph } from './runtime';
import { createFakeDnsExample } from './fakeDnsExample';
import { automaticFakeDns, fakeDnsAddressConflicts, fakeDnsPools, FAKE_DNS_PORT } from './fakeDns';
import { connectionProblem, diagnoseGraph, serializeGraph } from './model';
import { protocolConfig } from './protocols';
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
