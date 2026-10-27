import { describe, expect, it } from 'vitest';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';
import { readRuleTable, tableSettings } from './rules';
import { makeNode } from './catalog';
import { intersectPredicates } from './routingPaths';
import { configureIcsGraph, type SharingInspection } from './internetSharing';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = (rules: Record<string, unknown>[]) => ({
  inbounds: [{ tag: 'local', protocol: 'socks', listen: '127.0.0.1', port: 18080, settings: {} }],
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ],
  routing: { rules },
});
const rulesOf = (graph: ReturnType<typeof importXrayConfig>) =>
  (compileXrayGraph(graph).config.routing as { rules: Record<string, unknown>[] }).rules;
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

describe('Native routing predicate aliases', () => {
  it.each([
    [
      { domain: ['domain:example.com'] },
      { domains: ['full:a.example.com'] },
      { domain: ['full:a.example.com'] },
    ],
    [
      { domains: ['domain:example.com'] },
      { domain: ['full:a.example.com'] },
      { domain: ['full:a.example.com'] },
    ],
    [{ sourceIP: ['10.0.0.0/8'] }, { source: ['192.0.2.0/24'] }, null],
    [{ source: ['10.0.0.0/8'] }, { sourceIP: ['10.2.0.0/16'] }, { sourceIP: ['10.2.0.0/16'] }],
    [
      { domain: ['domain:example.com'] },
      { domain: ['domain:ignored.example'], domains: [] },
      { domain: ['domain:example.com'] },
    ],
    [
      { domains: [], port: '443' },
      { domain: ['domain:example.com'] },
      { domain: ['domain:example.com'], port: '443' },
    ],
    [
      { sourceIP: null, source: ['10.0.0.0/8'] },
      { sourceIP: ['10.2.0.0/16'] },
      { sourceIP: ['10.2.0.0/16'] },
    ],
  ])(
    'combines core-effective predicates without broadening or dropping a path',
    (parent, child, expected) => {
      expect(intersectPredicates(parent, child)).toEqual(expected);
    },
  );

  it('models the core-effective alias predicates and retains every later ordered rule', () => {
    const source = config([
      { domains: ['domain:example.com'], outboundTag: 'block' },
      { source: ['10.0.0.0/8'], outboundTag: 'block' },
      { port: '25', outboundTag: 'block' },
    ]);
    const graph = importXrayConfig(JSON.stringify(source));
    const filter = graph.nodes.find((node) => node.id === graph.xray!.routingNodeId)!;
    const rows = readRuleTable(filter.data.settings).rules;
    expect(rows.map((row) => [row.matchAll, row.conditions])).toEqual([
      [false, { domain: 'domain:example.com' }],
      [false, { sourceIP: '10.0.0.0/8' }],
      [false, { port: '25' }],
    ]);
    expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(source);
  });

  it.each([
    { domain: ['full:ignored.example'], domains: [] },
    { domain: ['full:active.example'], domains: null },
    { sourceIP: [], source: ['192.0.2.0/24'] },
    { sourceIP: null, source: ['192.0.2.0/24'] },
  ])('retains explicit empty and null alias semantics unchanged', (predicates) => {
    const source = config([{ ...predicates, port: '443', outboundTag: 'block' }]);
    const graph = importXrayConfig(JSON.stringify(source));
    expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(source);
  });

  it('edits the effective predicate rather than leaving an overriding or revived alias', () => {
    const source = config([
      {
        domain: ['full:ignored.example'],
        domains: ['full:active.example'],
        source: ['192.0.2.0/24'],
        sourceIP: ['10.0.0.0/8'],
        port: '443',
        ruleTag: 'sensitive-destination',
        outboundTag: 'block',
      },
    ]);
    const graph = importXrayConfig(JSON.stringify(source));
    const filter = graph.nodes.find((node) => node.id === graph.xray!.routingNodeId)!;
    const table = readRuleTable(filter.data.settings);
    expect(table.rules[0].conditions.domain).toBe('full:active.example');
    expect(compileXrayGraph(graph).config).toEqual(source);

    table.rules[0].conditions.domain = 'full:new.example';
    table.rules[0].conditions.sourceIP = '';
    Object.assign(filter.data.settings, tableSettings(table));
    expect(rulesOf(graph)).toEqual([
      {
        domain: ['full:new.example'],
        port: '443',
        ruleTag: 'sensitive-destination',
        outboundTag: 'block',
      },
    ]);
  });

  it('intersects an aliased child predicate instead of overriding its parent guard', () => {
    const graph = importXrayConfig(
      JSON.stringify(
        config([
          { domain: ['domain:allowed.example'], outboundTag: 'direct' },
          { domains: ['domain:other.example'], outboundTag: 'block' },
        ]),
      ),
    );
    const parent = graph.nodes.find((node) => node.id === graph.xray!.routingNodeId)!;
    const table = readRuleTable(parent.data.settings);
    const child = makeNode('routing-filter', { x: 0, y: 0 }, 'child');
    // Only the parent's allowed.example branch may reach this child. No domain
    // can satisfy both disjoint predicates, so all traffic must remain blocked.
    child.data.settings = tableSettings({
      ...table,
      rules: [{ ...table.rules[1], output: table.rules[0].output }],
      defaultOutput: table.rules[1].output,
    });
    parent.data.settings = tableSettings({
      ...table,
      rules: [table.rules[0]],
      defaultOutput: table.rules[1].output,
    });
    graph.nodes.push(child);
    graph.edges.push(
      ...graph.edges
        .filter((edge) => edge.source === parent.id)
        .map((edge) => ({
          ...edge,
          id: 'child-' + edge.id,
          source: child.id,
        })),
    );
    graph.edges.find(
      (edge) => edge.source === parent.id && edge.sourceHandle === table.rules[0].output,
    )!.target = child.id;
    const rules = rulesOf(graph);
    expect(rules.some((rule) => rule.outboundTag === 'direct')).toBe(false);
    expect(rules).toEqual([{ domain: ['domain:allowed.example'], outboundTag: 'block' }]);
  });

  it('keeps host-source predicates out of sharing without dropping native domain restrictions', () => {
    const source = config([
      { source: ['10.0.0.0/8'], port: '443', outboundTag: 'direct' },
      { domains: ['full:allowed.example'], ruleTag: 'shared-site', outboundTag: 'direct' },
    ]);
    source.outbounds.reverse();
    const graph = configureIcsGraph(
      importXrayConfig(JSON.stringify(source)),
      sharing,
      { x: 0, y: 0 },
      false,
    );
    const ics = graph.nodes.find((node) => node.data.kind === 'ics-tun')!;
    graph.edges.find((edge) => edge.source === ics.id)!.target = graph.xray!.routingNodeId;
    const rules = rulesOf(graph).filter(
      (rule) => Array.isArray(rule.inboundTag) && rule.inboundTag.includes(ics.data.settings.tag),
    );
    expect(rules).toEqual([
      {
        type: 'field',
        domains: ['full:allowed.example'],
        inboundTag: [ics.data.settings.tag],
        outboundTag: 'direct',
      },
      { type: 'field', inboundTag: [ics.data.settings.tag], outboundTag: 'block' },
    ]);
  });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
it.skipIf(!core || !dir)(
  'accepts the preserved and edited alias configurations in the pinned core',
  () => {
    const source = config([
      { domains: ['domain:example.com'], outboundTag: 'block' },
      { source: ['10.0.0.0/8'], outboundTag: 'block' },
    ]);
    const graph = importXrayConfig(JSON.stringify(source));
    const filter = graph.nodes.find((node) => node.id === graph.xray!.routingNodeId)!;
    const table = readRuleTable(filter.data.settings);
    table.rules[0].conditions.domain = 'full:edited.example';
    table.rules[1].conditions.sourceIP = '192.0.2.0/24';
    Object.assign(filter.data.settings, tableSettings(table));
    mkdirSync(dir!, { recursive: true });
    for (const [index, value] of [source, compileXrayGraph(graph).config].entries()) {
      const path = join(dir!, `native-rule-aliases-${index}.json`);
      writeFileSync(path, JSON.stringify(value));
      const result = spawnSync(core!, ['run', '-test', '-config', path], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  },
);
