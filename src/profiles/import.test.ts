import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { importProfiles, mergeImport, parseStash, vlessLink } from './import';
import { applyStashedProfile } from './graph';
import { factoryDefaults, resolveGraph } from '../graph/defaults';
const id = 'ba640cce-3c50-46f5-8406-bf36f35b5c90';
const link = (extra = '', host = 'edge.example.net') =>
  `vless://${id}@${host}:443?security=tls&type=ws&host=cdn.example.net&path=%2Froute${extra}#Friendly%20route`;
const empty = () => ({
  format: 'wayrill.stash' as const,
  version: 3 as const,
  groups: [],
});
describe('Subscription import and stash', () => {
  it('maps VLESS TLS, transport, IPv6 and Unicode names without decoding values twice', () => {
    const result = importProfiles(
      link('&sni=www.example.net&fp=firefox&alpn=h2%2Chttp%2F1.1', '[2001:db8::1]').replace(
        'Friendly%20route',
        '%E8%B7%B3%E8%B7%83',
      ),
    );
    expect(result.groups[0].entries[0]).toMatchObject({
      name: '\u8df3\u8dc3',
      profile: {
        settings: {
          address: '2001:db8::1',
          path: '/route',
          fingerprint: 'firefox',
          alpn: 'h2,http/1.1',
        },
      },
    });
  });
  it('rejects ambiguous duplicate parameters and malformed server identity', () => {
    expect(() => vlessLink(link('&fp=chrome&fp=firefox'))).toThrow(/Repeated/);
    expect(() => vlessLink(`vless://${id}@edge.example.net?security=tls`)).toThrow(/explicit port/);
  });
  it('imports a mixed Base64URL subscription, deduplicates connections and identifies bad rows', () => {
    const source = [
      link().replace('Friendly%20route', 'Québec🛰'),
      link(),
      link('&fp=firefox'),
      'trojan://test@other.example.net:443#Other',
      'ss://opaque#Another',
      'this is not a profile',
    ].join('\n');
    const result = importProfiles(Buffer.from(source).toString('base64url'));
    expect(result.groups[0].entries).toMatchObject([
      { name: 'Québec🛰', profile: { kind: 'vless-outbound' } },
      { profile: { settings: { fingerprint: 'firefox' } } },
      { profile: { kind: 'trojan-outbound' } },
      { raw: 'ss://opaque#Another', profile: null },
    ]);
    expect(result).toMatchObject({
      duplicates: 1,
      rejected: 1,
      problems: [expect.stringMatching(/Entry 6/)],
    });
  });
  it('imports v2rayN and v2rayNG subscription-group metadata and request headers', () => {
    const result = importProfiles(
      JSON.stringify([
        {
          Id: 'source-n',
          Remarks: 'Group N',
          Url: 'https://example.net/sub?token=test',
          UserAgent: 'client-n',
          RequestHeaders: '{"Authorization":"Bearer test"}',
        },
        {
          remarks: 'Group NG',
          url: 'https://example.net/ng',
          userAgent: 'client-ng',
          allowInsecureUrl: false,
        },
      ]),
    );
    expect(result.groups.map((g) => g.name)).toEqual(['Group N', 'Group NG']);
    expect(result.groups[0].headers).toEqual({ Authorization: 'Bearer test' });
    expect(result.groups.every((g) => g.entries.length === 0 && g.updatedAt === null)).toBe(true);
  });
  it('imports and persists a realistic 5,000-entry library group', () => {
    const result = importProfiles(
      Array.from({ length: 5000 }, (_, i) => link('', `edge${i}.example.net`)).join('\n'),
      'Large group',
    );
    expect(result.groups[0].entries).toHaveLength(5000);
    expect(result.groups[0].entries.every((e) => e.profile)).toBe(true);
    const stash = mergeImport(empty(), result);
    expect(parseStash(JSON.stringify(stash)).groups[0].entries).toHaveLength(5000);
  }, 15000);
  it('enforces entry-count and import-size limits before mutation', () => {
    expect(() => importProfiles(Array(50001).fill(link()).join('\n'))).toThrow(/50,000/);
    expect(() => importProfiles('x'.repeat(32 * 1024 * 1024 + 1))).toThrow(/32 MiB/);
  });
});
describe('Assigning a stashed configuration', () => {
  it('marks only supplied inherited settings as overrides; absent ones follow workspace defaults', () => {
    const graph = { name: 'Defaults', nodes: [], edges: [], defaults: factoryDefaults() };
    graph.defaults.settings.fingerprint = 'firefox';
    const entry = importProfiles(link()).groups[0].entries[0],
      next = resolveGraph(applyStashedProfile(graph, entry, { x: 0, y: 0 }));
    expect(next.nodes[0].data.settings.fingerprint).toBe('firefox');
    expect(next.nodes[0].data.overrides).not.toContain('fingerprint');
    const explicit = importProfiles(link('&fp=')).groups[0].entries[0];
    const other = resolveGraph(applyStashedProfile(graph, explicit, { x: 0, y: 0 }));
    expect(other.nodes[0].data.settings.fingerprint).toBe('');
    expect(other.nodes[0].data.overrides).toContain('fingerprint');
  });
});
