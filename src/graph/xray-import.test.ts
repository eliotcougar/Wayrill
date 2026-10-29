/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph, syncXrayConnections } from './xrayCompiler';
import { compileRuntimeGraph } from './runtime';
import { readRuleTable, tableSettings } from './rules';
import { cloneJson, jsonDifferences, jsonEqual, parseXrayJson } from './xrayJson';
import { LIMITS } from '../limits';
import { nativeOutputs } from './xrayNodes';

// Deliberately fictional; public fixtures and UI QA must never contain host credentials.
export function nativeFixture(): Record<string, unknown> {
  return {
    log: { loglevel: 'warning', dnsLog: false },
    stats: {},
    policy: { system: { statsOutboundUplink: true } },
    metrics: { tag: 'metrics' },
    inbounds: [
      {
        tag: 'local',
        protocol: 'mixed',
        listen: '127.0.0.1',
        port: 20901,
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      {
        tag: 'edge-one',
        protocol: 'vless',
        settings: {
          address: '127.0.0.1',
          port: 21901,
          id: 'fictional-qa',
          encryption: 'none',
          flow: '',
          level: 0,
          email: '',
        },
        streamSettings: { network: 'raw', security: 'none' },
        mux: { enabled: false },
      },
      {
        tag: 'edge-two',
        protocol: 'socks',
        settings: {
          address: '127.0.0.1',
          port: 21902,
          user: 'qa-user',
          pass: 'qa-password',
          level: 2,
          email: 'qa',
        },
        streamSettings: { network: 'raw', security: 'none', sockopt: { tcpFastOpen: false } },
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      domainMatcher: 'hybrid',
      rules: [
        {
          type: 'field',
          inboundTag: ['local'],
          domain: ['domain:example.org'],
          balancerTag: 'group',
          ruleTag: 'qa-domains',
        },
        { type: 'field', port: '53', network: 'udp', outboundTag: 'direct' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
      ],
      balancers: [
        {
          tag: 'group',
          selector: ['edge-'],
          strategy: { type: 'leastPing' },
          fallbackTag: 'direct',
        },
      ],
    },
    observatory: {
      subjectSelector: ['edge-'],
      probeUrl: 'https://example.org/qa',
      probeInterval: '1m',
      enableConcurrency: true,
    },
    dns: {
      queryStrategy: 'UseIPv4',
      disableCache: false,
      servers: [
        {
          address: '1.1.1.1',
          port: 53,
          domains: ['domain:example.org'],
          skipFallback: true,
          expectedIPs: ['1.1.1.0/24'],
          tag: 'resolver',
        },
        'localhost',
        { address: 'https+local://1.0.0.1/dns-query', skipFallback: false },
      ],
    },
  };
}
const graphOf = (config: Record<string, unknown> = nativeFixture()) =>
  importXrayConfig(JSON.stringify(config), 'Native QA');
const output = (graph: ReturnType<typeof graphOf>, tag: string) =>
  graph.nodes.find((n) => n.data.settings.tag === tag)!;
const compiled = (graph: ReturnType<typeof graphOf>) => compileXrayGraph(graph).config;

describe('Complete native Xray graph conversion', () => {
  it('preserves every JSON field, ordered array, omission, false and zero across save/open and repeated imports', () => {
    const original = nativeFixture();
    let graph = graphOf(original);
    expect(graph.nodes.filter((n) => n.data.kind === 'socks-outbound')).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      graph = parseGraph(serializeGraph(graph));
      const config = compileRuntimeGraph(graph).config;
      expect(jsonDifferences(original, config)).toEqual([]);
      graph = graphOf(config);
    }
    expect(diagnoseGraph(graph).filter((p) => p.severity === 'error')).toEqual([]);
  });
  it('exports rule ordering and rewiring, preserving extra per-rule properties', () => {
    const graph = graphOf(),
      filter = graph.nodes.find((n) => n.id === graph.xray!.routingNodeId)!,
      table = readRuleTable(filter.data.settings),
      original = cloneJson(nativeFixture());
    const port = table.rules[0].output;
    graph.edges = graph.edges.map((e) =>
      e.source === filter.id && e.sourceHandle === port
        ? { ...e, target: output(graph, 'block').id }
        : e,
    );
    table.rules = [table.rules[2], table.rules[0], table.rules[1]];
    filter.data.settings = tableSettings(table);
    const rows = (compiled(graph).routing as { rules: Record<string, unknown>[] }).rules;
    expect(rows[1]).toMatchObject({ ruleTag: 'qa-domains', outboundTag: 'block' });
    expect(rows[1]).not.toHaveProperty('balancerTag');
    expect(rows[0]).toEqual((original.routing as { rules: unknown[] }).rules[2]);
  });
  it('preserves DNS resolver order, preferences and bypass-versus-routed query dependencies', () => {
    const graph = graphOf(),
      servers = graph.nodes.filter((n) => n.data.kind === 'xray-dns-servers');
    expect(servers.map((n) => nativeOutputs(n.data).length)).toEqual([1, 0, 0]);
    expect(jsonDifferences(nativeFixture().dns, compiled(syncXrayConnections(graph)).dns)).toEqual(
      [],
    );
    const handler = graph.nodes.find((n) => n.data.kind === 'xray-dns')!;
    const ports = JSON.parse(String(handler.data.settings.outputs));
    handler.data.settings.outputs = JSON.stringify([...ports].reverse());
    expect((compiled(graph).dns as { servers: unknown[] }).servers).toEqual(
      [...(nativeFixture().dns as { servers: unknown[] }).servers].reverse(),
    );
  });
  it('follows renamed inbound and outbound references in separate tag namespaces', () => {
    const source = nativeFixture();
    (source.inbounds as { tag: string }[])[0].tag = 'direct';
    (source.routing as { rules: Record<string, unknown>[] }).rules[0].inboundTag = ['direct'];
    (source.outbounds as Record<string, unknown>[])[1].streamSettings = {
      sockopt: { dialerProxy: 'direct' },
    };
    const graph = graphOf(source);
    graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!.data.settings.tag = 'renamed-input';
    output(graph, 'direct').data.settings.tag = 'renamed-direct';
    const config = compiled(graph);
    expect((config.routing as { rules: Record<string, unknown>[] }).rules[0].inboundTag).toEqual([
      'renamed-input',
    ]);
    expect((config.outbounds as Record<string, unknown>[])[1]).toMatchObject({
      streamSettings: { sockopt: { dialerProxy: 'renamed-direct' } },
    });
  });
  it('rejects ambiguous destinations and unrepresentable prefix strings', () => {
    const source = nativeFixture();
    (source.routing as { rules: Record<string, unknown>[] }).rules[0].outboundTag = 'direct';
    expect(() => graphOf(source)).toThrow('both destination');
    const prefix = nativeFixture();
    (prefix.routing as { balancers: Record<string, unknown>[] }).balancers[0].selector = [''];
    expect(() => graphOf(prefix)).toThrow('nonempty');
  });
  it('accepts JSONC but rejects ambiguous JSON and unsafe numeric or prototype values', () => {
    expect(parseXrayJson('\uFEFF{/* test */"outbounds":[]// comment\n}')).toEqual({
      outbounds: [],
    });
    for (const text of [
      '{"outbounds":[],"outbounds":[]}',
      '{"__proto__":{}}',
      '{"a":9007199254740993}',
      '{"a":1e999}',
      '{"outbounds":[],}',
      '[]',
    ])
      expect(() => importXrayConfig(text)).toThrow();
    expect(() =>
      importXrayConfig(
        JSON.stringify({
          outbounds: Array.from({ length: LIMITS.maxOutbounds + 1 }, () => ({
            protocol: 'freedom',
          })),
        }),
      ),
    ).toThrow('16384');
  });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE;

// The host snapshot and output directory must be private, outside synced artifacts.
// Failures report booleans/status only so Vitest never prints actual credentials.
const host = process.env.WAYRILL_PRIVATE_XRAY_IMPORT_CONFIG,
  privateDir = process.env.WAYRILL_PRIVATE_XRAY_ROUNDTRIP_DIR;
describe.skipIf(!host || !privateDir || !core)('Private host config equivalence', () => {
  it('exports a structurally identical config after graph save/open and passes the pinned core', () => {
    const original = parseXrayJson(readFileSync(host!, 'utf8')),
      graph = importXrayConfig(JSON.stringify(original), 'Imported host config');
    const saved = serializeGraph(graph),
      restored = parseGraph(saved),
      config = compileRuntimeGraph(restored).config;
    expect(jsonEqual(original, config)).toBe(true);
    mkdirSync(privateDir!, { recursive: true });
    writeFileSync(join(privateDir!, 'host-import.graph.json'), saved);
    const path = join(privateDir!, 'host-roundtrip.json');
    writeFileSync(path, JSON.stringify(config, null, 2));
    const result = spawnSync(core!, ['run', '-test', '-config', path], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, XRAY_LOCATION_ASSET: privateDir! },
    });
    writeFileSync(
      join(privateDir!, 'roundtrip-core-validation.log'),
      `${result.stdout}\n${result.stderr}`,
    );
    expect(result.status).toBe(0);
    const summary = {
      identical: jsonEqual(original, config),
      changedPaths: jsonDifferences(original, config),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      inbounds: (config.inbounds as unknown[]).length,
      outbounds: (config.outbounds as unknown[]).length,
      coreStatus: result.status,
    };
    writeFileSync(join(privateDir!, 'roundtrip-summary.json'), JSON.stringify(summary, null, 2));
  });
});
