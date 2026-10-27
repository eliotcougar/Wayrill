import { expect, it } from 'vitest';
import {
  configureIcsGraph,
  hasIcsCapture,
  sharedRuleVariants,
  icsNodeProblems,
  configureSharedIpv6Host,
  sharedIpv6Ready,
  type SharingInspection,
} from './internetSharing';
import { makeNode, makeProxyInbound, getDefinition, getOutputPorts } from './catalog';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { canDuplicateNode } from './editing';
import { tableSettings, readRuleTable, type TableRule } from './rules';
import type { GraphState } from './types';
import { protocolProblems } from './protocols';

const sharing: SharingInspection = {
  version: 'a'.repeat(64),
  managed: false,
  recoveryPending: false,
  lastError: null,
  supported: true,
  connections: [],
  pair: {
    public: { id: '00000000-0000-0000-0000-000000000001', name: 'Ethernet' },
    private: { id: '00000000-0000-0000-0000-000000000002', name: 'TV LAN' },
  },
};
const empty = (): GraphState => ({
  name: 'ICS',
  defaults: factoryDefaults(),
  nodes: [],
  edges: [],
});
it('opens a saved Direct without optional ICS binding and preserves its executable configuration', () => {
  const graph = empty();
  const proxy = makeProxyInbound('mixed', { x: 0, y: 0 });
  const direct = makeNode('direct-outbound', { x: 300, y: 0 });
  graph.nodes.push(proxy, direct);
  for (const port of ['data', 'dns'])
    graph.edges.push({
      id: port,
      source: proxy.id,
      sourceHandle: port,
      target: direct.id,
      targetHandle: 'in',
    });
  const expected = compileRuntimeGraph(graph);
  delete direct.data.settings.icsUpstream;
  const reopened = parseGraph(serializeGraph(graph));
  expect(reopened.nodes.find((n) => n.id === direct.id)?.data.settings.icsUpstream).toBeUndefined();
  expect(compileRuntimeGraph(reopened).config).toEqual(expected.config);
  expect(compileRuntimeGraph(reopened).capture?.tunSharing).toBeUndefined();
});
it.each([true, false])('preserves an explicit ICS binding value %s', (value) => {
  const graph = empty();
  const direct = makeNode('direct-outbound', { x: 0, y: 0 });
  direct.data.settings.icsUpstream = value;
  graph.nodes.push(direct);
  expect(parseGraph(serializeGraph(graph)).nodes[0].data.settings.icsUpstream).toBe(value);
});
it.each(['false', 'true', null, 0, 1])('rejects malformed optional ICS binding %s', (value) => {
  const graph = empty();
  graph.nodes.push(makeNode('direct-outbound', { x: 0, y: 0 }));
  const saved = JSON.parse(serializeGraph(graph));
  saved.nodes[0].data.settings.icsUpstream = value;
  expect(() => parseGraph(JSON.stringify(saved))).toThrow('Invalid Use ICS upstream');
});
it('creates a standalone Data-only source, dedicated upstream Direct and optional valid filter in one graph change', () => {
  const graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, true);
  expect(graph.nodes.map((n) => n.data.kind)).toEqual([
    'ics-tun',
    'direct-outbound',
    'routing-filter',
  ]);
  expect(getDefinition('ics-tun').group).toBe('Local capture');
  expect(getOutputPorts('ics-tun')).toEqual(['traffic']);
  expect(canDuplicateNode(graph.nodes[0], graph)).toBe(false);
  expect(icsNodeProblems(graph)).toEqual([]);
  expect(protocolProblems(graph.nodes[0].data)).toEqual([]);
  const compiled = compileRuntimeGraph(graph);
  expect(compiled.summary.listeners).toEqual([]);
  expect(compiled.capture?.tunSharing).toEqual({
    tag: 'ics-traffic',
    expectedVersion: sharing.version,
    publicId: sharing.pair!.public.id,
    privateId: sharing.pair!.private.id,
    upstreamTags: ['ics-upstream'],
    ipv6: false,
  });
  expect(compiled.capture?.inputs).toEqual([]);
  expect(compiled.config.inbounds).toEqual([
    expect.objectContaining({
      protocol: 'tun',
      tag: 'ics-traffic',
      settings: expect.objectContaining({ autoSystemRoutingTable: [] }),
    }),
  ]);
  expect(JSON.stringify(compiled.config)).not.toMatch(/expectedVersion|publicId|icsUpstream/);
  expect(parseGraph(serializeGraph(graph)).nodes).toHaveLength(3);
});
it('reuses even a disabled source, preserves an intentional Block connection and prevents duplicate imports', () => {
  let graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, false);
  graph.nodes[0].data.enabled = false;
  const block = makeNode('block-outbound', { x: 700, y: 200 });
  graph.nodes.push(block);
  graph.edges[0].target = block.id;
  graph = configureIcsGraph(graph, sharing, { x: 100, y: 100 }, true);
  expect(graph.nodes.filter((n) => n.data.kind === 'ics-tun')).toHaveLength(1);
  expect(graph.edges[0].target).toBe(block.id);
  expect(graph.nodes[0].data.kind).toBe('direct-outbound');
  expect(graph.nodes.find((n) => n.data.kind === 'ics-tun')?.data.enabled).toBe(true);
  const copy = structuredClone(graph.nodes.find((n) => n.data.kind === 'ics-tun')!);
  copy.id = 'duplicate';
  copy.data.enabled = false;
  graph.nodes.push(copy);
  expect(() => parseGraph(serializeGraph(graph))).toThrow(/one ICS TUN/);
});
it('does not reuse a Direct outbound with different effective behavior or overwrite its settings', () => {
  const graph = empty(),
    direct = makeNode('direct-outbound', { x: 0, y: 0 });
  direct.data.settings.redirect = '192.0.2.1:8080';
  graph.nodes.push(direct);
  const next = configureIcsGraph(graph, sharing, { x: 300, y: 100 }, false);
  expect(next.nodes.filter((n) => n.data.kind === 'direct-outbound')).toHaveLength(2);
  expect(next.nodes.find((n) => n.id === direct.id)?.data.settings.redirect).toBe('192.0.2.1:8080');
});
const row = (all: boolean): TableRule => ({
  id: 'app',
  name: 'App and site',
  output: 'default',
  enabled: true,
  matchAll: false,
  targetMatch: all ? 'all' : 'any',
  conditions: { domain: 'full:example.com', port: '443', network: 'tcp' },
  applications: [
    {
      kind: 'process',
      value: 'app.exe',
      mode: 'name',
      children: true,
      enabled: true,
    },
  ],
});
it('keeps eligible OR destinations and common conditions; never broadens an unsupported AND variant', () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    warnings: string[] = [];
  expect(sharedRuleVariants(row(false), false, warnings, node)).toEqual([
    { domain: ['full:example.com'], port: '443', network: 'tcp' },
  ]);
  expect(warnings).toHaveLength(1);
  expect(() => sharedRuleVariants(row(true), false, [], node)).toThrow(/Disable this rule/);
  expect(sharedRuleVariants(row(true), true, [], node)).toEqual([]);
});
it('compiles shared host/ICS filters with separate application scope and retained fallback', () => {
  const graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, true);
  const filter = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  const tun = makeNode('tun-inbound', { x: 0, y: 300 });
  graph.nodes.push(tun);
  graph.edges.push({
    id: 'host',
    source: tun.id,
    sourceHandle: 'traffic',
    target: filter.id,
    targetHandle: 'in',
  });
  filter.data.settings = tableSettings({
    ...readRuleTable(filter.data.settings),
    rules: [row(true)],
  });
  const compiled = compileRuntimeGraph(graph);
  const rules = (compiled.config.routing as { rules: Record<string, unknown>[] }).rules;
  const shared = rules.filter((r) => (r.inboundTag as string[]).includes('ics-traffic'));
  expect(shared).toEqual([
    { type: 'field', inboundTag: ['ics-traffic'], outboundTag: 'ics-upstream' },
  ]);
  expect(compiled.capture?.inputs).toEqual([
    expect.objectContaining({
      source: 'tun',
      tag: 'tun-inbound',
      predicates: expect.any(Array),
    }),
  ]);
  expect(rules.some((r) => (r.inboundTag as string[]).includes('tun-inbound') && r.user)).toBe(
    true,
  );
});
it('rejects source/client identity in ICS-only rules instead of matching the NAT address', () => {
  const graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, true),
    filter = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  filter.data.settings = tableSettings({
    ...readRuleTable(filter.data.settings),
    rules: [
      {
        ...row(false),
        applications: [],
        conditions: { sourceIP: '192.168.137.2' },
      },
    ],
  });
  expect(() => compileRuntimeGraph(graph)).toThrow(/identity|source/);
});
it('cannot silently configure an unknown, unsupported or recovering sharing pair', () => {
  for (const value of [
    { ...sharing, pair: null },
    { ...sharing, supported: false },
    { ...sharing, recoveryPending: true },
  ])
    expect(() => configureIcsGraph(empty(), value, { x: 0, y: 0 }, false)).toThrow();
});

