import { parseTrafficRules, importTrafficRules, trafficImportBase } from './trafficRuleImport';
import { trafficPresets, importTrafficPreset, newPresetOutput } from './routingPresets';
import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { readRuleTable, tableSettings, type RuleTable } from './rules';
import { compileRuntimeGraph } from './runtime';
import { unusedIdentityMask } from './capture';
import { getRoutingTrace } from './routingTrace';
import { parseGraph, serializeGraph } from './model';
import { diagnoseRuntimeGraph } from './diagnostics';
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
  it('keeps Block as the omitted default without changing ordinary rules', () => {
    const g = fixture(),
      c = compileRuntimeGraph(g);
    expect(c.capture!.inputs[0].ambiguousMask).toBeUndefined();
    policy(g, { action: 'block', output: '' });
    expect(compileRuntimeGraph(g).config).toEqual(c.config);
  });
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
  it('uses a selected named output and preserves graph round trips', () => {
    const g = fixture();
    policy(g, { action: 'allow', output: 'selected' });
    const restored = parseGraph(serializeGraph(g));
    expect(readRuleTable(restored.nodes[1].data.settings).tunAmbiguity).toEqual({
      action: 'allow',
      output: 'selected',
    });
    expect(rulesOf(restored)[0].outboundTag).toBe('block');
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
    expect(rulesOf(g)[0].outboundTag).toBe('wayrill-runtime-ambiguous');
    policy(g, { action: 'allow', output: '' }, 'child');
    expect(rulesOf(g)[0].outboundTag).toBe('direct');
  });
  it('diagnoses a disconnected output that is used only for ambiguous flows', () => {
    const g = fixture();
    policy(g, { action: 'allow', output: 'selected' });
    const t = readRuleTable(g.nodes[1].data.settings);
    t.rules = [];
    Object.assign(g.nodes[1].data.settings, tableSettings(t));
    g.edges = g.edges.filter((e) => e.sourceHandle !== 'selected');
    expect(diagnoseRuntimeGraph(g).some((d) => d.severity === 'error')).toBe(true);
    expect(() => compileRuntimeGraph(g)).toThrow(/connect|path/i);
  });
  it('rejects deleting the selected output without reassigning ambiguity', () => {
    const g = fixture();
    policy(g, { action: 'allow', output: 'selected' });
    const n = g.nodes[1],
      t = readRuleTable(n.data.settings);
    t.rules = [];
    t.outputs = t.outputs.filter((o) => o.id !== 'selected');
    Object.assign(n.data.settings, tableSettings(t));
    expect(() => parseGraph(serializeGraph(g))).toThrow(/ambiguous TUN/i);
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
  it('allocates a collision-free mask at the full profile limit without reducing predicate capacity', () => {
    expect(
      unusedIdentityMask(Array.from({ length: 4096 }, (_, i) => i.toString(16).padStart(3, '0'))),
    ).toBe('1000');
    const wide = ['0'.repeat(192), '0'.repeat(191) + '1'];
    expect(unusedIdentityMask(wide)).toBe('0'.repeat(191) + '2');
  });
});

it('creates routing for an imported implicit default when ambiguity becomes explicit', () => {
  const graph = importXrayConfig(
    JSON.stringify({
      inbounds: [
        {
          tag: 'host',
          protocol: 'tun',
          settings: { name: 'Wayrill-TUN', gateway: ['10.90.0.1/30'] },
        },
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }),
  );
  const n = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  policy(graph, { action: 'allow', output: '' }, n.id);
  const compiled = compileRuntimeGraph(graph);
  expect((compiled.config.routing as { rules: unknown[] }).rules.length).toBeGreaterThan(0);
});

it('preserves ambiguity when importing rules/presets and protects its referenced factory outputs', () => {
  const graph = fixture();
  policy(graph, { action: 'allow', output: 'selected' });
  const table = readRuleTable(graph.nodes[1].data.settings);
  const source = parseTrafficRules(
    JSON.stringify([{ domain: ['example.net'], outboundTag: 'direct' }]),
  );
  const bindings = Object.fromEntries(source.roles.map((r) => [r.id, 'default']));
  expect(importTrafficRules(table, source, bindings, 'replace').tunAmbiguity).toEqual(
    table.tunAmbiguity,
  );
  expect(
    importTrafficPreset(
      table,
      trafficPresets[0],
      { proxy: 'selected', direct: 'default', block: 'selected' },
      'replace',
    ).tunAmbiguity,
  ).toEqual(table.tunAmbiguity);
  const fresh = readRuleTable(makeNode('routing-filter', { x: 0, y: 0 }).data.settings);
  fresh.tunAmbiguity = { action: 'allow', output: 'preferred' };
  const withFallback = { ...source, defaultOutput: source.roles[0].id };
  expect(
    trafficImportBase(
      fresh,
      withFallback,
      Object.fromEntries(source.roles.map((r) => [r.id, newPresetOutput])),
      'replace',
      false,
    ).outputs,
  ).toEqual(fresh.outputs);
});
it('rejects a non-string ambiguity action', () => {
  const n = fixture().nodes[1];
  expect(() =>
    readRuleTable({
      ...n.data.settings,
      tunAmbiguity: JSON.stringify({ action: ['allow'], output: '' }),
    }),
  ).toThrow(/ambiguous TUN/i);
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
it('applies an independent ambiguity policy to a DNS branch traffic filter', () => {
  const g = fixture(),
    dns = makeNode('routing-filter', { x: 300, y: 300 }, 'dns-filter');
  g.nodes.push(dns);
  g.edges.push(edge('tun', 'dns', 'dns-filter'), edge('dns-filter', 'default', 'direct'));
  policy(g, { action: 'allow', output: '' }, 'dns-filter');
  const rules = rulesOf(g);
  expect(rules[0]).toMatchObject({ port: '53', outboundTag: 'direct' });
  expect(rules[1]).toMatchObject({ outboundTag: 'wayrill-runtime-ambiguous' });
});
