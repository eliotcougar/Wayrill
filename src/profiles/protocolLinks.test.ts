/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import * as wayrill from './import';
import * as aquifer from '../../aquifer/src/profiles/import';
import { fixtureId, fixtureKey } from '../graph/protocolFixtures';
import { makeNode as wayrillNode } from '../graph/catalog';
import { outboundPreview as wayrillOutbound } from '../graph/outbounds';
import { makeNode as aquiferNode } from '../../aquifer/src/graph/catalog';
import { outboundPreview as aquiferOutbound } from '../../aquifer/src/graph/outbounds';
const cases = [
  [
    'vmess',
    `vmess://${btoa(JSON.stringify({ v: '2', ps: 'VMess QA', add: '127.0.0.1', port: 20922, id: fixtureId, aid: 0, net: 'ws', path: '/qa', tls: 'tls', sni: 'qa.example.invalid', scy: 'auto' }))}`,
    'vmess-outbound',
  ],
  [
    'wireguard',
    `wireguard://${encodeURIComponent(fixtureKey)}@127.0.0.1:20922?publickey=${encodeURIComponent(fixtureKey)}&address=10.90.0.2&reserved=0,0,0&mtu=1420`,
    'wireguard-outbound',
  ],
  [
    'masque',
    'masque://qa:fictional-qa-only@qa.example.invalid:20922?sni=qa.example.invalid',
    'masque-outbound',
  ],
] as const;
describe('protocol subscription links', () => {
  const { parseEntry, importProfiles } = wayrill;
  it.each([
    [
      'socks',
      'socks',
      `socks://${encodeURIComponent('qa:p@ss:🦊')}@127.0.0.1:20922`,
      'qa',
      'p@ss:🦊',
    ],
    ['socks5', 'socks', 'socks5://qa:@127.0.0.1:20922', 'qa', ''],
    ['legacy SOCKS', 'socks', `socks://${btoa('qa:p@ss:/?#@127.0.0.1:20922')}`, 'qa', 'p@ss:/?#'],
    [
      'ss',
      'shadowsocks',
      `ss://${encodeURIComponent('aes-128-gcm:p@ss:🦊')}@127.0.0.1:20922`,
      'aes-128-gcm',
      'p@ss:🦊',
    ],
  ])(
    'preserves the credentials in %s links through Stash import',
    (_scheme, protocol, link, user, pass) => {
      const entry = parseEntry(link);
      expect(entry.problem).toBe('');
      if (protocol === 'socks')
        expect(entry.profile?.settings).toMatchObject({
          auth: 'password',
          username: user,
          password: pass,
        });
      else
        expect(JSON.parse(String(entry.profile?.settings.json)).settings).toMatchObject({
          method: user,
          password: pass,
        });
    },
  );
  for (const [name, link, kind] of cases)
    it(`imports ${name} into a ready stash profile`, () => {
      const [entry] = importProfiles(btoa(link)).groups[0].entries;
      expect(entry.problem).toBe('');
      expect(entry.profile?.kind).toBe(kind);
    });
  it('keeps HTTP and HTTPS connections to the same proxy distinct', () => {
    const endpoint = 'qa:secret@proxy.example:20922';
    const [group] = importProfiles(`http://${endpoint}\nhttps://${endpoint}`).groups;
    const connections = group.entries.map(({ profile }) => {
      const { kind, settings } = profile!;
      const node = wayrillNode(kind, { x: 0, y: 0 });
      Object.assign(node.data.settings, settings);
      return wayrillOutbound(node.data);
    });
    expect(connections).toMatchObject([
      { protocol: 'http', settings: { address: 'proxy.example', user: 'qa', pass: 'secret' } },
      { protocol: 'http', streamSettings: { security: 'tls' } },
    ]);
    expect(
      (connections[0].streamSettings as { security?: string } | undefined)?.security ?? 'none',
    ).toBe('none');
  });
  it('preserves trailing colons in opaque Trojan and Hysteria 2 credentials', () => {
    const trojan = parseEntry('trojan://secret:@example.test:443');
    expect(trojan.problem).toBe('');
    expect(JSON.parse(String(trojan.profile?.settings.json)).settings.password).toBe('secret:');
    const hysteria = parseEntry(
      'hysteria2://secret:@example.test:443?obfs=salamander&obfs-password=mask',
    );
    expect(JSON.parse(String(hysteria.profile?.settings.json)).streamSettings).toMatchObject({
      hysteriaSettings: { auth: 'secret:' },
      finalmask: { udp: [{ type: 'salamander', settings: { password: 'mask' } }] },
    });
  });
  it.each([
    ['insecure TLS', 'trojan://qa@127.0.0.1:443?insecure=1'],
    ['Shadowsocks plugin', 'ss://YWVzLTEyOC1nY206cWE=@127.0.0.1:443?plugin=obfs-local'],
    ['invalid port', 'hysteria2://qa@host.example:0'],
    ['unmapped Trojan flow', 'trojan://qa@host.example:443?flow=xtls-rprx-vision'],
    ['unknown protocol', 'tuic://qa@host.example:443'],
  ])('retains the original link for %s', (_reason, link) => {
    const entry = parseEntry(link);
    expect(entry.raw).toBe(link);
    expect(entry.profile).toBeNull();
    expect(entry.problem).toBeTruthy();
  });
});