it('requires host IPv6 and adds a wired dual-stack host in one explicit draft action', () => {
  const graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, false);
  graph.nodes[0].data.settings.shareIpv6 = true;
  expect(icsNodeProblems(graph).some((p) => p.fieldKey === 'shareIpv6')).toBe(true);
  const next = configureSharedIpv6Host(graph);
  expect(sharedIpv6Ready(next)).toBe(true);
  expect(sharedIpv6Ready(graph)).toBe(false);
  expect(icsNodeProblems(next)).toEqual([]);
  const compiled = compileRuntimeGraph(next);
  expect(compiled.capture?.tunSharing?.ipv6).toBe(true);
  expect(next.nodes.filter((n) => n.data.kind === 'tun-inbound')).toHaveLength(1);
  expect(JSON.stringify(compiled.config)).not.toContain('shareIpv6');
});
it('preserves host wiring and named uplink when explicitly enabling shared IPv6', () => {
  const graph = configureIcsGraph(empty(), sharing, { x: 0, y: 0 }, false);
  const host = makeNode('tun-inbound', { x: 0, y: 300 });
  host.data.enabled = false;
  const native = JSON.parse(String(host.data.settings.json));
  native.settings.autoOutboundsInterface = 'Work VPN';
  host.data.settings.json = JSON.stringify(native);
  graph.nodes.push(host);
  graph.edges.push({
    id: 'host',
    source: host.id,
    sourceHandle: 'traffic',
    target: graph.nodes[1].id,
    targetHandle: 'in',
  });
  const next = configureSharedIpv6Host(graph);
  const tun = next.nodes.find((n) => n.id === host.id)!;
  expect(tun.data.enabled).toBe(true);
  expect(JSON.parse(String(tun.data.settings.json)).settings.autoOutboundsInterface).toBe(
    'Work VPN',
  );
  expect(next.edges).toEqual(graph.edges);
  expect(sharedIpv6Ready(next)).toBe(true);
});

it('recognizes an enabled or disabled existing ICS source for setup eligibility', () => {
  const graph = empty();
  expect(hasIcsCapture(graph)).toBe(false);
  const node = makeNode('ics-tun', { x: 0, y: 0 });
  graph.nodes.push(node);
  expect(hasIcsCapture(graph)).toBe(true);
  node.data.enabled = false;
  expect(hasIcsCapture(graph)).toBe(true);
});
