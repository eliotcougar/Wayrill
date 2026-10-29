import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound } from './catalog';
import { createChainedExample } from './chainedExample';
import { RoutingPathError, intersectPredicates, routingPaths } from './routingPaths';
import { readRuleTable, routingRuleFields, tableSettings, type TableRule } from './rules';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
import { diagnoseRuntimeGraph } from './diagnostics';
import { parseGraph, serializeGraph } from './model';
import type { GraphState, RuleNode } from './types';

type Packet = {
  inboundTag: string;
  port: number;
  network: string;
  domain: string;
  protocol: string;
};
type Fields = Record<string, unknown>;
// Independent evaluator: follow the original graph one rule at a time. No path
// expansion or predicate intersection code is used to compute expected results.
function matches(fields: Fields, packet: Packet) {
  return Object.entries(fields).every(([key, value]) => {
    if (key === 'type') return true;
    if (key === 'port')
      return String(value)
        .split(',')
        .some((r) => {
          const [low, high = low] = r.split('-').map(Number);
          return low <= packet.port && packet.port <= high;
        });
    if (key === 'domain')
      return (value as string[]).some((d) => {
        const [kind, ...nameParts] = d.split(':'),
          name = nameParts.join(':').toLowerCase();
        const host = packet.domain.toLowerCase();
        return kind === 'full' ? host === name : host === name || host.endsWith(`.${name}`);
      });
    if (key === 'network') return String(value).split(',').includes(packet.network);
    if (key === 'protocol')
      return !!packet.protocol && (value as string[]).some((p) => packet.protocol.startsWith(p));
    return (value as string[]).includes(packet[key as keyof Packet] as string);
  });
}
function follow(graph: GraphState, id: string, packet: Packet): string {
  const node = graph.nodes.find((n) => n.id === id)!;
  if (node.data.kind !== 'routing-filter') return String(node.data.settings.tag);
  const table = readRuleTable(node.data.settings);
  const row = table.rules.find(
    (r) => r.enabled && (r.matchAll || matches(routingRuleFields(r), packet)),
  );
  const port = row?.output ?? table.defaultOutput;
  return follow(
    graph,
    graph.edges.find((e) => e.source === id && e.sourceHandle === port)!.target,
    packet,
  );
}
function expected(graph: GraphState, packet: Packet) {
  const input = graph.nodes.find((n) => n.data.settings.tag === packet.inboundTag)!;
  const port =
    packet.port === 53 && (input.data.settings.mode !== 'http' || packet.network === 'tcp')
      ? 'dns'
      : 'data';
  return follow(
    graph,
    graph.edges.find((e) => e.source === input.id && e.sourceHandle === port)!.target,
    packet,
  );
}
function actual(config: Record<string, unknown>, packet: Packet) {
  const rule = (config.routing as { rules: Fields[] }).rules.find((r) =>
    matches(
      Object.fromEntries(
        Object.entries(r).filter(([k]) => !['outboundTag', 'balancerTag'].includes(k)),
      ),
      packet,
    ),
  );
  return String(
    rule?.outboundTag ?? rule?.balancerTag ?? (config.outbounds as { tag: string }[])[0].tag,
  );
}
const change = (node: RuleNode, rules: TableRule[], defaultOutput = 'blocked') => {
  const table = readRuleTable(node.data.settings);
  Object.assign(node.data.settings, tableSettings({ ...table, rules, defaultOutput }));
};
const rule = (
  id: string,
  conditions: Record<string, string>,
  output = 'shared',
  matchAll = false,
): TableRule => ({ id, name: id, conditions, output, enabled: true, matchAll });
function assertEquivalent(graph: GraphState) {
  const config = compileRuntimeGraph(parseGraph(serializeGraph(graph))).config;
  const inputs = graph.nodes.filter(
    (n) => n.data.kind === 'proxy-inbound' && n.data.enabled !== false,
  );
  expect(inputs.length).toBeGreaterThan(0);
  for (const inbound of inputs)
    for (const port of [22, 53, 80, 81, 100, 443, 444, 1000, 1500, 2000, 2001])
      for (const network of ['tcp', 'udp'])
        for (const domain of ['', 'example.net', 'a.example.net', 'other.net'])
          for (const protocol of ['', 'http', 'tls']) {
            const packet = {
              inboundTag: String(inbound.data.settings.tag),
              port,
              network,
              domain,
              protocol,
            };
            expect(actual(config, packet), JSON.stringify(packet)).toBe(expected(graph, packet));
          }
  return config;
}

