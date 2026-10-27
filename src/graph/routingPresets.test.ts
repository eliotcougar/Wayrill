import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  trafficPresets,
  dnsPresets,
  importTrafficPreset,
  importDnsPreset,
  newPresetOutput,
  rolesForTraffic,
  type TrafficPreset,
  type DnsPreset,
} from './routingPresets';
import { createDnsExample, createRoutingExample } from './example';
import { readRuleTable, routingRuleVariants, tableSettings } from './rules';
import { readDnsFilter, newDnsServer } from './dns';
import { compileDnsGraph } from './dnsCompilation';
import { makeNode } from './catalog';
import { updateGraphNode, serializeGraph, parseGraph } from './model';
import {
  initialWorkspaceHistory,
  commitWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import { compileRuntimeGraph } from './runtime';
import { factoryDefaults } from './defaults';
import original from './fixtures/v2rayN-routing-presets.json';

function traffic(preset: TrafficPreset) {
  let graph = createRoutingExample();
  graph.nodes.find((n) => n.data.kind === 'vless-outbound')!.data.settings.id =
    '00000000-0000-0000-0000-000000000001';
  const node = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  const table = importTrafficPreset(
    readRuleTable(node.data.settings),
    preset,
    { proxy: 'preferred', direct: 'default', block: 'blocked' },
    'replace',
  );
  graph = updateGraphNode(graph, node.id, {
    settings: { ...node.data.settings, ...tableSettings(table) },
  });
  if (preset.domainStrategy)
    graph.defaults = {
      ...factoryDefaults(),
      settings: { routingDomainStrategy: preset.domainStrategy },
    };
  return { graph, table };
}
function dns(preset: DnsPreset) {
  let graph = createDnsExample();
  graph.nodes.find((n) => n.data.kind === 'vless-outbound')!.data.settings.id =
    '00000000-0000-0000-0000-000000000001';
  const node = graph.nodes.find((n) => n.data.kind === 'dns-routing-filter')!;
  const filter = importDnsPreset(
    readDnsFilter(node.data.settings),
    preset,
    Object.fromEntries(preset.roles.map((r) => [r.id, newPresetOutput])),
    'replace',
  );
  graph = updateGraphNode(graph, node.id, {
    settings: {
      ...node.data.settings,
      outputs: JSON.stringify(filter.outputs),
      rules: JSON.stringify(filter.rules),
      fallbackMode: filter.fallbackMode,
      parallel: filter.parallel,
      fallbackFirst: filter.fallbackFirst ?? false,
    },
  });
  graph.edges = graph.edges.filter((e) => e.source !== node.id);
  const direct = graph.nodes.find((n) => n.data.kind === 'direct-outbound')!;
  for (const [index, role] of preset.roles.entries()) {
    const group = makeNode('dns-servers', { x: 0, y: 0 }, `preset-server-${index}`);
    group.data.settings.servers = JSON.stringify(
      role.servers.map((address, i) => ({ ...newDnsServer(`s-${i}`), address })),
    );
    graph.nodes.push(group);
    const output =
      role.id === 'fallback'
        ? filter.outputs.find((o) => o.fallback)!
        : filter.outputs.find((o) => o.name === role.name)!;
    graph.edges.push(
      {
        id: `preset-${index}`,
        source: node.id,
        sourceHandle: output.id,
        target: group.id,
        targetHandle: 'in',
      },
      {
        id: `preset-q-${index}`,
        source: group.id,
        sourceHandle: 'queries',
        target: direct.id,
        targetHandle: 'in',
      },
    );
  }
  return { graph, filter };
}
// Explicit files keep each country's provider independent of global resources.
function ext(value: string, country: string) {
  const region = { China: 'cn', Iran: 'ir', Russia: 'ru' }[country];
  return value.replace(/^(geoip|geosite):/, (_, kind) => `ext:${region}-${kind}.dat:`);
}
describe('v2rayN preset intent with explicit regional geodata', () => {
  it.each(trafficPresets)(
    '$label preserves source order, domain/IP alternatives and final destination',
    (preset) => {
      const { graph, table } = traffic(preset),
        source = original.traffic[preset.id as keyof typeof original.traffic] as Record<
          string,
          unknown
        >[];
      const expected = source.flatMap((row) => {
        const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
        if (r.port === '0-65535') return [];
        const fields: Record<string, unknown> = {};
        for (const key of ['domain', 'ip', 'port', 'network', 'protocol'])
          if (r[key])
            fields[key] = Array.isArray(r[key])
              ? (r[key] as string[]).map((v) => ext(v, preset.country))
              : r[key];
        const output = { proxy: 'preferred', direct: 'default', block: 'blocked' }[
          String(r.outboundtag) as 'proxy' | 'direct' | 'block'
        ];
        const alternatives = ['domain', 'ip'].filter((key) => fields[key]);
        return alternatives.length
          ? alternatives.map((key) => ({
              fields: {
                ...Object.fromEntries(
                  Object.entries(fields).filter(([k]) => !['domain', 'ip'].includes(k)),
                ),
                [key]: fields[key],
              },
              output,
            }))
          : [{ fields, output }];
      });
      expect(
        table.rules.flatMap((r) =>
          routingRuleVariants(r).map((fields) => ({ fields, output: r.output })),
        ),
      ).toEqual(expected);
      expect(table.defaultOutput).toBe(preset.defaultOutput === 'direct' ? 'default' : 'preferred');
      expect(table.rules.every((r) => !r.matchAll)).toBe(true);
      expect(compileRuntimeGraph(graph).config.routing).toBeDefined();
    },
  );
  it.each(dnsPresets)(
    '$label preserves resolver order, preference domains, expected IPs and skipFallback',
    (preset) => {
      const { graph, filter } = dns(preset);
      const config = compileDnsGraph(parseGraph(serializeGraph(graph)));
      const servers = config.dns.servers as Record<string, unknown>[];
      const expected = original.dns[preset.id as keyof typeof original.dns].servers;
      expect(servers.map((r) => r.address)).toEqual(
        expected.map((r) => (typeof r === 'string' ? r : r.address)),
      );
      expected.forEach((raw, index) => {
        if (typeof raw === 'string') {
          expect(servers[index].domains).toBeUndefined();
          return;
        }
        expect(servers[index].domains).toEqual(raw.domains?.map((v) => ext(v, preset.country)));
        if ('expectIPs' in raw)
          expect(servers[index].expectedIPs).toEqual(
            raw.expectIPs?.map((v) => ext(v, preset.country)),
          );
        expect(servers[index].skipFallback).toBe('skipFallback' in raw ? raw.skipFallback : false);
      });
      expect(filter.outputs.filter((o) => o.fallback)).toHaveLength(1);
    },
  );
});
it('keeps blocked-only China distinct from domestic-direct and proxy-all', () => {
  const blocked = trafficPresets.find((p) => p.id === 'cn-blocked')!;
  expect(blocked.defaultOutput).toBe('direct');
  expect(blocked.rules.find((r) => r.name === 'Blocked domains via proxy')).toEqual({
    name: 'Blocked domains via proxy',
    output: 'proxy',
    conditions: { domain: 'ext:cn-geosite.dat:gfw\next:cn-geosite.dat:greatfire' },
  });
  expect(JSON.stringify(blocked)).not.toContain('geolocation-!cn');
  expect(trafficPresets.find((p) => p.id === 'cn-local')!.defaultOutput).toBe('proxy');
  expect(trafficPresets.find((p) => p.id === 'cn-all')!.defaultOutput).toBe('proxy');
});
it('reuses stable IDs and connections, appends without changing defaults, rejects limits and missing bindings', () => {
  const graph = createRoutingExample(),
    before = structuredClone(graph),
    node = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  const old = readRuleTable(node.data.settings),
    preset = trafficPresets[0],
    bindings = { proxy: 'preferred', direct: 'default', block: 'blocked' };
  const append = importTrafficPreset(old, preset, bindings, 'append');
  expect(append.rules.slice(0, old.rules.length)).toEqual(old.rules);
  expect(append.defaultOutput).toBe(old.defaultOutput);
  expect(append.outputs).toEqual(old.outputs);
  expect(graph).toEqual(before);
  expect(() => importTrafficPreset(old, preset, {}, 'replace')).toThrow('Choose an output');
  expect(() =>
    importTrafficPreset(
      { ...old, rules: Array.from({ length: 128 }, () => old.rules[0]) },
      preset,
      bindings,
      'append',
    ),
  ).toThrow('128');
  const next = updateGraphNode(graph, node.id, {
    settings: { ...node.data.settings, ...tableSettings(append) },
  });
  expect(next.edges).toEqual(before.edges);
  expect(
    undoWorkspaceHistory(commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: next }))
      .present.graph,
  ).toEqual(before);
  expect(
    new Set(
      importTrafficPreset(
        old,
        preset,
        Object.fromEntries(rolesForTraffic(preset).map((r) => [r.id, newPresetOutput])),
        'replace',
      ).outputs.map((o) => o.id),
    ).size,
  ).toBe(old.outputs.length + 3);
});
it('DNS append keeps policies and ordering while replacing can restore the upstream fallback order', () => {
  const { filter } = dns(dnsPresets[1]);
  const before = structuredClone(filter);
  const next = importDnsPreset(
    filter,
    dnsPresets[2],
    { google: newPresetOutput, domestic: newPresetOutput },
    'append',
  );
  expect(next.rules[0]).toEqual(filter.rules[0]);
  expect(next.fallbackFirst).toBe(true);
  expect(filter).toEqual(before);
});
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  fixtures = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !fixtures)(
  'pinned Xray accepts every preset with its bundled categories',
  () => {
    for (const preset of trafficPresets)
      it(preset.label, () => check(preset.id, compileRuntimeGraph(traffic(preset).graph).config));
    for (const preset of dnsPresets)
      it(preset.label, () => check(preset.id, compileRuntimeGraph(dns(preset).graph).config));
  },
);
function check(id: string, config: Record<string, unknown>) {
  mkdirSync(fixtures!, { recursive: true });
  const path = join(fixtures!, `preset-${id}.json`);
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(core!, ['run', '-test', '-config', path], {
    encoding: 'utf-8',
    env: { ...process.env, XRAY_LOCATION_ASSET: dirname(core!) },
    timeout: 30000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
