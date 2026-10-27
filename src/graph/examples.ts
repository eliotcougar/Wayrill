import { makeNode, makeProxyInbound } from './catalog';
import { enableDefaults } from './defaults';
import { newDnsRoute, newDnsServer, readDnsFilter } from './dns';
import { createFakeDnsExample } from './fakeDnsExample';
import { tableSettings, type TableRule } from './rules';
import type { GraphState, RuleEdge, RuleNode } from './types';

export interface BundledExample {
  id: string;
  label: string;
  category: 'starter' | 'feature';
  message: string;
  create: () => GraphState;
}

const wire = (source: string, sourceHandle: string, target: string): RuleEdge => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});

const rule = (
  id: string,
  name: string,
  output: string,
  conditions: TableRule['conditions'],
): TableRule => ({
  id,
  name,
  enabled: true,
  matchAll: false,
  output,
  conditions,
});

function proxyGraph(): GraphState {
  const input = makeProxyInbound('mixed', { x: 32, y: 64 }, 'proxy');
  input.data.label = 'Local proxy';
  input.data.settings.tag = 'local-proxy';
  const direct = makeNode('direct-outbound', { x: 480, y: 96 }, 'direct');
  return {
    name: 'Local proxy · Direct',
    mainOutboundId: direct.id,
    nodes: [input, direct],
    edges: [wire(input.id, 'data', direct.id), wire(input.id, 'dns', direct.id)],
  };
}

export function createProxyStarter(): GraphState {
  return enableDefaults(proxyGraph());
}

function addDns(graph: GraphState, source: string, port = 'dns') {
  const handler = makeNode('dns-handler', { x: 320, y: 360 }, 'dns');
  const servers = makeNode('dns-servers', { x: 640, y: 360 }, 'real-dns');
  servers.data.label = 'Cloudflare DNS';
  servers.data.settings.servers = JSON.stringify([
    { ...newDnsServer('cloudflare'), name: 'Cloudflare DoH', address: 'https://1.1.1.1/dns-query' },
  ]);
  graph.nodes.push(handler, servers);
  graph.edges = graph.edges.filter((edge) => edge.source !== source || edge.sourceHandle !== port);
  graph.edges.push(
    wire(source, port, handler.id),
    wire(handler.id, 'resolver', servers.id),
    wire(servers.id, 'queries', 'direct'),
  );
}

function createCaptureStarter(kind: 'tun-inbound' | 'windivert-inbound'): GraphState {
  const input = makeNode(kind, { x: 32, y: 64 }, 'capture');
  const direct = makeNode('direct-outbound', { x: 640, y: 64 }, 'direct');
  const graph: GraphState = {
    name: `${kind === 'tun-inbound' ? 'TUN' : 'WinDivert'} · Direct`,
    mainOutboundId: direct.id,
    nodes: [input, direct],
    edges: [wire(input.id, kind === 'tun-inbound' ? 'traffic' : 'data', direct.id)],
  };
  addDns(graph, input.id);
  return enableDefaults(graph);
}

// Explicit placeholders are blocked by the normal setup workflow until replaced.
// Documentation-only addresses avoid an accidental connection to a real server.
function proxyServer(
  id: string,
  label: string,
  position: RuleNode['position'],
  address: string,
): RuleNode {
  const node = makeNode('vless-outbound', position, id);
  node.data.label = label;
  Object.assign(node.data.settings, {
    tag: id,
    address,
    id: 'wayrill-example',
    network: 'raw',
    security: 'tls',
    serverName: `${id}.example.net`,
  });
  node.data.description =
    'Fictional placeholder. Replace with a working VLESS profile before testing.';
  return node;
}

function createTrafficRulesExample(): GraphState {
  const graph = proxyGraph();
  graph.name = 'Traffic rules';
  const routes = makeNode('routing-filter', { x: 320, y: 64 }, 'rules');
  const main = proxyServer('main-proxy', 'Main proxy · replace', { x: 640, y: 300 }, '192.0.2.1');
  const block = makeNode('block-outbound', { x: 640, y: 64 }, 'block');
  graph.nodes.find((node) => node.id === 'direct')!.position = { x: 640, y: 560 };
  Object.assign(
    routes.data.settings,
    tableSettings({
      outputs: [
        { id: 'blocked', name: 'Block' },
        { id: 'local', name: 'Direct' },
        { id: 'main', name: 'Main proxy' },
      ],
      rules: [
        rule('blocked-domain', 'Block example.com', 'blocked', { domain: 'full:example.com' }),
        rule('local-networks', 'Local networks', 'local', {
          ip: '10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\nfc00::/7\nfe80::/10',
        }),
      ],
      defaultOutput: 'main',
    }),
  );
  graph.nodes.push(routes, main, block);
  graph.edges = [
    wire('proxy', 'data', routes.id),
    wire('proxy', 'dns', 'direct'),
    wire(routes.id, 'blocked', block.id),
    wire(routes.id, 'local', 'direct'),
    wire(routes.id, 'main', main.id),
  ];
  graph.mainOutboundId = main.id;
  return enableDefaults(graph);
}

