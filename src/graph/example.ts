import { makeNode, makeProxyInbound } from './catalog';
import type { GraphState } from './types';
import { readRuleTable, tableSettings } from './rules';
import { newDnsPolicy, newDnsRoute, newDnsServer } from './dns';

export function createDnsExample(): GraphState {
  const base = createRoutingExample();
  const socks = base.nodes.find((n) => n.id === 'socks')!,
    routes = base.nodes.find((n) => n.id === 'routes')!;
  socks.position = { x: 0, y: 240 };
  routes.position = { x: 340, y: 0 };
  const handler = makeNode('dns-handler', { x: 340, y: 340 }, 'dns');
  handler.data.label = 'DNS handler';
  handler.data.settings.policyRules = JSON.stringify([
    {
      ...newDnsPolicy('binding'),
      name: 'Suppress SVCB / HTTPS',
      qType: '64,65',
      action: 'return',
      rCode: 0,
    },
    {
      ...newDnsPolicy('aaaa'),
      name: 'Block AAAA (optional)',
      qType: '28',
      enabled: false,
      action: 'return',
      rCode: 0,
    },
    { ...newDnsPolicy('addresses'), name: 'Resolve A / AAAA', qType: '1,28', action: 'resolve' },
  ]);
  const filter = makeNode('dns-routing-filter', { x: 690, y: 350 }, 'dns-routes');
  filter.data.label = 'DNS routing';
  filter.selected = true;
  routes.selected = false;
  Object.assign(filter.data.settings, {
    outputs: JSON.stringify([
      { id: 'local', name: 'Local names', fallback: false },
      { id: 'remote', name: 'Fallback', fallback: true },
    ]),
    rules: JSON.stringify([
      {
        ...newDnsRoute('local', 'local-names'),
        name: 'LAN / home.arpa',
        domains: 'domain:lan\ndomain:home.arpa',
        expectedIPs: '192.168.0.0/16\n10.0.0.0/8',
        finalQuery: true,
      },
    ]),
  });
  const local = makeNode('dns-servers', { x: 1040, y: 260 }, 'local-dns');
  local.data.label = 'Local DNS';
  local.data.settings.servers = JSON.stringify([
    { ...newDnsServer('lan'), name: 'LAN resolver', address: '192.168.1.1' },
  ]);
  const remote = makeNode('dns-servers', { x: 1040, y: 540 }, 'remote-dns');
  remote.data.label = 'Remote DNS';
  remote.data.settings.servers = JSON.stringify([
    { ...newDnsServer('cloudflare'), name: 'Cloudflare DoH', address: 'https://1.1.1.1/dns-query' },
    { ...newDnsServer('quad9'), name: 'Quad9 TCP', address: 'tcp://9.9.9.9:53' },
  ]);
  const block = base.nodes.find((n) => n.id === 'block')!,
    preferred = base.nodes.find((n) => n.id === 'preferred')!,
    direct = base.nodes.find((n) => n.id === 'direct')!;
  block.position = { x: 1390, y: 0 };
  preferred.position = { x: 1390, y: 280 };
  direct.position = { x: 1390, y: 560 };
  const edge = (id: string, source: string, sourceHandle: string, target: string) => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  return {
    name: 'DNS server groups',
    nodes: [socks, routes, handler, filter, local, remote, block, preferred, direct],
    edges: [
      ...base.edges.filter((e) => !e.id.startsWith('dns-')),
      edge('socks-dns', 'socks', 'dns', 'dns'),
      edge('handler-resolver', 'dns', 'resolver', 'dns-routes'),
      edge('dns-local', 'dns-routes', 'local', 'local-dns'),
      edge('dns-remote', 'dns-routes', 'remote', 'remote-dns'),
      edge('local-query', 'local-dns', 'queries', 'direct'),
      edge('remote-query', 'remote-dns', 'queries', 'preferred'),
    ],
  };
}

export function createRoutingExample(): GraphState {
  const socks = makeProxyInbound('socks', { x: 0, y: 175 }, 'socks');
  const filter = makeNode('routing-filter', { x: 320, y: 0 }, 'routes');
  filter.data.label = 'Traffic rules';
  filter.selected = true;
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'blocked', name: 'Blocked' },
        { id: 'preferred', name: 'Preferred' },
        { id: 'default', name: 'Default' },
      ],
      rules: [
        {
          id: 'blocked-domains',
          name: 'Blocked destinations',
          enabled: true,
          output: 'blocked',
          matchAll: false,
          conditions: { domain: 'domain:blocked.example' },
        },
        {
          id: 'selected-domains',
          name: 'Selected domains',
          enabled: true,
          output: 'preferred',
          matchAll: false,
          conditions: { domain: 'domain:example.net', network: 'tcp,udp' },
        },
        {
          id: 'local-networks',
          name: 'Local networks',
          enabled: true,
          output: 'default',
          matchAll: false,
          conditions: { ip: '10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\nfc00::/7' },
        },
      ],
      defaultOutput: 'default',
    }),
  );
  const block = makeNode('block-outbound', { x: 700, y: 0 }, 'block');
  const vless = makeNode('vless-outbound', { x: 700, y: 245 }, 'preferred');
  Object.assign(vless.data.settings, {
    tag: 'preferred',
    address: 'edge.example.net',
    id: 'wayrill-example',
  });
  const direct = makeNode('direct-outbound', { x: 700, y: 490 }, 'direct');
  const edge = (id: string, source: string, sourceHandle: string, target: string) => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  return {
    name: 'Combined routing',
    nodes: [socks, filter, block, vless, direct],
    edges: [
      edge('data-rules', 'socks', 'data', 'routes'),
      edge('dns-direct', 'socks', 'dns', 'direct'),
      edge('routes-block', 'routes', 'blocked', 'block'),
      edge('routes-preferred', 'routes', 'preferred', 'preferred'),
      edge('routes-direct', 'routes', 'default', 'direct'),
    ],
  };
}

