import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { readRuleTable, tableSettings, type RuleTable } from './rules';
import { compileRuntimeGraph } from './runtime';
import { getRoutingTrace } from './routingTrace';
import { importXrayConfig } from './xrayImport';
import type { GraphState } from './types';
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: source + sourceHandle + target,
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
function fixture(): GraphState {
  const tun = makeNode('tun-inbound', { x: 0, y: 0 }, 'tun');
  const filter = makeNode('routing-filter', { x: 300, y: 0 }, 'filter');
  Object.assign(
    filter.data.settings,
    tableSettings({
      outputs: [
        { id: 'selected', name: 'Selected' },
        { id: 'default', name: 'Default' },
      ],
      defaultOutput: 'default',
      rules: [
        {
          id: 'domain',
          name: 'A domain rule',
          enabled: true,
          matchAll: false,
          output: 'selected',
          conditions: { domain: 'full:example.net' },
        },
      ],
    }),
  );
  return {
    name: 'Ambiguous TUN',
    defaults: factoryDefaults(),
    nodes: [
      tun,
      filter,
      makeNode('direct-outbound', { x: 600, y: 0 }, 'direct'),
      makeNode('block-outbound', { x: 600, y: 200 }, 'block'),
    ],
    edges: [
      edge('tun', 'traffic', 'filter'),
      edge('filter', 'selected', 'block'),
      edge('filter', 'default', 'direct'),
    ],
  };
}
function policy(g: GraphState, value: RuleTable['tunAmbiguity'], id = 'filter') {
  const n = g.nodes.find((n) => n.id === id)!;
  const t = readRuleTable(n.data.settings);
  t.tunAmbiguity = value;
  Object.assign(n.data.settings, tableSettings(t));
}
const rulesOf = (g: GraphState) =>
  (compileRuntimeGraph(g).config.routing as { rules: Record<string, unknown>[] }).rules;
describe('ambiguous TUN ownership policy', () => {
  it('reserves a separate identity and routes directly to Unmatched, before matching domain rows', () => {
    const g = fixture();
    policy(g, { action: 'allow', output: '' });
    const c = compileRuntimeGraph(g),
      input = c.capture!.inputs[0];
    expect(input.ambiguousMask).toBe('1');
    expect(input.masks).toEqual(['0']);
    const rules = (c.config.routing as { rules: Record<string, unknown>[] }).rules;
    expect(rules[0]).toMatchObject({
      user: ['regexp:^wr-1-[0-9a-f]{48}$'],
      inboundTag: ['tun-inbound'],
      outboundTag: 'direct',
    });
    expect(rules[0].domain).toBeUndefined();
    expect(getRoutingTrace(rules[0])?.[0]).toMatchObject({
      filterId: 'filter',
      rule: 'Ambiguous TUN ownership',
      outputId: 'default',
    });
    expect(c.summary.trafficRuleCount).toBe(rules.length);
    expect(c.summary.outboundCount).toBe((c.config.outbounds as unknown[]).length);
  });
  it('does not broaden Proxy/WinDivert scopes and pads only TUN process patterns when necessary', () => {
    const g = fixture(),
      n = g.nodes[1],
      table = readRuleTable(n.data.settings);
    // Four compatible conditions fill every one-digit identity. An ambiguity code
    // then requires two digits, while WinDivert keeps its one-digit identities.
    table.rules = Array.from({ length: 4 }, (_, i) => ({
      id: `app${i}`,
      name: `App ${i}`,
      enabled: true,
      matchAll: false,
      output: 'selected',
      conditions: {},
      applications: [
        {
          kind: 'process' as const,
          value: `parent${i}.exe`,
          mode: 'name' as const,
          children: true,
          enabled: true,
        },
      ],
    }));
    table.tunAmbiguity = { action: 'allow', output: '' };
    Object.assign(n.data.settings, tableSettings(table));
    for (const kind of ['proxy-inbound', 'windivert-inbound'] as const) {
      const source = makeNode(kind, { x: 0, y: 300 }, kind);
      g.nodes.push(source);
      g.edges.push(edge(source.id, 'data', 'filter'), edge(source.id, 'dns', 'direct'));
    }
    const c = compileRuntimeGraph(g),
      inputs = c.capture!.inputs;
    expect(inputs.find((i) => i.source === 'tun')?.ambiguousMask).toBe('10');
    expect(inputs.find((i) => !i.source)?.ambiguousMask).toBeUndefined();
    const rules = (c.config.routing as { rules: Record<string, unknown>[] }).rules;
    expect(rules[0].inboundTag).toEqual(['tun-inbound']);
    const normal = rules.filter((r) => r.user && r !== rules[0]);
    const tun = normal.find((r) => (r.inboundTag as string[]).includes('tun-inbound'))!;
    const divert = normal.find((r) => (r.inboundTag as string[]).includes('captured-traffic'))!;
    const match = (r: Record<string, unknown>, mask: string) =>
      new RegExp(String((r.user as string[])[0]).slice(7)).test(`wr-${mask}-${'a'.repeat(48)}`);
    expect(match(tun, '01')).toBe(true);
    expect(match(tun, '1')).toBe(false);
    expect(match(divert, '1')).toBe(true);
    expect(match(divert, '01')).toBe(false);
  });
  it('keeps downstream Block and requires an explicit downstream Allow', () => {
    const g = fixture();
    policy(g, { action: 'allow', output: '' });
    const child = makeNode('routing-filter', { x: 450, y: 0 }, 'child');
    g.nodes.push(child);
    g.edges = g.edges.filter((e) => e.id !== 'filterdefaultdirect');
    g.edges.push(edge('filter', 'default', 'child'), edge('child', 'default', 'direct'));
    expect(rulesOf(g)[0].outboundTag).toBe('wr-a');
    policy(g, { action: 'allow', output: '' }, 'child');
    expect(rulesOf(g)[0].outboundTag).toBe('direct');
  });
  it('supports a native imported TUN graph', () => {
    const g = importXrayConfig(
      JSON.stringify({
        inbounds: [
          {
            tag: 'host',
            protocol: 'tun',
            settings: { name: 'Wayrill-TUN', gateway: ['10.90.0.1/30'] },
          },
        ],
        outbounds: [
          { tag: 'direct', protocol: 'freedom' },
          { tag: 'block', protocol: 'blackhole' },
        ],
        routing: { rules: [{ domain: ['full:example.net'], outboundTag: 'block' }] },
      }),
    );
    const n = g.nodes.find((n) => n.data.kind === 'routing-filter')!;
    policy(g, { action: 'allow', output: '' }, n.id);
    expect(compileRuntimeGraph(g).capture?.inputs[0].ambiguousMask).toBe('1');
  });
});

it('preserves a connected DNS branch before the ambiguous Data output', () => {
  const g = fixture();
  g.edges.push(edge('tun', 'dns', 'direct'));
  policy(g, { action: 'allow', output: 'selected' });
  const rules = rulesOf(g);
  expect(rules[0]).toMatchObject({
    port: '53',
    outboundTag: 'direct',
    user: ['regexp:^wr-1-[0-9a-f]{48}$'],
  });
  expect(rules[1]).toMatchObject({ outboundTag: 'block', user: ['regexp:^wr-1-[0-9a-f]{48}$'] });
});