describe('Flattened routing paths', () => {
  it('preserves parent precedence, child defaults and shared branches across two input scopes', () => {
    const graph = createChainedExample(),
      root = graph.nodes.find((n) => n.id === 'entry-filter')!;
    // A later parent TLS rule must not rescue a packet rejected by the child.
    change(root, [
      rule('web', { port: '80,443' }),
      rule('later', { protocol: 'tls' }, 'blocked'),
      rule('udp', { network: 'udp' }),
    ]);
    const http = makeProxyInbound('http', { x: 0, y: 0 }, 'second-input');
    Object.assign(http.data.settings, { tag: 'second', port: 2081 });
    graph.nodes.push(http);
    for (const port of ['dns', 'data'])
      graph.edges.push({
        id: `second-${port}`,
        source: http.id,
        sourceHandle: port,
        target: port === 'dns' ? 'test-block' : root.id,
        targetHandle: 'in',
      });
    const config = assertEquivalent(graph);
    const rules = (config.routing as { rules: Fields[] }).rules;
    expect(rules.slice(2, 4)).toMatchObject([
      { port: '80,443', domain: ['domain:example.net'], balancerTag: 'policy-group' },
      { port: '80,443', outboundTag: 'block' },
    ]);
  });
  it('imports the flattened config into a flatter graph and exports identical Xray behavior', () => {
    const graph = createChainedExample(),
      config = assertEquivalent(graph);
    const imported = importXrayConfig(JSON.stringify(config));
    expect(imported.nodes.filter((n) => n.data.kind === 'routing-filter')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.data.kind === 'routing-filter')).toHaveLength(2);
    expect(compileXrayGraph(parseGraph(serializeGraph(imported))).config).toEqual(config);
  });
  it('attaches non-expressible intersections and cycles to the responsible node', () => {
    const graph = createChainedExample(),
      root = graph.nodes.find((n) => n.id === 'entry-filter')!,
      child = graph.nodes.find((n) => n.id === 'shared-filter')!;
    change(root, [rule('parent', { domain: 'geosite:category-ads-all' })]);
    change(child, [rule('child', { domain: 'regexp:.*' }, 'group')]);
    const issues = diagnoseRuntimeGraph(graph);
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: child.id,
        severity: 'error',
        message: expect.stringContaining('cannot combine'),
      }),
    );
    change(root, [rule('parent', {})]);
    change(child, [rule('child', {}, 'group')]);
    graph.edges.find((e) => e.source === child.id && e.sourceHandle === 'group')!.target = root.id;
    expect(() =>
      routingPaths(graph).expand(root, {}, { terminal: () => ({ outboundTag: 'block' }) }),
    ).toThrow(RoutingPathError);
  });
  it('bounds exponential shared-branch expansion without a large canvas', () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
        makeNode('routing-filter', { x: 0, y: 0 }, `f-${i}`),
      ),
      out = makeNode('block-outbound', { x: 0, y: 0 }, 'end');
    const graph: GraphState = { name: 'Bounded DAG', nodes: [...nodes, out], edges: [] };
    for (const [i, node] of nodes.entries()) {
      Object.assign(
        node.data.settings,
        tableSettings({
          outputs: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          rules: [rule('repeat', {}, 'a')],
          defaultOutput: 'b',
        }),
      );
      for (const sourceHandle of ['a', 'b'])
        graph.edges.push({
          id: `${i}-${sourceHandle}`,
          source: node.id,
          sourceHandle,
          target: nodes[i + 1]?.id ?? out.id,
          targetHandle: 'in',
        });
    }
    expect(() =>
      routingPaths(graph).expand(nodes[0], {}, { terminal: () => ({ outboundTag: 'block' }) }),
    ).toThrow(/expanded routing exceeds|expansion exceeds/);
  });
});

describe('Representable predicate intersections', () => {
  it('intersects each OR list rather than widening it', () => {
    expect(
      intersectPredicates(
        {
          network: 'tcp,udp',
          port: '80,100-300',
          sourcePort: '1000-2000',
          protocol: ['tls', 'http'],
        },
        { network: 'udp', port: '200-400', sourcePort: '1500-2500', protocol: ['http'] },
      ),
    ).toEqual({ network: 'udp', port: '200-300', sourcePort: '1500-2000', protocol: ['http'] });
    expect(intersectPredicates({ inboundTag: ['a'] }, { inboundTag: ['b'] })).toBeNull();
    expect(intersectPredicates({ vlessRoute: '0-10' }, { vlessRoute: '10-20' })).toEqual({
      vlessRoute: '10',
    });
  });
  it('preserves identical opaque predicates and rejects unrepresentable conjunctions', () => {
    expect(
      intersectPredicates(
        { domain: ['geosite:cn'], sourceIP: ['geoip:private'] },
        { domain: ['geosite:cn'] },
      ),
    ).toEqual({ domain: ['geosite:cn'], sourceIP: ['geoip:private'] });
    expect(() =>
      intersectPredicates({ domain: ['geosite:cn'] }, { domain: ['geosite:geolocation-!cn'] }),
    ).toThrow(/Opaque/);
    expect(
      intersectPredicates({ attrs: { ':method': 'GET' } }, { attrs: { ':path': 'foo' } }),
    ).toEqual({ attrs: { ':method': 'GET', ':path': 'foo' } });
    expect(() =>
      intersectPredicates({ attrs: { ':method': 'GET' } }, { attrs: { ':method': 'POST' } }),
    ).toThrow(/Different expressions/);
  });
});
