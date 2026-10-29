import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { inboundPreview } from './inbounds';
import { importXrayConfig } from './xrayImport';
import { tableSettings, type TableRule } from './rules';
import type { GraphState } from './types';

const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
const applicationRule = (kind: 'children' | 'package' | 'service'): TableRule => ({
  id: 'app',
  name: 'Application policy',
  enabled: true,
  matchAll: false,
  output: 'match',
  targetMatch: 'all',
  conditions: { port: '443', domain: 'full:private.example' },
  applications: [
    {
      kind: kind === 'children' ? 'process' : kind,
      value: kind === 'children' ? 'launcher.exe' : 'identity',
      mode: 'name',
      children: kind === 'children',
      enabled: true,
    },
  ],
});
function fixture(capture: 'tun-inbound' | 'windivert-inbound', rule: TableRule): GraphState {
  const proxy = makeNode('proxy-inbound', { x: 0, y: 0 }, 'proxy');
  proxy.data.settings.mode = 'socks';
  const source = makeNode(capture, { x: 0, y: 200 }, 'capture');
  const filter = makeNode('routing-filter', { x: 300, y: 0 }, 'filter');
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'match', name: 'Application' },
        { id: 'fallback', name: 'Else' },
      ],
      rules: [rule],
      defaultOutput: 'fallback',
    }),
  );
  return {
    name: 'Shared capture',
    defaults: factoryDefaults(),
    nodes: [
      proxy,
      source,
      filter,
      makeNode('direct-outbound', { x: 600, y: 0 }, 'direct'),
      makeNode('block-outbound', { x: 600, y: 200 }, 'block'),
    ],
    edges: [
      edge('proxy', 'data', 'filter'),
      edge('proxy', 'dns', 'direct'),
      edge('capture', capture === 'tun-inbound' ? 'traffic' : 'data', 'filter'),
      ...(capture === 'windivert-inbound' ? [edge('capture', 'dns', 'direct')] : []),
      edge('filter', 'match', 'direct'),
      edge('filter', 'fallback', 'block'),
    ],
  };
}
const rulesOf = (graph: GraphState) =>
  (compileRuntimeGraph(graph).config.routing as { rules: Record<string, unknown>[] }).rules;

describe.each(['tun-inbound', 'windivert-inbound'] as const)('shared %s and SOCKS', (capture) => {
  it('keeps OR domain matches without broadening an application-only alternative', () => {
    const graph = fixture(capture, { ...applicationRule('children'), targetMatch: 'any' });
    const ordinary = rulesOf(graph).filter(
      (r) => JSON.stringify(r.inboundTag) === '["local-proxy"]',
    );
    expect(ordinary).toContainEqual(
      expect.objectContaining({
        domain: ['full:private.example'],
        port: '443',
        outboundTag: 'direct',
      }),
    );
    expect(ordinary.filter((r) => r.outboundTag === 'direct' && r.port === '443')).toHaveLength(1);
    expect(ordinary.some((r) => r.process || r.user)).toBe(false);
  });
});

it('supports enhanced application rules in a native TUN + SOCKS import', () => {
  const tun = makeNode('tun-inbound', { x: 0, y: 0 });
  const graph = importXrayConfig(
    JSON.stringify({
      inbounds: [
        inboundPreview(tun.data),
        { tag: 'proxy', protocol: 'socks', listen: '127.0.0.1', port: 1080, settings: {} },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom', settings: {} },
        { tag: 'block', protocol: 'blackhole', settings: {} },
      ],
      routing: {
        rules: [{ type: 'field', domain: ['full:initial.example'], outboundTag: 'direct' }],
      },
    }),
  );
  const filter = graph.nodes.find((n) => n.id === graph.xray!.routingNodeId)!;
  const table = JSON.parse(String(filter.data.settings.outputs)) as { id: string; name: string }[];
  const direct = graph.nodes.find((n) => n.data.settings.tag === 'direct')!;
  const output = graph.edges.find(
    (e) => e.source === filter.id && e.target === direct.id,
  )!.sourceHandle!;
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: table,
      defaultOutput: String(filter.data.settings.defaultOutput),
      rules: [{ ...applicationRule('children'), output }],
    }),
  );
  const result = compileRuntimeGraph(graph);
  expect(result.capture?.inputs[0]).toMatchObject({
    source: 'tun',
    predicates: [[expect.objectContaining({ children: true })]],
  });
  const rules = (result.config.routing as { rules: Record<string, unknown>[] }).rules;
  expect(rules.filter((r) => r.user)).toEqual([
    expect.objectContaining({ inboundTag: ['tun-inbound'] }),
  ]);
  expect(rules.some((r) => r.process)).toBe(false);
});
