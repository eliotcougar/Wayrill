/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { decodeBase64, importProfiles, parseEntry } from './import';
import { protocolLink } from './protocolLinks';
import { fixtureId, fixtureKey } from '../graph/protocolFixtures';
const cases = [
  [
    'vmess',
    `vmess://${btoa(JSON.stringify({ v: '2', ps: 'VMess QA', add: '127.0.0.1', port: 20922, id: fixtureId, aid: 0, net: 'ws', path: '/qa', tls: 'tls', sni: 'qa.example.invalid', scy: 'auto' }))}`,
    'vmess-outbound',
  ],
  [
    'trojan',
    'trojan://fictional-qa-only@127.0.0.1:20922?type=grpc&serviceName=qa&sni=qa.example.invalid#Trojan',
    'trojan-outbound',
  ],
  [
    'shadowsocks',
    `ss://${btoa('aes-128-gcm:fictional-qa-only')}@127.0.0.1:20922#SS`,
    'shadowsocks-outbound',
  ],
  ['socks', `socks://${btoa('qa:fictional-qa-only')}@127.0.0.1:20922#SOCKS`, 'socks-outbound'],
  ['http', 'http://qa:fictional-qa-only@127.0.0.1:20922#HTTP', 'http-outbound'],
  ['https', 'https://qa:fictional-qa-only@qa.example.invalid:20922#HTTPS', 'http-outbound'],
  [
    'wireguard',
    `wireguard://${encodeURIComponent(fixtureKey)}@127.0.0.1:20922?publickey=${encodeURIComponent(fixtureKey)}&address=10.90.0.2&reserved=0,0,0&mtu=1420`,
    'wireguard-outbound',
  ],
  [
    'hysteria2',
    'hysteria2://fictional-qa-only@qa.example.invalid?sni=qa.example.invalid&obfs=salamander&obfs-password=fictional-qa-mask',
    'hysteria-outbound',
  ],
  [
    'masque',
    'masque://qa:fictional-qa-only@qa.example.invalid:20922?sni=qa.example.invalid',
    'masque-outbound',
  ],
] as const;
describe('Protocol subscription links', () => {
  it.each([
    [
      'socks',
      'socks',
      `socks://${encodeURIComponent('qa:p@ss:🦊')}@127.0.0.1:20922`,
      'qa',
      'p@ss:🦊',
    ],
    ['socks5', 'socks', 'socks5://qa:@127.0.0.1:20922', 'qa', ''],
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
      const parsed = protocolLink(link, decodeBase64);
      expect(parsed.config.protocol).toBe(protocol);
      expect(parsed.config.settings).toMatchObject(
        protocol === 'socks' ? { user, pass } : { method: user, password: pass },
      );
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
      const entry = parseEntry(link);
      expect(entry.problem).toBe('');
      expect(entry.profile?.kind).toBe(kind);
      expect(importProfiles(btoa(link)).groups[0].entries[0].profile?.kind).toBe(kind);
    });
  for (const link of [
    'trojan://qa@127.0.0.1:443?insecure=1',
    'ss://YWVzLTEyOC1nY206cWE=@127.0.0.1:443?plugin=obfs-local',
    'hysteria2://qa@host.example:0',
    'trojan://qa@host.example:443?flow=xtls-rprx-vision',
    'tuic://qa@host.example:443',
    'trojan://qa@host.example:443?unknown=tuning',
  ])
    it(`retains unsupported ${link.slice(0, link.indexOf(':'))} settings`, () => {
      const entry = parseEntry(link);
      expect(entry.raw).toBe(link);
      expect(entry.profile).toBeNull();
      expect(entry.problem).toBeTruthy();
    });
});
