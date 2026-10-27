/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeNode } from './catalog';
import { factoryDefaults, resolveGraph } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph, updateGraphNode } from './model';
import { importXrayConfig } from './xrayImport';
import { diagnoseXrayGraph } from './xrayCompiler';
import { cloneJson, jsonDifferences } from './xrayJson';
import {
  dnsHandlerFields,
  dnsServerFields,
  editNativeField,
  nativeFieldText,
  policyLevelFields,
} from './nativeFields';
import {
  hydrateCoreDefaults,
  syncImportedCoreDefaults,
  updateImportedCoreDefaults,
} from './nativeCore';
import { nativeJson, nativeProblems } from './xrayNodes';
import { nativeLiveFixture, nativeLiveUpstream } from './nativeLiveFixture';

function source(): Record<string, unknown> {
  return {
    log: { loglevel: 'info', dnsLog: false },
    inbounds: [
      {
        tag: 'local',
        protocol: 'mixed',
        listen: '127.0.0.1',
        port: 20911,
        settings: {
          auth: 'password',
          accounts: [
            { user: 'qa', pass: 'first' },
            { user: 'other', pass: 'second' },
          ],
          udp: true,
          allowTransparent: false,
        },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', inboundTag: ['local'], outboundTag: 'direct' }],
    },
    dns: {
      queryStrategy: 'UseIPv4',
      disableCache: false,
      serveStale: false,
      serveExpiredTTL: 0,
      disableFallbackIfMatch: true,
      servers: [
        {
          address: '1.1.1.1',
          port: 0,
          domains: ['domain:example.org'],
          expectedIPs: [],
          expectIPs: ['1.1.1.0/24'],
          skipFallback: false,
          timeoutMs: 0,
          queryStrategy: 'UseIPv4',
        },
        'localhost',
      ],
    },
    policy: {
      levels: {
        '0': {
          handshake: 0,
          connIdle: 300,
          uplinkOnly: 0,
          downlinkOnly: 5,
          bufferSize: -1,
          statsUserUplink: true,
          statsUserDownlink: false,
          statsUserOnline: true,
        },
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: false,
      },
    },
    stats: {},
    metrics: { tag: 'metrics' },
  };
}
const graphOf = (config = source()) => importXrayConfig(JSON.stringify(config), 'Native controls');
const configOf = (graph: ReturnType<typeof graphOf>) =>
  compileRuntimeGraph(parseGraph(serializeGraph(graph))).config;

describe('Mixed listener controls', () => {
  it('maps listener accounts, UDP and sniffing without changing original fields', () => {
    const original = source(),
      graph = graphOf(original),
      input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
    expect(input.data.settings).toMatchObject({
      auth: 'password',
      username: 'qa',
      password: 'first',
      extraAccounts: '[{"user":"other","pass":"second"}]',
      udp: true,
      sniffing: true,
      routeOnly: false,
    });
    expect(jsonDifferences(original, configOf(graph))).toEqual([]);
    expect(diagnoseXrayGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('edits an account or sniffing flag without filling omitted defaults', () => {
    const original = source(),
      graph = graphOf(original),
      input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
    input.data.settings.password = 'changed';
    input.data.settings.routeOnly = true;
    expect(jsonDifferences(original, configOf(graph))).toEqual([
      '/inbounds/0/settings/accounts/0/pass',
      '/inbounds/0/sniffing/routeOnly',
    ]);
  });
  it('retains the SOCKS protocol and legacy users spelling while editing a listener', () => {
    const original = source(),
      input = (original.inbounds as Record<string, unknown>[])[0],
      settings = input.settings as Record<string, unknown>;
    input.protocol = 'socks';
    settings.users = settings.accounts;
    delete settings.accounts;
    const graph = graphOf(original);
    graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!.data.settings.port = 20912;
    expect(jsonDifferences(original, configOf(graph))).toEqual(['/inbounds/0/port']);
  });
  it('falls back to native options for extended sniffing methods rather than changing them', () => {
    const original = source();
    (original.inbounds as { sniffing: Record<string, unknown> }[])[0].sniffing.destOverride = [
      'fakedns+others',
    ];
    const graph = graphOf(original);
    expect(graph.nodes.find((n) => n.id === 'native-in-0')?.data.kind).toBe('xray-inbound');
    expect(jsonDifferences(original, configOf(graph))).toEqual([]);
  });
  it('provides Mixed input Data and DNS branches without changing imported config rules', () => {
    const input = makeNode('proxy-inbound', { x: 0, y: 0 }, 'mixed'),
      direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
    const graph = resolveGraph({
      name: 'Mixed branches',
      defaults: factoryDefaults(),
      nodes: [input, direct],
      edges: ['data', 'dns'].map((port) => ({
        id: port,
        source: input.id,
        sourceHandle: port,
        target: direct.id,
        targetHandle: 'in',
      })),
    });
    const compiled = compileRuntimeGraph(graph).config;
    expect((compiled.routing as { rules: Record<string, unknown>[] }).rules).toEqual([
      expect.objectContaining({
        inboundTag: ['local-proxy'],
        network: 'tcp,udp',
        port: '53',
        outboundTag: 'direct',
      }),
      expect.objectContaining({ inboundTag: ['local-proxy'], outboundTag: 'direct' }),
    ]);
  });

  it('retains false, zero, aliases, omissions and server string/object layouts', () => {
    const original = source(),
      graph = graphOf(original);
    for (const node of graph.nodes.filter(
      (n) => n.data.kind === 'xray-dns' || n.data.kind === 'xray-dns-servers',
    ))
      expect(nativeProblems(node.data)).toEqual([]);
    expect(jsonDifferences(original, configOf(graph))).toEqual([]);
    const alias = dnsServerFields.find((f) => f.key === 'expectedIPs')!;
    expect(nativeFieldText({ expectedIPs: [], expectIPs: ['1.1.1.0/24'] }, alias)).toBe(
      '1.1.1.0/24',
    );
  });
  it('changes one DNS handler setting without replacing its remaining options', () => {
    const original = source(),
      graph = graphOf(original),
      node = graph.nodes.find((n) => n.data.kind === 'xray-dns')!;
    node.data.settings.json = JSON.stringify(
      editNativeField(
        nativeJson(node.data),
        dnsHandlerFields.find((f) => f.key === 'disableFallback')!,
        'true',
      ),
    );
    expect(jsonDifferences(original, configOf(graph))).toEqual(['/dns/disableFallback']);
  });
  it('edits an answer check with one authoritative spelling, retaining other preferences', () => {
    const original = source(),
      graph = graphOf(original),
      node = graph.nodes.find((n) => n.id === 'native-resolver-0')!,
      j = nativeJson(node.data),
      server = (j.servers as unknown[])[0];
    node.data.settings.json = JSON.stringify({
      servers: [
        editNativeField(
          server as Record<string, unknown>,
          dnsServerFields.find((f) => f.key === 'expectedIPs')!,
          '1.0.0.0/24\n*',
        ),
      ],
    });
    const exported = (configOf(graph).dns as { servers: Record<string, unknown>[] }).servers[0];
    expect(exported.expectIPs).toEqual(['1.0.0.0/24', '*']);
    expect(exported).not.toHaveProperty('expectedIPs');
    expect(exported.domains).toEqual(['domain:example.org']);
    expect(exported.skipFallback).toBe(false);
  });
  it('handles native case and scalar comma lists without changing them on open', () => {
    const field = dnsServerFields.find((f) => f.key === 'domains')!,
      original = { Domains: 'domain:example.org,full:example.net', FinalQuery: false };
    expect(nativeFieldText(original, field)).toBe('domain:example.org\nfull:example.net');
    expect(editNativeField(original, field, 'full:example.com')).toEqual({
      Domains: ['full:example.com'],
      FinalQuery: false,
    });
  });
  it('rejects malformed typed answers and addresses while accepting default port zero', () => {
    expect(() =>
      editNativeField(
        { address: '1.1.1.1' },
        dnsServerFields.find((f) => f.key === 'port')!,
        '0',
      ),
    ).not.toThrow();
    expect(() =>
      editNativeField(
        { address: '1.1.1.1' },
        dnsServerFields.find((f) => f.key === 'expectedIPs')!,
        '999.1.1.1',
      ),
    ).toThrow();
    expect(() => editNativeField({ address: '1.1.1.1' }, dnsServerFields[0], 'https://')).toThrow();
  });
});

describe('Core policy and metrics controls', () => {
  it('hydrates global settings from the imported policy, statistics and metrics', () => {
    const graph = graphOf(),
      d = graph.defaults!.settings;
    expect(d).toMatchObject({
      logLevel: 'info',
      statistics: true,
      metricsEnabled: true,
      metricsTag: 'metrics',
    });
    expect(JSON.parse(String(d.policy))).toEqual(source().policy);
    expect(jsonDifferences(source(), configOf(graph))).toEqual([]);
  });
  it('syncs a core form edit to defaults without adding unrelated fields', () => {
    const original = source(),
      graph = graphOf(original),
      node = graph.nodes.find((n) => n.data.kind === 'xray-options')!,
      options = nativeJson(node.data);
    (options.policy as { levels: Record<string, Record<string, unknown>> }).levels['0'].connIdle =
      123;
    const changed = syncImportedCoreDefaults(
      updateGraphNode(graph, node.id, {
        settings: { ...node.data.settings, json: JSON.stringify(options) },
      }),
    );
    expect(JSON.parse(String(changed.defaults!.settings.policy)).levels['0'].connIdle).toBe(123);
    expect(jsonDifferences(original, configOf(changed))).toEqual(['/policy/levels/0/connIdle']);
  });
  it('keeps a cleared log setting absent instead of materializing its core default', () => {
    const original = source(),
      graph = graphOf(original),
      node = graph.nodes.find((n) => n.data.kind === 'xray-options')!,
      options = nativeJson(node.data);
    delete (options.log as Record<string, unknown>).loglevel;
    const changed = syncImportedCoreDefaults(
      updateGraphNode(graph, node.id, {
        settings: { ...node.data.settings, json: JSON.stringify(options) },
      }),
    );
    expect(changed.defaults!.settings.logLevel).toBeUndefined();
    expect(jsonDifferences(original, configOf(changed))).toEqual(['/log/loglevel']);
  });
  it('applies global policy and metrics changes back to the imported core node', () => {
    const original = source(),
      graph = graphOf(original),
      defaults = cloneJson(graph.defaults!),
      policy = JSON.parse(String(defaults.settings.policy));
    policy.levels['0'].handshake = 5;
    defaults.settings.policy = JSON.stringify(policy);
    defaults.settings.metricsListen = '127.0.0.1:20913';
    const changed = updateImportedCoreDefaults(graph, defaults);
    expect(
      nativeJson(changed.nodes.find((n) => n.id === changed.xray!.optionsNodeId)!.data).metrics,
    ).toMatchObject({ listen: '127.0.0.1:20913' });
    expect(jsonDifferences(original, configOf(changed)).sort()).toEqual([
      '/metrics/listen',
      '/policy/levels/0/handshake',
    ]);
  });
  it('disables metrics cleanly and retains an unrelated native extension', () => {
    const original = source();
    (original.metrics as Record<string, unknown>).nativeFuture = false;
    const graph = graphOf(original),
      d = cloneJson(graph.defaults!);
    d.settings.metricsEnabled = false;
    expect(configOf(updateImportedCoreDefaults(graph, d))).not.toHaveProperty('metrics');
    const node = graph.nodes.find((n) => n.data.kind === 'xray-options')!,
      j = nativeJson(node.data);
    (j.metrics as Record<string, unknown>).listen = '127.0.0.1:20913';
    node.data.settings.json = JSON.stringify(j);
    expect(
      (configOf(syncImportedCoreDefaults(graph)).metrics as Record<string, unknown>).nativeFuture,
    ).toBe(false);
  });
  it('checks unsigned timeouts, buffer sizes and metrics endpoints', () => {
    const field = policyLevelFields.find((f) => f.key === 'handshake')!;
    expect(() => editNativeField({}, field, '-1')).toThrow();
    expect(() => editNativeField({}, field, '4294967296')).toThrow();
    expect(
      editNativeField(
        {},
        policyLevelFields.find((f) => f.key === 'bufferSize')!,
        '-1',
      ),
    ).toEqual({ bufferSize: -1 });
    const original = source();
    original.metrics = { tag: 'metrics', listen: '0.0.0.0:20911' };
    expect(
      diagnoseXrayGraph(graphOf(original)).some(
        (i) => i.severity === 'warning' && i.message.includes('Metrics'),
      ),
    ).toBe(true);
  });
  it('hydrates equivalent native key spelling', () => {
    const d = hydrateCoreDefaults({
      log: { LogLevel: 'Info', DNSLog: true },
      metrics: { Tag: 'metrics', Listen: '127.0.0.1:20913' },
    });
    expect(d.settings).toMatchObject({
      logLevel: 'info',
      dnsLog: true,
      metricsTag: 'metrics',
      metricsListen: '127.0.0.1:20913',
    });
  });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !dir)('Pinned Xray native control validation', () => {
  it.each(['noauth', 'password', 'block'] as const)(
    'validates the compiled VM %s traffic fixture and its peer',
    (mode) => {
      const original = nativeLiveFixture(mode),
        config = configOf(graphOf(original));
      expect(jsonDifferences(original, config)).toEqual([]);
      mkdirSync(dir!, { recursive: true });
      for (const [name, value] of [
        [`vm-native-${mode}`, config],
        [`vm-peer-${mode}`, nativeLiveUpstream(mode === 'noauth' ? 'noauth' : 'password')],
      ] as const) {
        const path = join(dir!, `${name}.json`);
        writeFileSync(path, JSON.stringify(value, null, 2));
        const result = spawnSync(core!, ['run', '-test', '-config', path], {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });
        expect(result.status, `${name}: ${result.stdout}\n${result.stderr}`).toBe(0);
      }
    },
  );
  it.each(['defaults-and-zero', 'all-dns-controls', 'metrics-listen', 'mixed-socks-protocol'])(
    'validates %s after a graph round trip',
    (mode) => {
      const original = source();
      if (mode === 'all-dns-controls') {
        Object.assign(original.dns as object, {
          clientIp: '192.0.2.1',
          tag: 'dns-query',
          disableFallback: false,
          disableFallbackIfMatch: true,
          enableParallelQuery: true,
          useSystemHosts: false,
          hosts: { 'full:example.org': ['192.0.2.2'] },
        });
        Object.assign((original.dns as { servers: Record<string, unknown>[] }).servers[0], {
          clientIp: '192.0.2.1',
          tag: 'resolver',
          expectedIPs: ['*', '1.1.1.0/24'],
          unexpectedIPs: ['*', '192.0.2.0/24'],
          finalQuery: true,
          disableCache: false,
          serveStale: false,
          serveExpiredTTL: 0,
          timeoutMs: 500,
        });
      }
      if (mode === 'metrics-listen')
        original.metrics = { tag: 'metrics', listen: '127.0.0.1:20913' };
      if (mode === 'mixed-socks-protocol')
        (original.inbounds as Record<string, unknown>[])[0].protocol = 'socks';
      const config = configOf(graphOf(original));
      expect(jsonDifferences(original, config)).toEqual([]);
      mkdirSync(dir!, { recursive: true });
      const path = join(dir!, `native-controls-${mode}.json`);
      writeFileSync(path, JSON.stringify(config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', path], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      expect(result.status, `${mode}: ${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );
});
