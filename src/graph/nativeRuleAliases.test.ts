import { describe, expect, it } from 'vitest';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { readRuleTable, tableSettings } from './rules';
import { intersectPredicates } from './routingPaths';
import { configureIcsGraph, type SharingInspection } from './internetSharing';

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