// Public, fictional credentials only. The private VM copy is populated separately.
export function createTrafficExample(): GraphState {
  const graph = createDnsExample();
  graph.name = 'First traffic setup';
  const find = (id: string) => graph.nodes.find((n) => n.id === id)!;
  const socks = find('socks');
  socks.position = { x: 0, y: 80 };
  Object.assign(socks.data.settings, { tag: 'local-socks', port: 2080 });
  const http = makeProxyInbound('http', { x: 0, y: 340 }, 'http');
  http.data.label = 'Windows / HTTP';
  Object.assign(http.data.settings, { tag: 'local-http', port: 2081 });
  graph.nodes.push(http);
  Object.assign(
    find('routes').data.settings,
    tableSettings({
      outputs: [
        { id: 'blocked', name: 'Block' },
        { id: 'direct', name: 'Direct' },
        { id: 'preferred', name: 'VLESS' },
      ],
      rules: [
        {
          id: 'blocked',
          name: 'Block test destination',
          enabled: true,
          output: 'blocked',
          matchAll: false,
          conditions: { domain: 'full:example.net\ndomain:blocked.wayrill.test' },
        },
        {
          id: 'direct',
          name: 'Direct test and local networks',
          enabled: true,
          output: 'direct',
          matchAll: false,
          conditions: { domain: 'domain:example.com' },
        },
        {
          id: 'lan',
          name: 'Local IPv4 networks',
          enabled: true,
          output: 'direct',
          matchAll: false,
          conditions: { ip: '127.0.0.0/8\n10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16' },
        },
      ],
      defaultOutput: 'preferred',
    }),
  );
  const handler = find('dns');
  Object.assign(handler.data.settings, {
    queryStrategy: 'UseIPv4',
    policyDefault: 'return',
    policyRCode: 0,
    policyRules: JSON.stringify([
      {
        ...newDnsPolicy('optional'),
        name: 'Suppress IPv6 / SVCB / HTTPS',
        qType: '28,64,65',
        action: 'return',
        rCode: 0,
      },
      { ...newDnsPolicy('a'), name: 'Resolve IPv4 addresses', qType: '1', action: 'resolve' },
    ]),
  });
  find('local-dns').data.settings.servers = JSON.stringify([
    { ...newDnsServer('lan'), name: 'VM NAT DNS', address: '10.0.2.3' },
  ]);
  find('remote-dns').data.settings.servers = JSON.stringify([
    {
      ...newDnsServer('cloudflare'),
      name: 'Cloudflare DoH through VLESS',
      address: 'https://1.1.1.1/dns-query',
    },
  ]);
  Object.assign(find('preferred').data.settings, {
    tag: 'preferred',
    address: 'edge.example.net',
    id: 'wayrill-example',
    network: 'xhttp',
    security: 'tls',
  });
  find('preferred').data.description =
    'Fictional placeholder. Replace with a working VLESS profile before testing.';
  const edge = (id: string, source: string, sourceHandle: string, target: string) => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  graph.edges = graph.edges.filter((e) => !e.id.startsWith('routes-'));
  graph.edges.push(
    edge('routes-block', 'routes', 'blocked', 'block'),
    edge('routes-direct', 'routes', 'direct', 'direct'),
    edge('routes-vless', 'routes', 'preferred', 'preferred'),
    edge('http-data', 'http', 'data', 'routes'),
    edge('http-dns', 'http', 'dns', 'dns'),
  );
  for (const node of graph.nodes) node.selected = node.id === 'routes';
  return graph;
}

/** One public verification graph exercises all four connection roles. */
export function createVerificationExample(): GraphState {
  const graph = createTrafficExample();
  graph.name = 'Schematic verification';
  const find = (id: string) => graph.nodes.find((node) => node.id === id)!;
  const group = makeNode('policy-group', { x: 690, y: 40 }, 'verification-group');
  group.data.label = 'Policy group';
  Object.assign(group.data.settings, {
    tag: 'verification-policy',
    strategy: 'leastPing',
    observe: true,
    fallbackEnabled: true,
    sources: JSON.stringify({
      version: 1,
      manual: [
        { type: 'node', nodeId: 'preferred' },
        { type: 'node', nodeId: 'direct' },
      ],
      subscriptions: [],
      fallback: { type: 'node', nodeId: 'block' },
    }),
  });
  const observer = makeNode('observatory', { x: 1040, y: 30 }, 'verification-observatory');
  observer.data.label = 'Observatory';
  Object.assign(observer.data.settings, {
    mode: 'standard',
    probeURL: 'https://example.com/',
    probeInterval: '30s',
  });
  graph.nodes.push(group, observer);
  find('dns-routes').position.y = 470;
  find('local-dns').position.y = 450;
  find('remote-dns').position.y = 730;
  const table = readRuleTable(find('routes').data.settings);
  table.outputs.find((output) => output.id === 'preferred')!.name = 'Policy group';
  Object.assign(find('routes').data.settings, tableSettings(table));
  for (const edge of graph.edges)
    if (edge.id === 'routes-vless' || edge.id === 'remote-query') edge.target = group.id;
  for (const [port, target] of [['observation', observer.id]])
    graph.edges.push({
      id: `verification-${port}`,
      source: group.id,
      sourceHandle: port,
      target,
      targetHandle: 'in',
    });
  return graph;
}