function createDnsRoutingExample(): GraphState {
  const graph = proxyGraph();
  graph.name = 'DNS routing';
  graph.nodes.find((node) => node.id === 'direct')!.position = { x: 640, y: 64 };
  addDns(graph, 'proxy');
  const routing = makeNode('dns-routing-filter', { x: 320, y: 360 }, 'dns-routes');
  const selected = makeNode('dns-servers', { x: 640, y: 280 }, 'selected-dns');
  selected.data.label = 'Quad9 DNS';
  selected.data.settings.servers = JSON.stringify([
    { ...newDnsServer('quad9'), name: 'Quad9', address: '9.9.9.9' },
  ]);
  graph.nodes.find((node) => node.id === 'dns')!.position = { x: 32, y: 360 };
  graph.nodes.find((node) => node.id === 'real-dns')!.position = { x: 640, y: 580 };
  const fallback = readDnsFilter(routing.data.settings).outputs.find((output) => output.fallback)!;
  routing.data.settings.outputs = JSON.stringify([
    { id: 'selected', name: 'Selected domains', fallback: false },
    fallback,
  ]);
  routing.data.settings.rules = JSON.stringify([
    {
      ...newDnsRoute('selected', 'example-domains'),
      name: 'example.org',
      domains: 'domain:example.org',
      finalQuery: true,
    },
  ]);
  graph.nodes.push(routing, selected);
  graph.edges = graph.edges.filter((edge) => edge.source !== 'dns');
  graph.edges.push(
    wire('dns', 'resolver', routing.id),
    wire(routing.id, 'selected', selected.id),
    wire(routing.id, fallback.id, 'real-dns'),
    wire(selected.id, 'queries', 'direct'),
  );
  return enableDefaults(graph);
}

function createTunFakeDnsExample(): GraphState {
  const graph = createFakeDnsExample();
  graph.name = 'TUN · FakeDNS';
  delete graph.defaults;
  const index = graph.nodes.findIndex((node) => node.id === 'fake-input');
  const old = graph.nodes[index];
  graph.nodes[index] = makeNode('tun-inbound', old.position, old.id);
  graph.nodes.find((node) => node.id === 'fake-handler')!.data.settings.queryStrategy = 'UseIP';
  for (const edge of graph.edges)
    if (edge.source === old.id && edge.sourceHandle === 'data') edge.sourceHandle = 'traffic';
  graph.mainOutboundId = 'fake-direct';
  const positions: Record<string, RuleNode['position']> = {
    'fake-input': { x: 32, y: 40 },
    'fake-handler': { x: 32, y: 360 },
    'fake-routing': { x: 320, y: 360 },
    'fake-resolver': { x: 640, y: 250 },
    'fake-real-dns': { x: 640, y: 560 },
    'fake-direct': { x: 640, y: 40 },
  };
  for (const node of graph.nodes) node.position = positions[node.id];
  return enableDefaults(graph);
}

function createCompositeExample(kind: 'policy-group' | 'proxy-chain'): GraphState {
  const graph = proxyGraph();
  graph.name = kind === 'policy-group' ? 'Policy group + Observatory' : 'Proxy chain';
  const composite = makeNode(kind, { x: 320, y: 64 }, 'main');
  const first = proxyServer('server-a', 'Server A · replace', { x: 640, y: 64 }, '192.0.2.1');
  const second = proxyServer('server-b', 'Server B · replace', { x: 640, y: 320 }, '192.0.2.2');
  const members = [first, second].map((node) => ({ type: 'node' as const, nodeId: node.id }));
  composite.data.label = kind === 'policy-group' ? 'Lowest latency' : 'A → B';
  composite.data.settings.tag = 'main';
  graph.nodes.find((node) => node.id === 'direct')!.position = { x: 32, y: 400 };
  graph.nodes.push(composite, first, second);
  graph.edges.find((edge) => edge.sourceHandle === 'data')!.target = composite.id;
  if (kind === 'policy-group') {
    const block = makeNode('block-outbound', { x: 640, y: 600 }, 'block');
    const observer = makeNode('observatory', { x: 320, y: 400 }, 'observatory');
    Object.assign(observer.data.settings, {
      mode: 'standard',
      probeURL: 'https://cp.cloudflare.com/generate_204',
      probeInterval: '30s',
    });
    Object.assign(composite.data.settings, {
      strategy: 'leastPing',
      observe: true,
      fallbackEnabled: true,
      sources: JSON.stringify({
        version: 1,
        manual: members,
        subscriptions: [],
        fallback: { type: 'node', nodeId: block.id },
      }),
    });
    graph.nodes.push(block, observer);
    graph.edges.push(wire(composite.id, 'observation', observer.id));
  } else
    composite.data.settings.steps = JSON.stringify({
      version: 1,
      steps: members.map((outbound, i) => ({ id: `hop-${i + 1}`, outbound })),
    });
  graph.mainOutboundId = composite.id;
  return enableDefaults(graph);
}

