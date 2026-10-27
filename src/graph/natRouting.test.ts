import { expect, it } from 'vitest';
import { makeNode, getOutputPorts, portLabel } from './catalog';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { connectionProblem } from './structure';
import { tableSettings, type TableRule } from './rules';
import { natRuleVariants } from './natRouting';
import { NAT_ROUTING_TAG } from './tun';
import { importXrayConfig } from './xrayImport';
import { diagnoseRuntimeGraph } from './diagnostics';
import { updateGraphNode } from './model';
import type { GraphState } from './types';

const edge = (source: string, sourceHandle: string, target: string) => ({
  id: source + sourceHandle + target,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
function fixture(separate = true): GraphState {
  const tun = makeNode('tun-inbound', { x: 0, y: 0 }, 'tun');
  tun.data.settings.separateNatTraffic = separate;
  const direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  const block = makeNode('block-outbound', { x: 400, y: 200 }, 'block');
  return {
    name: 'NAT',
    defaults: factoryDefaults(),
    nodes: [tun, direct, block],
    edges: [
      edge('tun', 'traffic', 'block'),
      ...(separate ? [edge('tun', 'nat-data', 'direct')] : []),
    ],
  };
}
function rules(g: GraphState) {
  return (compileRuntimeGraph(g).config.routing as { rules: Record<string, unknown>[] }).rules;
}
const row: TableRule = {
  id: 'source',
  name: 'Guest',
  enabled: true,
  matchAll: false,
  output: 'chosen',
  targetMatch: 'all',
  conditions: { sourceIP: '172.30.0.0/16', sourcePort: '53000', domain: 'domain:example.com' },
};

it('retains NAT classification without separate outputs and persists the opt-in', () => {
  const ordinary = fixture(false);
  expect(getOutputPorts('tun-inbound', ordinary.nodes[0].data)).toEqual(['traffic', 'dns']);
  expect(compileRuntimeGraph(ordinary).capture?.inputs[0]).toMatchObject({
    source: 'tun',
    predicates: [],
    masks: ['0'],
  });
  expect(compileRuntimeGraph(ordinary).capture?.inputs[0].natTag).toBe(NAT_ROUTING_TAG);
  const split = parseGraph(serializeGraph(fixture()));
  expect(getOutputPorts('tun-inbound', split.nodes[0].data)).toEqual([
    'traffic',
    'dns',
    'nat-data',
    'nat-dns',
  ]);
  expect(portLabel('nat-data', split.nodes[0].data)).toBe('NAT Data');
  expect(compileRuntimeGraph(split).capture?.inputs[0].natTag).toBe(NAT_ROUTING_TAG);
  expect(rules(split)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ inboundTag: [NAT_ROUTING_TAG], outboundTag: 'direct' }),
      expect.objectContaining({ inboundTag: ['tun-inbound'], outboundTag: 'block' }),
    ]),
  );
});
it('requires NAT Data while leaving NAT DNS optional', () => {
  const g = fixture();
  expect(() => rules(g)).not.toThrow();
  expect(diagnoseRuntimeGraph(g).filter((issue) => issue.severity === 'error')).toEqual([]);
  const ordinary = updateGraphNode(g, 'tun', {
    settings: { ...g.nodes[0].data.settings, separateNatTraffic: false },
  });
  expect(ordinary.edges.map((edge) => edge.sourceHandle)).toEqual(['traffic']);
  expect(() => rules(ordinary)).not.toThrow();
  g.edges = g.edges.filter((e) => e.sourceHandle !== 'nat-data');
  expect(() => rules(g)).toThrow(/nat-data/);
});
it('compiles NAT DNS before NAT Data and enforces DNS-compatible connections', () => {
  const g = fixture(),
    dns = makeNode('dns-handler', { x: 0, y: 300 }, 'dns'),
    servers = makeNode('dns-servers', { x: 300, y: 300 }, 'servers');
  g.nodes.push(dns, servers);
  expect(connectionProblem(g, edge('tun', 'nat-data', 'dns'))).toMatch(/DNS output/);
  expect(connectionProblem(g, edge('tun', 'nat-dns', 'dns'))).toBeNull();
  g.edges.push(
    edge('tun', 'nat-dns', 'dns'),
    edge('dns', 'resolver', 'servers'),
    edge('servers', 'queries', 'direct'),
  );
  const selected = rules(g).filter(
    (r) => JSON.stringify(r.inboundTag) === JSON.stringify([NAT_ROUTING_TAG]),
  );
  expect(selected[0]).toMatchObject({ network: 'tcp,udp', port: '53', outboundTag: 'dns-handler' });
  expect(selected[1]).toMatchObject({ outboundTag: 'direct' });
});
it('preserves guest source conditions, ordered rules and fallback', () => {
  const g = fixture(),
    filter = makeNode('routing-filter', { x: 200, y: 200 }, 'filter');
  filter.data.settings = {
    ...filter.data.settings,
    ...tableSettings({
      outputs: [
        { id: 'chosen', name: 'Guest' },
        { id: 'fallback', name: 'Other' },
      ],
      defaultOutput: 'fallback',
      rules: [row],
    }),
  };
  g.nodes.push(filter);
  g.edges = g.edges.filter((e) => e.sourceHandle !== 'nat-data');
  g.edges.push(
    edge('tun', 'nat-data', 'filter'),
    edge('filter', 'chosen', 'direct'),
    edge('filter', 'fallback', 'block'),
  );
  const selected = rules(g).filter(
    (r) => JSON.stringify(r.inboundTag) === JSON.stringify([NAT_ROUTING_TAG]),
  );
  expect(selected[0]).toMatchObject({
    sourceIP: ['172.30.0.0/16'],
    sourcePort: '53000',
    domain: ['domain:example.com'],
    outboundTag: 'direct',
  });
  expect(selected[1]).toMatchObject({ outboundTag: 'block' });
});
it('never broadens host identity AND predicates, and retains non-identity OR alternatives', () => {
  const app = {
    kind: 'process' as const,
    value: 'browser.exe',
    enabled: true,
    mode: 'name' as const,
    children: true,
  };
  expect(natRuleVariants({ ...row, applications: [app] })).toEqual([]);
  expect(natRuleVariants({ ...row, applications: [app], targetMatch: 'any' })).toEqual([
    { sourceIP: ['172.30.0.0/16'], sourcePort: '53000', domain: ['domain:example.com'] },
  ]);
  expect(natRuleVariants({ ...row, conditions: { user: 'somebody' } })).toEqual([]);
  expect(
    natRuleVariants({ ...row, conditions: { inboundTag: 'tun-inbound' } }, ['tun-inbound']),
  ).toEqual([{ inboundTag: [NAT_ROUTING_TAG] }]);
  expect(natRuleVariants({ ...row, conditions: { inboundTag: 'proxy' } }, ['tun-inbound'])).toEqual(
    [],
  );
});
it('supports separate NAT paths on imported global-routing graphs', () => {
  const g = importXrayConfig(
    JSON.stringify({
      inbounds: [
        {
          tag: 'tun-inbound',
          protocol: 'tun',
          settings: {
            name: 'Wayrill-TUN',
            gateway: ['10.90.0.1/30'],
            autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1'],
            autoOutboundsInterface: 'auto',
          },
        },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
      ],
      routing: { rules: [{ type: 'field', domain: ['domain:example.com'], outboundTag: 'block' }] },
    }),
  );
  const tun = g.nodes.find((n) => n.data.kind === 'tun-inbound')!;
  const direct = g.nodes.find((n) => n.data.settings.tag === 'direct')!;
  tun.data.settings.separateNatTraffic = true;
  g.edges.push(edge(tun.id, 'nat-data', direct.id));
  expect(rules(g)[0]).toMatchObject({ inboundTag: [NAT_ROUTING_TAG], outboundTag: 'direct' });
  expect(diagnoseRuntimeGraph(g).filter((issue) => issue.portId === 'nat-dns')).toEqual([]);
  g.edges = g.edges.filter((edge) => edge.sourceHandle !== 'nat-data');
  expect(diagnoseRuntimeGraph(g)).toContainEqual(
    expect.objectContaining({ severity: 'error', portId: 'nat-data' }),
  );
});
