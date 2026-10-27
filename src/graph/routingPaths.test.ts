import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  it('flattens a third filter, intersects port ranges, and gives DNS branches global priority', () => {
    const graph = createChainedExample(),
      root = graph.nodes.find((n) => n.id === 'entry-filter')!,
      child = graph.nodes.find((n) => n.id === 'shared-filter')!;
    change(root, [rule('range', { port: '1000-2000' })]);
    const third = makeNode('routing-filter', { x: 0, y: 0 }, 'third');
    Object.assign(third.data.settings, child.data.settings);
    third.data.label = 'Third filter';
    change(child, [rule('narrow', { port: '1500-2500' }, 'group')]);
    graph.edges.find((e) => e.source === child.id && e.sourceHandle === 'group')!.target = third.id;
    graph.nodes.push(third);
    graph.edges.push(
      {
        id: 'third-group',
        source: third.id,
        sourceHandle: 'group',
        target: 'test-group',
        targetHandle: 'in',
      },
      {
        id: 'third-blocked',
        source: third.id,
        sourceHandle: 'blocked',
        target: 'test-block',
        targetHandle: 'in',
      },
    );
    graph.edges.find((e) => e.source === 'policy-input' && e.sourceHandle === 'dns')!.target =
      child.id;
    const config = assertEquivalent(graph);
    expect((config.routing as { rules: Fields[] }).rules[0]).toMatchObject({
      port: '53',
      outboundTag: 'block',
    });
    expect((config.routing as { rules: Fields[] }).rules.some((r) => r.port === '1500-2000')).toBe(
      true,
    );
  });
  it('keeps disabled drafts inert and stops after a match-all rule', () => {
    const graph = createChainedExample(),
      root = graph.nodes.find((n) => n.id === 'entry-filter')!;
    change(root, [
      { ...rule('disabled', { port: 'invalid' }), enabled: false },
      rule('catchall', {}, 'shared', true),
      rule('dead', { port: '443' }, 'blocked'),
    ]);
    assertEquivalent(graph);
  });
  it('imports the flattened config into a flatter graph and exports identical Xray behavior', () => {
    const graph = createChainedExample(),
      config = assertEquivalent(graph);
    const imported = importXrayConfig(JSON.stringify(config));
    expect(imported.nodes.filter((n) => n.data.kind === 'routing-filter')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.data.kind === 'routing-filter')).toHaveLength(2);
    expect(compileXrayGraph(parseGraph(serializeGraph(imported))).config).toEqual(config);
  });
  it('flattens added filters in a native graph while preserving the first outbound default', () => {
    const config = {
      inbounds: [
        { tag: 'client', protocol: 'mixed', listen: '127.0.0.1', port: 20901, settings: {} },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
      ],
      routing: { rules: [{ domain: ['domain:example.net'], outboundTag: 'block' }] },
    };
    const graph = importXrayConfig(JSON.stringify(config)),
      root = graph.nodes.find((n) => n.data.kind === 'routing-filter')!,
      child = makeNode('routing-filter', { x: 0, y: 0 }, 'child');
    Object.assign(
      child.data.settings,
      tableSettings({
        outputs: [
          { id: 'blocked', name: 'Block' },
          { id: 'direct', name: 'Direct' },
        ],
        rules: [rule('https', { port: '443' }, 'blocked')],
        defaultOutput: 'direct',
      }),
    );
    graph.nodes.push(child);
    graph.edges.find(
      (e) =>
        e.source === root.id &&
        e.sourceHandle === readRuleTable(root.data.settings).rules[0].output,
    )!.target = child.id;
    for (const [sourceHandle, tag] of [
      ['blocked', 'block'],
      ['direct', 'direct'],
    ])
      graph.edges.push({
        id: `child-${sourceHandle}`,
        source: child.id,
        sourceHandle,
        target: graph.nodes.find((n) => n.data.settings.tag === tag)!.id,
        targetHandle: 'in',
      });
    const flattened = compileXrayGraph(graph).config;
    expect((flattened.routing as { rules: Fields[] }).rules).toEqual([
      { domain: ['domain:example.net'], port: '443', outboundTag: 'block' },
      { domain: ['domain:example.net'], outboundTag: 'direct' },
    ]);
    expect(compileXrayGraph(importXrayConfig(JSON.stringify(flattened))).config).toEqual(flattened);
    const table = readRuleTable(root.data.settings);
    table.rules[0].native!.original.ruleTag = 'branch-side-effect';
    Object.assign(root.data.settings, tableSettings(table));
    expect(() => compileXrayGraph(graph)).toThrow(/native ruleTag metadata/);
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
  it('handles literal domains and nested IPv4/IPv6 networks', () => {
    expect(
      intersectPredicates(
        { domain: ['domain:example.net'] },
        { domain: ['full:A.example.net', 'domain:other.net'] },
      ),
    ).toEqual({ domain: ['full:A.example.net'] });
    expect(
      intersectPredicates({ domain: ['full:a.example.net'] }, { domain: ['full:b.example.net'] }),
    ).toBeNull();
    expect(
      intersectPredicates(
        { ip: ['10.0.0.0/8', '2001:db8::/32'] },
        { ip: ['10.2.0.0/16', '2001:db8:1234::/48'] },
      ),
    ).toEqual({ ip: ['10.2.0.0/16', '2001:db8:1234::/48'] });
    expect(intersectPredicates({ ip: ['10.0.0.0/8'] }, { ip: ['192.168.0.0/16'] })).toBeNull();
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

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
it.skipIf(!core || !dir)(
  'accepts the flattened shared-branch example in the configured core',
  () => {
    const graph = createChainedExample(),
      config = compileRuntimeGraph(graph).config;
    mkdirSync(dir!, { recursive: true });
    const file = join(dir!, 'chained-policy.xray.json');
    writeFileSync(file, JSON.stringify(config, null, 2));
    writeFileSync(join(dir!, 'chained-policy.wayrill.json'), serializeGraph(graph));
    const result = spawnSync(core!, ['run', '-test', '-config', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  },
);

it('names the upstream row and output in a disjoint shared-branch warning', () => {
  const graph = createChainedExample(),
    root = graph.nodes.find((n) => n.id === 'entry-filter')!,
    child = graph.nodes.find((n) => n.id === 'shared-filter')!;
  change(root, [{ ...rule('parent-https', { port: '443' }), name: 'Parent HTTPS' }]);
  change(child, [{ ...rule('child-http', { port: '80' }, 'group'), name: 'Child HTTP' }]);
  const paths = routingPaths(graph);
  paths.expand(
    root,
    { inboundTag: ['local'] },
    { terminal: (node) => ({ outboundTag: String(node.data.settings.tag) }) },
  );
  expect(paths.warnings).toContainEqual(
    expect.stringContaining('Application routes / Parent HTTPS → Inspect destination'),
  );
  expect(paths.warnings).toContainEqual(expect.stringContaining('"port":"443"'));
  expect(paths.warnings).toContainEqual(
    expect.stringContaining('Other entering paths may still match'),
  );
});
