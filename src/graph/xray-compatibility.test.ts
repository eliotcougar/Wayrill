/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { outboundPreview } from './outbounds';
import { createDnsExample } from './example';
import { newDnsRoute, newDnsServer, readDnsServers } from './dns';
import { compileDnsGraph } from './dnsCompilation';
import type { NodeKind, SettingValue } from './types';

// Optional source-pinned integration check. -test builds configuration only; it never starts listeners or routing.
const core = process.env.WAYRILL_XRAY_TEST_EXE;
const fixtureDir = process.env.WAYRILL_XRAY_FIXTURE_DIR;

describe.skipIf(!core || !fixtureDir)('Generated native DNS graph offline compatibility', () => {
  for (const name of [
    'dns-graph-default',
    'dns-graph-answer-checks',
    'dns-graph-ipv4-cache-hosts',
    'dns-graph-server-overrides',
    'dns-graph-forward-tcp',
    'dns-graph-local-modes',
    'dns-graph-parallel-fallback',
    'dns-graph-disabled-fallback',
  ])
    it(name, () => {
      const graph = createDnsExample(),
        handler = graph.nodes.find((n) => n.id === 'dns')!,
        filter = graph.nodes.find((n) => n.id === 'dns-routes')!,
        group = graph.nodes.find((n) => n.id === 'remote-dns')!;
      if (name === 'dns-graph-answer-checks')
        filter.data.settings.rules = JSON.stringify([
          {
            ...newDnsRoute('remote', 'expected'),
            domains: 'domain:example.net\nregexp:(?i)example',
            expectedIPs: '1.0.0.0/8\n*',
            unexpectedIPs: '203.0.113.0/24',
            finalQuery: true,
          },
        ]);
      if (name === 'dns-graph-ipv4-cache-hosts')
        Object.assign(handler.data.settings, {
          queryStrategy: 'UseIPv4',
          disableCache: true,
          serveStale: true,
          serveExpiredTTL: 60,
          clientIP: '203.0.113.4',
          hosts: '{"full:dns.example.net":["1.1.1.1"],"domain:blocked.example":"#3"}',
        });
      if (name === 'dns-graph-server-overrides') {
        const servers = readDnsServers(group.data.settings);
        Object.assign(servers[0], {
          queryStrategy: 'UseIPv6',
          clientIP: '2001:db8::1',
          timeoutMs: 1500,
          cache: 'disabled',
          stale: 'enabled',
          staleTTL: 120,
        });
        group.data.settings.servers = JSON.stringify(servers);
      }
      if (name === 'dns-graph-forward-tcp') {
        Object.assign(handler.data.settings, {
          policyDefault: 'forward',
          rewriteNetwork: 'tcp',
          rewriteAddress: '9.9.9.9',
          rewritePort: 5353,
        });
        graph.edges.push({
          id: 'forward-query',
          source: 'dns',
          sourceHandle: 'forward',
          target: 'direct',
          targetHandle: 'in',
        });
      }
      if (name === 'dns-graph-local-modes') {
        group.data.settings.servers = JSON.stringify(
          [
            'localhost',
            'tcp+local://1.1.1.1:53',
            'https+local://1.1.1.1/dns-query',
            'quic+local://1.1.1.1:853',
          ].map((address, i) => ({ ...newDnsServer(`local-${i}`), address })),
        );
        graph.edges = graph.edges.filter((e) => e.id !== 'remote-query');
      }
      if (name === 'dns-graph-parallel-fallback') {
        Object.assign(filter.data.settings, { parallel: true, fallbackMode: 'when-unmatched' });
        group.data.settings.servers = JSON.stringify([
          newDnsServer('one'),
          { ...newDnsServer('two'), address: '9.9.9.9' },
        ]);
      }
      if (name === 'dns-graph-disabled-fallback') {
        filter.data.settings.fallbackMode = 'disabled';
        graph.edges = graph.edges.filter(
          (e) => !(e.source === filter.id && e.sourceHandle === 'remote'),
        );
      }
      mkdirSync(fixtureDir!, { recursive: true });
      const config = { log: { loglevel: 'none' }, ...compileDnsGraph(graph) };
      const path = join(fixtureDir!, `${name}.json`);
      writeFileSync(path, JSON.stringify(config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', path], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      writeFileSync(
        join(fixtureDir!, `${name}.log`),
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${name}: ${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Configuration OK.');
    });
});
const cases: { name: string; kind?: NodeKind; settings: Record<string, SettingValue> }[] = [
  { name: 'vless-raw-tls', settings: {} },
  {
    name: 'vless-raw-reality-vision',
    settings: {
      security: 'reality',
      serverName: 'www.example.net',
      realityPassword: 'A'.repeat(43),
      shortId: 'ab12',
      flow: 'xtls-rprx-vision',
    },
  },
  {
    name: 'vless-vision-xudp',
    settings: { flow: 'xtls-rprx-vision', muxEnabled: true, muxConcurrency: -1 },
  },
  {
    name: 'vless-xhttp-extra',
    settings: {
      network: 'xhttp',
      xhttpExtra: '{"xmux":{"maxConnections":"2-4"},"xPaddingBytes":"100-200"}',
    },
  },
  {
    name: 'vless-xhttp-reality',
    settings: {
      network: 'xhttp',
      security: 'reality',
      serverName: 'www.example.net',
      realityPassword: 'A'.repeat(43),
    },
  },
  {
    name: 'vless-websocket',
    settings: {
      network: 'ws',
      host: 'www.example.net',
      path: '/socket?ed=2048',
      headers: '{"User-Agent":"Wayrill-QA"}',
      wsHeartbeat: 15,
    },
  },
  { name: 'vless-httpupgrade', settings: { network: 'httpupgrade', path: '/upgrade?ed=2048' } },
  {
    name: 'vless-grpc',
    settings: {
      network: 'grpc',
      grpcServiceName: 'wayrill',
      grpcAuthority: 'www.example.net',
      grpcMultiMode: true,
    },
  },
  {
    name: 'vless-kcp-encryption',
    settings: {
      network: 'kcp',
      security: 'none',
      encryption: `mlkem768x25519plus.native.1rtt.${'A'.repeat(43)}`,
    },
  },
  { name: 'vless-hysteria', settings: { network: 'hysteria', hysteriaAuth: 'qa-only' } },
  {
    name: 'vless-raw-http',
    settings: { rawHeaderType: 'http', rawHost: 'www.example.net', rawPath: '/index' },
  },
  {
    name: 'vless-tls-pinning',
    settings: {
      pinnedPeerCertSha256: 'AA'.repeat(32),
      verifyPeerCertByName: 'www.example.net',
      tlsMinVersion: '1.2',
      tlsMaxVersion: '1.3',
      sessionResumption: true,
    },
  },
  { name: 'direct-basic', kind: 'direct-outbound', settings: {} },
  {
    name: 'direct-redirect',
    kind: 'direct-outbound',
    settings: { redirect: '[::1]:443', proxyProtocol: '1', domainStrategy: 'UseIPv4' },
  },
  { name: 'block-none', kind: 'block-outbound', settings: {} },
  { name: 'block-http', kind: 'block-outbound', settings: { response: 'http' } },
  {
    name: 'block-custom',
    kind: 'block-outbound',
    settings: { response: 'custom', customResponseData: 'SGVsbG8=' },
  },
];
describe.skipIf(!core || !fixtureDir)('Xray source-pinned offline compatibility', () => {
  for (const fixture of cases)
    it(fixture.name, () => {
      mkdirSync(fixtureDir!, { recursive: true });
      const node = makeNode(fixture.kind ?? 'vless-outbound', { x: 0, y: 0 });
      Object.assign(node.data.settings, {
        address: 'server.example.net',
        id: 'wayrill-offline-test',
        ...fixture.settings,
      });
      const config = { log: { loglevel: 'none' }, outbounds: [outboundPreview(node.data)] };
      const configPath = join(fixtureDir!, `${fixture.name}.json`);
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', configPath], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      writeFileSync(
        join(fixtureDir!, `${fixture.name}.log`),
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      );
      expect(result.error, `${fixture.name}: ${result.error}`).toBeUndefined();
      expect(result.status, `${fixture.name}: ${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Configuration OK.');
    });
});
