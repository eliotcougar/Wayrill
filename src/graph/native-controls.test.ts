/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { importXrayConfig } from './xrayImport';
import { cloneJson, jsonDifferences } from './xrayJson';
import { dnsServerFields, nativeFieldText } from './nativeFields';
import { updateImportedCoreDefaults } from './nativeCore';
import { nativeJson, nativeProblems } from './xrayNodes';
import { importXrayConfig as importAquifer } from '../../aquifer/src/graph/xrayImport';
import { compileXrayGraph as compileAquifer } from '../../aquifer/src/graph/xrayCompiler';
import {
  parseGraph as parseAquifer,
  serializeGraph as serializeAquifer,
} from '../../aquifer/src/graph/model';

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
  it.each([
    [
      'Wayrill',
      (text: string) => {
        const graph = importXrayConfig(text);
        const input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
        Object.assign(input.data.settings, { password: 'changed', routeOnly: true });
        return configOf(graph);
      },
    ],
    [
      'Aquifer',
      (text: string) => {
        const graph = importAquifer(text);
        const input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
        Object.assign(input.data.settings, { password: 'changed', routeOnly: true });
        return compileAquifer(parseAquifer(serializeAquifer(graph))).config;
      },
    ],
  ] as const)('%s edits accounts and sniffing without filling omitted defaults', (_app, edit) => {
    const { inbounds, outbounds, routing } = source();
    const original = { inbounds, outbounds, routing };
    expect(jsonDifferences(original, edit(JSON.stringify(original)))).toEqual([
      '/inbounds/0/settings/accounts/0/pass',
      '/inbounds/0/sniffing/routeOnly',
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
});

describe('Core policy and metrics controls', () => {
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
});