function createChainedRoutingExample(): GraphState {
  const graph = proxyGraph();
  graph.name = 'Chained filters';
  const first = makeNode('routing-filter', { x: 320, y: 64 }, 'web-traffic');
  first.data.label = 'Web traffic';
  const second = makeNode('routing-filter', { x: 640, y: 64 }, 'domain-rules');
  second.data.label = 'Web destinations';
  const block = makeNode('block-outbound', { x: 640, y: 400 }, 'block');
  graph.nodes.find((node) => node.id === 'direct')!.position = { x: 320, y: 400 };
  Object.assign(
    first.data.settings,
    tableSettings({
      outputs: [
        { id: 'web', name: 'Inspect web' },
        { id: 'other', name: 'Other traffic' },
      ],
      rules: [rule('web-ports', 'Web ports', 'web', { port: '80,443' })],
      defaultOutput: 'other',
    }),
  );
  Object.assign(
    second.data.settings,
    tableSettings({
      outputs: [
        { id: 'blocked', name: 'Block' },
        { id: 'other', name: 'Direct' },
      ],
      rules: [
        rule('blocked-domain', 'Block example.com', 'blocked', { domain: 'full:example.com' }),
      ],
      defaultOutput: 'other',
    }),
  );
  graph.nodes.push(first, second, block);
  graph.edges.find((edge) => edge.sourceHandle === 'data')!.target = first.id;
  graph.edges.push(
    wire(first.id, 'web', second.id),
    wire(first.id, 'other', 'direct'),
    wire(second.id, 'blocked', block.id),
    wire(second.id, 'other', 'direct'),
  );
  return enableDefaults(graph);
}

export const bundledExamples: readonly BundledExample[] = [
  {
    id: 'proxy',
    label: 'Local proxy → Direct',
    category: 'starter',
    message: 'Local SOCKS / HTTP proxy: 127.0.0.1:10808.',
    create: createProxyStarter,
  },
  {
    id: 'tun',
    label: 'TUN → Direct',
    category: 'starter',
    message: 'TUN starter loaded. Start routing to capture this PC.',
    create: () => createCaptureStarter('tun-inbound'),
  },
  {
    id: 'windivert',
    label: 'WinDivert → Direct',
    category: 'starter',
    message: 'WinDivert starter loaded. Monitored adapters are set in System traffic capture.',
    create: () => createCaptureStarter('windivert-inbound'),
  },
  {
    id: 'traffic',
    label: 'Traffic rules',
    category: 'feature',
    message: 'Replace Main proxy with a working outbound from Stash.',
    create: createTrafficRulesExample,
  },
  {
    id: 'dns',
    label: 'DNS routing',
    category: 'feature',
    message: 'example.org uses Quad9; other DNS requests use Cloudflare.',
    create: createDnsRoutingExample,
  },
  {
    id: 'fakedns',
    label: 'FakeDNS with TUN',
    category: 'feature',
    message: 'TUN sends DNS requests to FakeDNS; real DNS remains connected to Fallback.',
    create: createTunFakeDnsExample,
  },
  {
    id: 'policy',
    label: 'Policy group + Observatory',
    category: 'feature',
    message:
      'Replace Server A and Server B with working outbounds. Unavailable candidates fall back to Block.',
    create: () => createCompositeExample('policy-group'),
  },
  {
    id: 'chain',
    label: 'Proxy chain',
    category: 'feature',
    message: 'Replace Server A and Server B. Chain order: this PC → A → B → destination.',
    create: () => createCompositeExample('proxy-chain'),
  },
  {
    id: 'chained',
    label: 'Chained filters',
    category: 'feature',
    message: 'Web traffic enters a domain filter; its unmatched traffic stays Direct.',
    create: createChainedRoutingExample,
  },
];
