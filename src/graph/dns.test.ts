import { describe, expect, it } from 'vitest';
import { getOutputPorts, makeNode, portLabel } from './catalog';
import {
  dnsAddressProblem,
  dnsProblems,
  newDnsRoute,
  newDnsServer,
  readDnsFilter,
  readDnsPolicies,
  readDnsServers,
} from './dns';
import { compileDnsGraph } from './dnsCompilation';
import { createDnsExample } from './example';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import { diagnoseGraph, parseGraph, serializeGraph, updateGraphNode } from './model';

describe('Native Xray DNS graph', () => {
  it('round-trips the new graph with typed connections and stable identities', () => {
    const graph = createDnsExample();
    expect(parseGraph(serializeGraph(graph)).edges).toEqual(graph.edges);
    expect(diagnoseGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('exports the native DNS server list in preference and fallback order', () => {
    const fragment = compileDnsGraph(createDnsExample());
    expect(fragment.dns.servers.map((s) => s.address)).toEqual([
      '192.168.1.1',
      'https://1.1.1.1/dns-query',
      'tcp://9.9.9.9:53',
    ]);
    expect(fragment.dns.servers[0]).toMatchObject({
      port: 53,
      domains: ['domain:lan', 'domain:home.arpa'],
      expectedIPs: ['192.168.0.0/16', '10.0.0.0/8'],
      skipFallback: true,
      finalQuery: true,
    });
    expect(fragment.dns.servers[1]).not.toHaveProperty('port');
    expect(fragment.routing.rules).toEqual([
      { type: 'field', inboundTag: ['wayrill-dns-local-dns-lan'], outboundTag: 'direct' },
      {
        type: 'field',
        inboundTag: ['wayrill-dns-remote-dns-cloudflare'],
        outboundTag: 'preferred',
      },
      { type: 'field', inboundTag: ['wayrill-dns-remote-dns-quad9'], outboundTag: 'preferred' },
    ]);
  });
  it('maps request policies to DNS outbound actions, omitting disabled drafts', () => {
    const graph = createDnsExample(),
      handler = graph.nodes.find((n) => n.id === 'dns')!;
    const policies = readDnsPolicies(handler.data.settings);
    policies[0].domain = 'domain:example.net';
    handler.data.settings.policyRules = JSON.stringify(policies);
    expect(compileDnsGraph(graph).outbounds[0]).toMatchObject({
      tag: 'dns-handler',
      protocol: 'dns',
      settings: {
        rules: [
          { action: 'return', rCode: 0, domain: ['domain:example.net'], qType: '64,65' },
          { action: 'hijack', qType: '1,28' },
          { action: 'return', rCode: 0 },
        ],
      },
    });
  });
  it('keeps all servers in a final group before stopping other groups', () => {
    const graph = createDnsExample(),
      group = graph.nodes.find((n) => n.id === 'local-dns')!;
    group.data.settings.servers = JSON.stringify([newDnsServer('one'), newDnsServer('two')]);
    expect(
      compileDnsGraph(graph)
        .dns.servers.slice(0, 2)
        .map((s) => s.finalQuery),
    ).toEqual([false, true]);
  });
  it('emits explicit inherited and overridden per-server settings', () => {
    const graph = createDnsExample(),
      group = graph.nodes.find((n) => n.id === 'remote-dns')!;
    const servers = readDnsServers(group.data.settings);
    Object.assign(servers[0], {
      queryStrategy: 'UseIPv6',
      clientIP: '2001:db8::1',
      timeoutMs: 2500,
      cache: 'enabled',
      stale: 'disabled',
      staleTTL: 90,
    });
    group.data.settings.servers = JSON.stringify(servers);
    const result = compileDnsGraph(graph).dns.servers;
    expect(result[1]).toMatchObject({
      queryStrategy: 'UseIPv6',
      clientIp: '2001:db8::1',
      timeoutMs: 2500,
      disableCache: false,
      serveStale: false,
      serveExpiredTTL: 90,
    });
    expect(result[2]).not.toHaveProperty('queryStrategy');
    expect(result[2]).not.toHaveProperty('disableCache');
  });
  it('routes original query forwarding with native sockopt.dialerProxy', () => {
    const graph = createDnsExample(),
      handler = graph.nodes.find((n) => n.id === 'dns')!;
    Object.assign(handler.data.settings, {
      policyDefault: 'forward',
      rewriteNetwork: 'tcp',
      rewriteAddress: '9.9.9.9',
      rewritePort: 5353,
    });
    graph.edges.push({
      id: 'forward-query',
      source: 'dns',
      sourceHandle: 'forward',
      target: 'direct',
      targetHandle: 'in',
    });
    expect(getOutputPorts(handler.data.kind, handler.data)).toEqual(['resolver', 'forward']);
    const outbound = compileDnsGraph(graph).outbounds[0];
    expect(outbound).toMatchObject({
      settings: { rewriteNetwork: 'tcp', rewriteAddress: '9.9.9.9', rewritePort: 5353 },
      streamSettings: { sockopt: { dialerProxy: 'direct' } },
    });
    expect(outbound).not.toHaveProperty('proxySettings');
  });
  it('bypasses transport routing only for explicit local resolver modes', () => {
    const graph = createDnsExample(),
      group = graph.nodes.find((n) => n.id === 'remote-dns')!;
    group.data.settings.servers = JSON.stringify([
      { ...newDnsServer('local'), address: 'https+local://1.1.1.1/dns-query' },
    ]);
    const updated = updateGraphNode(graph, group.id, { settings: group.data.settings });
    expect(getOutputPorts(group.data.kind, group.data)).toEqual([]);
    expect(updated.edges).toHaveLength(9);
    expect(compileDnsGraph(updated).routing.rules).toHaveLength(1);
    expect(
      dnsProblems(group.data).some(
        (i) => i.severity === 'warning' && i.message.includes('bypasses'),
      ),
    ).toBe(true);
    expect(
      undoWorkspaceHistory(
        commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: updated }),
      ).present.graph.edges,
    ).toHaveLength(10);
  });
  it('preserves DNS output identity across rename and atomically removes deleted paths', () => {
    const graph = createDnsExample(),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!;
    const f = readDnsFilter(node.data.settings);
    f.outputs[0].name = 'Home';
    const renamed = updateGraphNode(graph, node.id, {
      settings: { ...node.data.settings, outputs: JSON.stringify(f.outputs) },
    });
    expect(renamed.edges).toEqual(graph.edges);
    expect(portLabel('local', renamed.nodes.find((n) => n.id === node.id)!.data)).toBe('Home');
    f.rules = [];
    f.outputs.shift();
    const updated = updateGraphNode(renamed, node.id, {
      settings: { ...node.data.settings, outputs: JSON.stringify(f.outputs), rules: '[]' },
    });
    expect(updated.edges).toHaveLength(9);
    expect(
      undoWorkspaceHistory(
        commitWorkspaceHistory(initialWorkspaceHistory(renamed), { graph: updated }),
      ).present.graph,
    ).toEqual(renamed);
  });
  it('validates endpoints, numeric bounds, fallback and answer checks', () => {
    for (const address of [
      '1.1.1.1',
      '2001:4860:4860::8888',
      'tcp://[::1]:5353',
      'https://dns.example.net/dns-query',
      'localhost',
      'quic+local://1.1.1.1:853',
    ])
      expect(dnsAddressProblem(address)).toBeNull();
    for (const address of [
      'fakedns',
      'udp://1.1.1.1',
      'http://dns.example.net',
      'https://user:secret@dns.example.net',
      'tcp://1.1.1.1:70000',
      '999.1.1.1',
    ])
      expect(dnsAddressProblem(address)).not.toBeNull();
    const node = makeNode('dns-servers', { x: 0, y: 0 });
    node.data.settings.servers = JSON.stringify([{ ...newDnsServer('bad'), port: 0 }]);
    expect(dnsProblems(node.data).some((i) => i.severity === 'error')).toBe(true);
    const filter = makeNode('dns-routing-filter', { x: 0, y: 0 });
    filter.data.settings.rules = JSON.stringify([
      { ...newDnsRoute('default'), domains: 'domain:test.net', unexpectedIPs: 'not-an-ip' },
    ]);
    expect(dnsProblems(filter.data).some((i) => i.message.includes('invalid IP'))).toBe(true);
    filter.data.settings.outputs = JSON.stringify([
      { id: 'default', name: 'Default', fallback: false },
    ]);
    expect(dnsProblems(filter.data).some((i) => i.message.includes('exactly one Fallback'))).toBe(
      true,
    );
  });
  it('keeps disabled draft resolvers and preferences out of generated configuration', () => {
    const graph = createDnsExample(),
      group = graph.nodes.find((n) => n.id === 'remote-dns')!;
    const servers = readDnsServers(group.data.settings);
    servers.push({ ...newDnsServer('draft'), enabled: false, address: 'unfinished' });
    group.data.settings.servers = JSON.stringify(servers);
    expect(dnsProblems(group.data).filter((i) => i.severity === 'error')).toEqual([]);
    expect(compileDnsGraph(graph).dns.servers).toHaveLength(3);
  });
  it('refuses multiple global handlers and incomplete or conflicting graph exports', () => {
    const graph = createDnsExample();
    graph.nodes.push(makeNode('dns-handler', { x: 0, y: 0 }));
    expect(() => compileDnsGraph(graph)).toThrow(/exactly one/);
    graph.nodes.pop();
    graph.edges = graph.edges.filter((e) => e.id !== 'remote-query');
    expect(() => compileDnsGraph(graph)).toThrow(/Connect Remote DNS/);
    const tags = createDnsExample();
    tags.nodes.find((n) => n.id === 'direct')!.data.settings.tag = 'preferred';
    expect(() => compileDnsGraph(tags)).toThrow(/must be unique/);
  });
});

describe('Permanent DNS fallback output', () => {
  it('omits disabled fallback servers and their outbound dependencies without removing the wire', () => {
    const graph = createDnsExample(),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!;
    node.data.settings.fallbackMode = 'disabled';
    const before = structuredClone(graph),
      fragment = compileDnsGraph(graph);
    expect(fragment.dns).toMatchObject({ disableFallback: true, disableFallbackIfMatch: false });
    expect(fragment.dns.servers.map((s) => s.address)).toEqual(['192.168.1.1']);
    expect(fragment.outbounds.some((o) => o.tag === 'preferred')).toBe(false);
    expect(fragment.routing.rules).toHaveLength(1);
    expect(graph).toEqual(before);
    graph.edges = graph.edges.filter((e) => !(e.source === node.id && e.sourceHandle === 'remote'));
    expect(compileDnsGraph(graph)).toEqual(fragment);
    node.data.settings.fallbackMode = 'always';
    expect(() => compileDnsGraph(graph)).toThrow(/Connect DNS routing: remote/);
  });
});