it('carries link credentials through Aquifer’s Stash adapter and retains unsupported entries', () => {
  const [group] = aquifer.importProfiles(
    'socks://qa:p%40ss@proxy.example:1080\ntuic://qa@proxy.example:443',
  ).groups;
  expect(group.entries[0].profile?.settings).toMatchObject({ username: 'qa', password: 'p@ss' });
  expect(group.entries[1]).toMatchObject({ raw: 'tuic://qa@proxy.example:443', profile: null });
});

describe.each([
  [
    'Wayrill',
    wayrill,
    (raw: unknown) => {
      const profile = wayrill.xrayOutbound(raw);
      const node = wayrillNode(profile.kind, { x: 0, y: 0 });
      Object.assign(node.data.settings, profile.settings);
      return wayrillOutbound(node.data);
    },
  ],
  [
    'Aquifer',
    aquifer,
    (raw: unknown) => {
      const profile = aquifer.xrayOutbound(raw);
      const node = aquiferNode(profile.kind, { x: 0, y: 0 });
      Object.assign(node.data.settings, profile.settings);
      return aquiferOutbound(node.data);
    },
  ],
] as const)('%s outbound import/export', (_app, importer, render) => {
  it('preserves credentials and socket options when importing legacy SOCKS JSON', () => {
    const raw = {
      protocol: 'socks',
      settings: {
        servers: [
          {
            address: 'example.test',
            port: 1080,
            users: [{ user: 'qa', pass: 'p@ss:🦊', level: 1, email: 'qa@example.test' }],
          },
        ],
      },
      streamSettings: { sockopt: { tcpKeepAliveIdle: 45, tcpFastOpen: false, mark: 7 } },
    };
    expect(render(raw)).toMatchObject({
      protocol: 'socks',
      settings: {
        address: 'example.test',
        port: 1080,
        user: 'qa',
        pass: 'p@ss:🦊',
        level: 1,
        email: 'qa@example.test',
      },
      streamSettings: raw.streamSettings,
    });
  });

  it('keeps nested XHTTP options and normalizes User-Agent through the app adapter', () => {
    const raw = {
      protocol: 'vless',
      settings: { address: 'example.test', port: 443, id: fixtureId, encryption: 'none' },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: { serverName: 'example.test', alpn: ['h2'] },
        xhttpSettings: {
          path: '/route',
          mode: 'auto',
          extra: {
            headers: { 'User-Agent': 'QA client', 'X-QA': 'preserved' },
            xmux: { maxConnections: '2-4' },
          },
        },
      },
    };
    expect(importer.xrayOutbound(raw).settings.userAgent).toBe('QA client');
    expect(render(raw)).toMatchObject(raw);
    const loaded = importer.importProfiles(JSON.stringify([raw]));
    const restored = importer.parseStash(
      importer.serializeStash({
        format: 'wayrill.stash',
        version: 3,
        groups: loaded.groups,
      }),
    );
    expect(restored.groups[0].entries[0].profile).toEqual(loaded.groups[0].entries[0].profile);
    const ws = {
      ...raw,
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: raw.streamSettings.tlsSettings,
        wsSettings: { path: '/route', headers: { 'User-Agent': 'QA client' } },
      },
      mux: { enabled: true, concurrency: 8 },
    };
    expect(render(ws)).toMatchObject(ws);
  });

  it('preserves Direct and Block options without applying proxy defaults', () => {
    for (const raw of [
      {
        protocol: 'freedom',
        settings: { redirect: '127.0.0.1:8080', userLevel: 1 },
        streamSettings: { sockopt: { interface: 'Ethernet', tcpKeepAliveIdle: 45 } },
      },
      { protocol: 'blackhole', settings: { response: { type: 'http' } } },
    ])
      expect(render(raw)).toMatchObject(raw);
  });

  it('retains unsupported or invalid native entries instead of dropping their options', () => {
    for (const value of [
      {
        protocol: 'socks',
        settings: {
          servers: [
            { address: 'one.example.test', port: 1080 },
            { address: 'two.example.test', port: 1080 },
          ],
        },
      },
      {
        protocol: 'vless',
        settings: { address: 'example.test', port: 443, id: fixtureId },
        streamSettings: { network: 'raw', wsSettings: { path: '/unused' } },
      },
      { protocol: 'socks', settings: { address: 'example.test', port: 1080.5 } },
    ]) {
      const raw = JSON.stringify(value);
      expect(importer.parseEntry(raw)).toMatchObject({
        raw,
        profile: null,
        problem: expect.any(String),
      });
      expect(() => importer.xrayOutbound(value)).toThrow();
    }
  });
});
