import { describe, expect, it } from 'vitest';
import { getOutputPorts, makeNode, portLabel } from './catalog';
import {
  dnsAddressProblem,
  dnsProblems,
  dnsOutputs,
  newDnsPolicy,
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
import {
  connectionProblem,
  diagnoseGraph,
  parseGraph,
  serializeGraph,
  updateGraphNode,
} from './model';

describe('Native Xray DNS graph', () => {
  it.each(['full:dns.google', 'dns.google'])(
    'recognizes %s bootstrap through the connected DNS filter',
    (key) => {
      const graph = createDnsExample(),
        group = graph.nodes.find((n) => n.id === 'remote-dns')!,
        handler = graph.nodes.find((n) => n.id === 'dns')!;
      group.data.settings.servers = JSON.stringify([
        { ...newDnsServer('google'), name: 'Google DoH', address: 'https://dns.google/dns-query' },
      ]);
      const warnings = () =>
        diagnoseGraph(graph).filter(
          (i) => i.nodeId === group.id && i.message.includes('hostname bootstrap'),
        );
      expect(warnings()).toHaveLength(1);
      handler.data.settings.hosts = JSON.stringify({ [key]: ['8.8.4.4', '8.8.8.8'] });
      expect(warnings()).toEqual([]);
      handler.data.settings.hosts = JSON.stringify({ [key]: '2001:4860:4860::8888' });
      expect(warnings()).toEqual([]);
    },
  );
  it('does not borrow bootstrap from another handler, from invalid values, or unresolved aliases', () => {
    const graph = createDnsExample(),
      group = graph.nodes.find((n) => n.id === 'remote-dns')!,
      handler = graph.nodes.find((n) => n.id === 'dns')!;
    group.data.settings.servers = JSON.stringify([
      { ...newDnsServer('google'), address: 'https://dns.google/dns-query' },
    ]);
    const other = makeNode('dns-handler', { x: 0, y: 0 });
    other.data.settings.hosts = '{"full:dns.google":["8.8.8.8"]}';
    graph.nodes.push(other);
    const warns = () =>
      dnsProblems(group.data, { graph, nodeId: group.id }).some((i) =>
        i.message.includes('hostname bootstrap'),
      );
    expect(warns()).toBe(true);
    for (const hosts of [
      '{',
      '{"full:dns.google":[]}',
      '{"full:dns.google":"other.example"}',
      '{"full:dns.google":["bad-ip"]}',
    ]) {
      handler.data.settings.hosts = hosts;
      expect(warns()).toBe(true);
    }
    handler.data.settings.hosts = other.data.settings.hosts;
    expect(warns()).toBe(false);
    graph.edges = graph.edges.filter((edge) => edge.source !== handler.id);
    expect(warns()).toBe(true);
  });
  it('recognizes direct handler connections and checks the edited server hostname', () => {
    const graph = createDnsExample(),
      handler = graph.nodes.find((n) => n.id === 'dns')!,
      group = graph.nodes.find((n) => n.id === 'remote-dns')!;
    handler.data.settings.hosts = '{"full:dns.google":["8.8.4.4","8.8.8.8"]}';
    graph.edges = graph.edges.filter((edge) => edge.source !== handler.id);
    graph.edges.push({
      id: 'direct-resolver',
      source: handler.id,
      sourceHandle: 'resolver',
      target: group.id,
      targetHandle: 'in',
    });
    const draft = {
      ...group.data,
      settings: {
        ...group.data.settings,
        servers: JSON.stringify([{ ...newDnsServer('google'), address: 'tcp://dns.google:53' }]),
      },
    };
    const warns = () =>
      dnsProblems(draft, { graph, nodeId: group.id }).some((issue) =>
        issue.message.includes('hostname bootstrap'),
      );
    expect(warns()).toBe(false);
    draft.settings.servers = JSON.stringify([
      { ...newDnsServer('other'), address: 'https://other.example/dns-query' },
    ]);
    expect(warns()).toBe(true);
    draft.settings.servers = JSON.stringify([
      { ...newDnsServer('local'), address: 'https+local://dns.google/dns-query' },
    ]);
    expect(dnsProblems(draft, { graph, nodeId: group.id })).toContainEqual(
      expect.objectContaining({
        rowId: 'local',
        fieldKey: 'address',
        severity: 'warning',
        message: expect.stringContaining('uses Windows DNS, not the handler’s static hosts'),
      }),
    );
  });
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
  it('maps global DNS family, hosts, EDNS, cache and stale settings', () => {
    const graph = createDnsExample(),
      s = graph.nodes.find((n) => n.id === 'dns')!.data.settings;
    Object.assign(s, {
      queryStrategy: 'UseIPv4',
      hosts: '{"full:dns.example.net":["1.1.1.1"]}',
      clientIP: '203.0.113.8',
      disableCache: true,
      serveStale: true,
      serveExpiredTTL: 30,
      useSystemHosts: true,
    });
    expect(compileDnsGraph(graph).dns).toMatchObject({
      queryStrategy: 'UseIPv4',
      hosts: { 'full:dns.example.net': ['1.1.1.1'] },
      clientIp: '203.0.113.8',
      disableCache: true,
      serveStale: true,
      serveExpiredTTL: 30,
      useSystemHosts: true,
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
  it('maps expected/unexpected IPs and fallback flags without inventing routing fields', () => {
    const graph = createDnsExample(),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!;
    const filter = readDnsFilter(node.data.settings);
    Object.assign(filter.rules[0], {
      unexpectedIPs: '203.0.113.0/24\n*',
      skipFallback: false,
      finalQuery: false,
    });
    Object.assign(node.data.settings, {
      rules: JSON.stringify(filter.rules),
      fallbackMode: 'when-unmatched',
      parallel: true,
    });
    const fragment = compileDnsGraph(graph);
    expect(fragment.dns).toMatchObject({
      disableFallbackIfMatch: true,
      disableFallback: false,
      enableParallelQuery: true,
    });
    expect(fragment.dns.servers[0]).toMatchObject({
      unexpectedIPs: ['203.0.113.0/24', '*'],
      skipFallback: false,
      finalQuery: false,
    });
    expect(fragment.dns.servers[0]).not.toHaveProperty('qType');
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
  it('allows a handler connected straight to a server group', () => {
    const graph = createDnsExample();
    graph.nodes = graph.nodes.filter((n) => n.id !== 'dns-routes');
    graph.edges = graph.edges.filter((e) => e.source !== 'dns-routes' && e.target !== 'dns-routes');
    graph.edges.push({
      id: 'resolver-direct',
      source: 'dns',
      sourceHandle: 'resolver',
      target: 'remote-dns',
      targetHandle: 'in',
    });
    expect(compileDnsGraph(graph).dns.servers).toHaveLength(2);
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
  it('rejects accidental mixing of resolver-selection and traffic paths', () => {
    const graph = createDnsExample();
    graph.edges = [];
    const connect = (source: string, sourceHandle: string, target: string) =>
      connectionProblem(graph, { source, sourceHandle, target, targetHandle: 'in' });
    expect(connect('dns', 'resolver', 'direct')).toMatch(/resolver path/);
    expect(connect('routes', 'preferred', 'remote-dns')).toMatch(/resolver-selection/);
    expect(connect('dns-routes', 'remote', 'routes')).toMatch(/resolver path/);
    expect(connect('dns-routes', 'local', 'dns-routes')).toMatch(/itself/);
    expect(connect('remote-dns', 'queries', 'routes')).toMatch(/configured Direct/);
    expect(connect('dns', 'resolver', 'dns-routes')).toBeNull();
    expect(connect('dns-routes', 'remote', 'remote-dns')).toBeNull();
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
  it('refuses resolver policies that would falsely resolve unsupported record types', () => {
    const node = makeNode('dns-handler', { x: 0, y: 0 });
    node.data.settings.policyRules = JSON.stringify([
      { ...newDnsPolicy(), qType: '65', action: 'resolve' },
    ]);
    expect(dnsProblems(node.data).some((i) => i.message.includes('supports A'))).toBe(true);
    node.data.settings.policyRules = '[]';
    expect(dnsProblems(node.data).filter((i) => i.severity === 'error')).toEqual([]);
    node.data.settings.policyRCode = NaN;
    expect(dnsProblems(node.data)).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('response code'),
      }),
    );
  });
});

describe('Permanent DNS fallback output', () => {
  it('uses the fixed label while retaining connected port identities', () => {
    const node = makeNode('dns-routing-filter', { x: 0, y: 0 });
    node.data.settings.outputs = JSON.stringify([
      { id: 'chosen', name: 'Regional servers', fallback: false },
      { id: 'existing-wire', name: 'Previous display name', fallback: true },
    ]);
    expect(dnsOutputs(node.data)).toEqual([
      { id: 'chosen', name: 'Regional servers', fallback: false },
      { id: 'existing-wire', name: 'Fallback', fallback: true },
      { id: 'fakedns', name: 'FakeDNS' },
    ]);
    node.data.settings.fallbackMode = 'disabled';
    expect(dnsOutputs(node.data)).toHaveLength(3);
    expect(dnsProblems(node.data).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('requires one permanent fallback role rather than arbitrary fallback selections', () => {
    const node = makeNode('dns-routing-filter', { x: 0, y: 0 });
    node.data.settings.outputs = JSON.stringify([
      { id: 'a', name: 'A', fallback: true },
      { id: 'b', name: 'B', fallback: true },
    ]);
    expect(() => readDnsFilter(node.data.settings)).toThrow(/exactly one Fallback/);
  });
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
  it('still includes a group explicitly chosen by a preference when fallback is disabled', () => {
    const graph = createDnsExample(),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!;
    node.data.settings.fallbackMode = 'disabled';
    node.data.settings.rules = JSON.stringify([
      { ...newDnsRoute('remote', 'explicit'), domains: 'domain:example.net', skipFallback: true },
    ]);
    const fragment = compileDnsGraph(graph);
    expect(fragment.dns.servers).toHaveLength(2);
    expect(fragment.dns.servers.every((s) => s.skipFallback === true)).toBe(true);
    expect(
      fragment.dns.servers.every((s) => (s.domains as string[]).includes('domain:example.net')),
    ).toBe(true);
  });
});
