import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { createProxyStarter } from './examples';
import { createDnsExample } from './example';
import { tableSettings } from './rules';
import { compileRuntimeGraph } from './runtime';
import { activityIntensity, activityPortKey, graphActivity, graphActivityPlan } from './activity';
import type { TrafficEndpoint } from '../traffic';
import { configureIcsGraph } from './internetSharing';
import { importXrayConfig } from './xrayImport';

it('lights only matched branches, even with a shared outbound, and retains provenance across worker cloning', () => {
  const graph = createProxyStarter();
  const filter = makeNode('routing-filter', { x: 260, y: 0 }, 'filter');
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'web', name: 'Web' },
        { id: 'rest', name: 'Rest' },
      ],
      defaultOutput: 'rest',
      rules: [
        {
          id: 'web-rule',
          name: 'Web',
          enabled: true,
          matchAll: false,
          output: 'web',
          conditions: { domain: 'full:example.org' },
        },
      ],
    }),
  );
  graph.nodes.push(filter);
  graph.edges = [
    { id: 'input', source: 'proxy', sourceHandle: 'data', target: filter.id, targetHandle: 'in' },
    { id: 'dns', source: 'proxy', sourceHandle: 'dns', target: 'direct', targetHandle: 'in' },
    ...['web', 'rest'].map((port) => ({
      id: port,
      source: filter.id,
      sourceHandle: port,
      target: 'direct',
      targetHandle: 'in',
    })),
  ];
  const compilation = structuredClone(compileRuntimeGraph(graph));
  const index = Number(
    Object.entries(compilation.displayNames!.routing!).find(
      ([, hops]) => hops[0].ruleId === 'web-rule',
    )![0],
  );
  const plan = graphActivityPlan(graph, compilation);
  const endpoints: TrafficEndpoint[] = [
    {
      scope: 'inbound',
      tag: 'local-proxy',
      uploadBytes: '99999999',
      downloadBytes: '99999999',
      uploadPerSecond: 65536,
      downloadPerSecond: 65536,
    },
  ];
  const glow = graphActivity(plan, [{ index, matches: 3 }], endpoints);
  expect([...glow.edges.keys()].sort()).toEqual(['input', 'web']);
  expect(glow.ports.get(activityPortKey('filter', 'source', 'rest'))).toBeUndefined();
  expect(glow.ports.get(activityPortKey('direct', 'target', 'in'))).toBe(activityIntensity(3));
  expect(glow.ports.get(activityPortKey('proxy', 'source', 'data'))).toBeGreaterThan(0);
  // High byte counters must never invent a routing match on any branch.
  const throughputOnly = graphActivity(plan, [], endpoints);
  expect(throughputOnly.edges.size).toBe(0);
  expect(throughputOnly.ports.get(activityPortKey('proxy', 'source', 'data'))).toBeGreaterThan(0);
  const idle = graphActivity(
    plan,
    [],
    endpoints.map((e) => ({ ...e, uploadPerSecond: 0, downloadPerSecond: 0 })),
  );
  expect([...idle.ports.values()].every((v) => v === 0)).toBe(true);
  const disabled = structuredClone(graph);
  disabled.nodes.find((n) => n.id === 'proxy')!.data.enabled = false;
  const inactivePlan = graphActivityPlan(disabled, compilation);
  expect(inactivePlan.inlets.size).toBe(0);
  expect(graphActivity(inactivePlan, [{ index, matches: 3 }]).edges.has('input')).toBe(false);
});

it('keeps Data and DNS input paths distinct when both connect to the same outbound', () => {
  const graph = createProxyStarter();
  const compiled = structuredClone(compileRuntimeGraph(graph));
  const plan = graphActivityPlan(graph, compiled);
  const data = Number(
    Object.entries(compiled.activityInputs!).find(([, input]) => input.port === 'data')![0],
  );
  const dns = Number(
    Object.entries(compiled.activityInputs!).find(([, input]) => input.port === 'dns')![0],
  );
  expect([...graphActivity(plan, [{ index: data, matches: 1 }]).edges.keys()]).toEqual([
    'proxy-data',
  ]);
  expect([...graphActivity(plan, [{ index: dns, matches: 1 }]).edges.keys()]).toEqual([
    'proxy-dns',
  ]);
});

it('lights routed DNS queries without lighting another resolver that shares the outbound', () => {
  const graph = createDnsExample();
  graph.edges.find((edge) => edge.id === 'remote-query')!.target = 'direct';
  const compiled = structuredClone(compileRuntimeGraph(graph));
  const servers = (compiled.config.dns as { servers: { tag: string }[] }).servers;
  const rules = (compiled.config.routing as { rules: { inboundTag?: string[] }[] }).rules;
  const remote = servers.slice(1).map((server) => ({
    index: rules.findIndex((rule) => rule.inboundTag?.includes(server.tag)),
    matches: 1,
  }));
  expect(remote.every((rule) => rule.index >= 0)).toBe(true);
  const glow = graphActivity(graphActivityPlan(graph, compiled), remote);
  expect([...glow.edges.keys()]).toEqual(['remote-query']);
  expect(glow.ports.get(activityPortKey('remote-dns', 'source', 'queries'))).toBe(
    activityIntensity(2),
  );
  expect(glow.ports.has(activityPortKey('local-dns', 'source', 'queries'))).toBe(false);
});

it('retains the dedicated ICS path added to an imported Xray graph', () => {
  const imported = importXrayConfig(
    JSON.stringify({
      inbounds: [
        { tag: 'proxy', protocol: 'socks', listen: '127.0.0.1', port: 10808, settings: {} },
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
      routing: { rules: [] },
    }),
  );
  const graph = configureIcsGraph(
    imported,
    {
      version: 'a'.repeat(64),
      managed: false,
      recoveryPending: false,
      lastError: null,
      supported: true,
      connections: [],
      pair: {
        public: { id: '00000000-0000-0000-0000-000000000001', name: 'Uplink' },
        private: { id: '00000000-0000-0000-0000-000000000002', name: 'LAN' },
      },
    },
    { x: 0, y: 300 },
    false,
  );
  const compiled = structuredClone(compileRuntimeGraph(graph));
  const source = graph.nodes.find((n) => n.data.kind === 'ics-tun')!;
  const rules = (compiled.config.routing as { rules: { inboundTag?: string[] }[] }).rules;
  const index = rules.findIndex((r) => r.inboundTag?.includes(String(source.data.settings.tag)));
  expect(index).toBeGreaterThanOrEqual(0);
  const glow = graphActivity(graphActivityPlan(graph, compiled), [{ index, matches: 1 }]);
  expect([...glow.edges.keys()]).toEqual([graph.edges.find((e) => e.source === source.id)!.id]);
});
