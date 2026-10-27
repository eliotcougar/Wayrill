/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound } from './catalog';
import { outboundPreview } from './outbounds';
import { inboundPreview, inboundPreFilters } from './inbounds';
import { readRuleTable, routingRuleFields } from './rules';
import { createDnsExample, createRoutingExample } from './example';
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

describe.skipIf(!core || !fixtureDir)(
  'Xray routing table and DNS policy offline compatibility',
  () => {
    const fixtures = [
      'ordered-combined-routing',
      'routing-advanced-predicates',
      'dns-query-policy',
      'dns-rewrite-upstream',
    ];
    for (const name of fixtures)
      it(name, () => {
        mkdirSync(fixtureDir!, { recursive: true });
        const filter = createRoutingExample().nodes.find((node) => node.id === 'routes')!;
        const table = readRuleTable(filter.data.settings);
        const config: Record<string, unknown> = {
          log: { loglevel: 'none' },
          outbounds: table.outputs.map((output) => ({ tag: output.id, protocol: 'blackhole' })),
        };
        if (name === 'ordered-combined-routing')
          config.routing = {
            rules: [
              ...table.rules.map((rule) => ({
                ...routingRuleFields(rule),
                outboundTag: rule.output,
              })),
              { network: 'tcp,udp', outboundTag: table.defaultOutput },
            ],
          };
        if (name === 'routing-advanced-predicates')
          config.routing = {
            rules: [
              {
                ...routingRuleFields({
                  id: 'advanced',
                  name: 'Advanced',
                  enabled: true,
                  output: 'default',
                  matchAll: false,
                  conditions: {
                    domain: 'regexp:(?i)example',
                    sourceIP: '10.0.0.0/8',
                    sourcePort: '1000-2000',
                    localIP: '127.0.0.1',
                    localPort: '10808',
                    inboundTag: 'local-socks',
                    user: 'qa@example.net',
                    network: 'tcp',
                    protocol: 'http',
                    process: 'curl',
                    localOS: 'windows',
                    vlessRoute: '0-65535',
                    attrs: '{":method":"GET"}',
                  },
                }),
                outboundTag: 'default',
              },
            ],
          };
        if (name.startsWith('dns-')) {
          config.dns = {
            servers: [
              { address: '1.1.1.1', port: 53, tag: 'dns-upstream', queryStrategy: 'UseIP' },
            ],
          };
          config.outbounds = [
            {
              tag: 'dns-handler',
              protocol: 'dns',
              settings:
                name === 'dns-query-policy'
                  ? {
                      rules: [
                        { domain: ['domain:blocked.example'], action: 'return', rCode: 3 },
                        { qType: '1,28', action: 'hijack' },
                        { action: 'direct' },
                      ],
                    }
                  : {
                      rewriteNetwork: 'tcp',
                      rewriteAddress: '1.1.1.1',
                      rewritePort: 53,
                      rules: [{ action: 'direct' }],
                    },
            },
          ];
        }
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
  },
);

describe.skipIf(!core || !fixtureDir)('Xray SOCKS inbound offline compatibility', () => {
  const fixtures: { name: string; settings: Record<string, SettingValue> }[] = [
    { name: 'socks-local', settings: {} },
    {
      name: 'socks-password-users',
      settings: {
        auth: 'password',
        username: 'qa-first',
        password: 'qa-only',
        extraAccounts: '[{"user":"qa-second","pass":"qa-two"}]',
      },
    },
    { name: 'socks-no-udp-no-sniff', settings: { udp: false, sniffing: false } },
    {
      name: 'socks-relay-and-exclusions',
      settings: {
        udpAddress: '127.0.0.1',
        domainsExcluded: '["full:example.net"]',
        ipsExcluded: '["192.168.0.0/16"]',
        streamSettings: '{"sockopt":{"tcpFastOpen":true}}',
      },
    },
  ];
  for (const fixture of fixtures)
    it(fixture.name, () => {
      mkdirSync(fixtureDir!, { recursive: true });
      const node = makeProxyInbound('socks', { x: 0, y: 0 });
      Object.assign(node.data.settings, fixture.settings);
      const config = {
        log: { loglevel: 'none' },
        inbounds: [inboundPreview(node.data)],
        outbounds: ['dns-route', 'data-route'].map((tag) => ({ tag, protocol: 'blackhole' })),
        routing: {
          rules: inboundPreFilters(node.data).map((item) => ({
            type: 'field',
            ...item.match,
            outboundTag: `${item.branch}-route`,
          })),
        },
      };
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
      expect(result.error).toBeUndefined();
      expect(result.status, `${fixture.name}: ${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Configuration OK.');
    });
});
