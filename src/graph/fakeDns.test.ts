/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeNode, getOutputPorts } from './catalog';
import {
  automaticFakeDnsPools,
  compileFakeDnsPools,
  editFakeDnsGraph,
  fakeDnsPools,
  fakeDnsConfigProblems,
} from './fakeDns';
import { createFakeDnsExample } from './fakeDnsExample';
import { compileRuntimeGraph } from './runtime';
import { compileDnsGraph } from './dnsCompilation';
import { connectionProblem, parseGraph, serializeGraph } from './model';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { createDnsExample } from './example';
import { newDnsRoute } from './dns';

describe('FakeDNS pools and resolver graph', () => {
  it('uses the audited core pools and family-dependent capacities', () => {
    expect(automaticFakeDnsPools('UseIP')).toEqual([
      { ipPool: '198.18.0.0/15', poolSize: 32768 },
      { ipPool: '2001:2::/48', poolSize: 32768 },
    ]);
    expect(automaticFakeDnsPools('UseIPv6')).toEqual([{ ipPool: '2001:2::/48', poolSize: 65535 }]);
    expect(automaticFakeDnsPools('UseIPv4')).toEqual([
      { ipPool: '198.18.0.0/15', poolSize: 65535 },
    ]);
  });
  it('keeps automatic pools implicit and supplies a real DNS path behind synthetic answers', () => {
    const graph = createFakeDnsExample(),
      compiled = compileRuntimeGraph(graph);
    expect(compiled.config).not.toHaveProperty('fakedns');
    expect((compiled.config.dns as { servers: unknown[] }).servers).toEqual([
      { address: 'fakedns', domains: ['regexp:.*'], skipFallback: true, finalQuery: false },
      expect.objectContaining({ address: '1.1.1.1', skipFallback: false }),
    ]);
    expect(getOutputPorts('fakedns')).toEqual([]);
    expect(parseGraph(serializeGraph(graph)).nodes.map((n) => n.data.kind)).toContain('fakedns');
    expect(compiled.warnings).not.toContainEqual(expect.stringContaining('no inbound'));
    expect(compiled.config.routing).toEqual(
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({
            inboundTag: expect.arrayContaining([expect.stringMatching(/^wayrill-dns-/)]),
          }),
        ]),
      }),
    );
  });
  it('shares custom pool edits atomically between resolver instances', () => {
    const graph = createFakeDnsExample();
    graph.nodes.push(makeNode('fakedns', { x: 800, y: 700 }, 'second'));
    const settings = {
      ...graph.nodes.find((n) => n.data.kind === 'fakedns')!.data.settings,
      pools: '{"ipPool":"198.18.0.0/24","poolSize":200}',
    };
    const next = editFakeDnsGraph(graph, 'fake-resolver', settings);
    expect(
      next.nodes.filter((n) => n.data.kind === 'fakedns').map((n) => n.data.settings.pools),
    ).toEqual([settings.pools, settings.pools]);
    expect(compileFakeDnsPools(next)).toEqual({ ipPool: '198.18.0.0/24', poolSize: 200 });
    expect(graph.nodes.find((n) => n.id === 'second')!.data.settings.pools).toBe('');
    expect(compileDnsGraph(next).fakedns).toEqual({ ipPool: '198.18.0.0/24', poolSize: 200 });
  });
  it('rejects conflicting global pools and the pinned subnet-capacity boundary', () => {
    const graph = createFakeDnsExample(),
      other = makeNode('fakedns', { x: 0, y: 0 }, 'other');
    graph.nodes.push(other);
    other.data.settings.pools = '{"ipPool":"198.18.0.0/24","poolSize":128}';
    expect(() => compileFakeDnsPools(graph)).toThrow(/share the same pools/);
    for (const pools of [
      '{"ipPool":"198.18.0.0/24","poolSize":256}',
      '{"ipPool":"domain:example.net","poolSize":2}',
      '{"ipPool":"198.18.0.0/24"}',
      '{"ipPool":"198.18.0.0/24/","poolSize":128}',
      '{"ipPool":"2001:db8::/64//ignored","poolSize":128}',
      '[]',
      'null',
    ]) {
      expect(() =>
        fakeDnsPools({ ...other.data, settings: { ...other.data.settings, pools } }),
      ).toThrow();
    }
  });
  it('accepts resolver selection and rejects ordinary traffic at a FakeDNS node', () => {
    const graph = createFakeDnsExample();
    expect(connectionProblem({ ...graph, edges: [] }, { ...graph.edges[2] })).toBeNull();
    expect(
      connectionProblem({ ...graph, edges: [] }, { ...graph.edges[0], target: 'fake-resolver' }),
    ).toMatch(/resolver/);
  });
  it('recovers fake destinations even with routeOnly and warns when recovery is absent', () => {
    const config = compileRuntimeGraph(createFakeDnsExample()).config;
    expect(fakeDnsConfigProblems(config)).toEqual([]);
    (config.inbounds as Record<string, unknown>[])[0].sniffing = {
      enabled: false,
      destOverride: ['fakedns'],
    };
    expect(fakeDnsConfigProblems(config)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('no inbound'),
      }),
    );
    delete config.dns;
    (config.inbounds as Record<string, unknown>[])[0].sniffing = {
      enabled: true,
      destOverride: ['fakedns'],
      routeOnly: true,
    };
    expect(fakeDnsConfigProblems(config)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('inactive'),
      }),
    );
  });
  it('inherits domain preferences and keeps network resolvers available for fallback', () => {
    const graph = createDnsExample(),
      fake = makeNode('fakedns', { x: 0, y: 0 }, 'fake');
    graph.nodes.push(fake);
    const filter = graph.nodes.find((n) => n.id === 'dns-routes')!;
    filter.data.settings.rules = JSON.stringify([
      { ...newDnsRoute('local', 'fake-preferred'), domains: 'full:fake.example' },
    ]);
    graph.edges.find((e) => e.source === 'dns-routes' && e.sourceHandle === 'local')!.target =
      'fake';
    const fragment = compileDnsGraph(graph);
    expect(fragment.dns.servers[0]).toEqual({
      address: 'fakedns',
      domains: ['full:fake.example'],
      skipFallback: true,
    });
    expect(fragment.dns.servers.some((s) => s.address === 'https://1.1.1.1/dns-query')).toBe(true);
  });
  for (const pools of [
    undefined,
    { ipPool: '198.18.0.0/24', poolSize: 128 },
    [
      { IPPool: '198.18.0.0/24', PoolSize: 128 },
      { ipPool: '2001:2::/48', poolSize: 1024 },
    ],
  ])
    it(`preserves native ordering, string/object forms and shared pools ${JSON.stringify(pools)}`, () => {
      const config = compileRuntimeGraph(createFakeDnsExample()).config;
      (config.dns as Record<string, unknown>).servers = [
        'fakedns',
        'localhost',
        { address: 'FakeDNS', domains: ['full:example.net'], skipFallback: true, timeoutMs: 0 },
        'https+local://1.1.1.1/dns-query',
      ];
      if (pools !== undefined) config.fakedns = pools;
      const graph = importXrayConfig(JSON.stringify(config));
      expect(graph.nodes.filter((n) => n.data.kind === 'fakedns')).toHaveLength(2);
      expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
    });
});
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !dir)('FakeDNS configured core compatibility', () => {
  for (const family of ['UseIP', 'UseIPv4', 'UseIPv6'])
    for (const custom of [false, true])
      it(`${family} ${custom ? 'custom' : 'automatic'}`, () => {
        const graph = createFakeDnsExample();
        graph.nodes.find((n) => n.data.kind === 'dns-handler')!.data.settings.queryStrategy =
          family;
        if (custom)
          graph.nodes.find((n) => n.data.kind === 'fakedns')!.data.settings.pools = JSON.stringify(
            automaticFakeDnsPools(family),
          );
        const config = compileRuntimeGraph(graph).config;
        mkdirSync(dir!, { recursive: true });
        const path = join(dir!, `fakedns-${family}-${custom}.json`);
        writeFileSync(path, JSON.stringify(config));
        const result = spawnSync(core!, ['run', '-test', '-format', 'json', '-config', path], {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
      });
});
