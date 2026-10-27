import { describe, expect, it } from 'vitest';
import { importProfiles, mergeImport, parseStash, vlessLink, xrayOutbound } from './import';
import { applyStashedProfile } from './graph';
import { makeNode } from '../graph/catalog';
import { createTrafficExample } from '../graph/example';
import { factoryDefaults, resolveGraph } from '../graph/defaults';
import { outboundPreview } from '../graph/outbounds';
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
  it('accepts Base64URL UTF-8 subscription lists and removes duplicate configurations', () => {
    const plain = `${link()}\n${link().replace('Friendly%20route', 'Different%20name')}\n${link('&fp=firefox')}`;
    const result = importProfiles(btoa(plain).replace(/=/g, ''));
    expect(result.groups[0].entries).toHaveLength(2);
    expect(result.duplicates).toBe(1);
  });
  it.each([
    'type=not-a-transport',
    'allowInsecure=true',
    'mystery=important',
    'seed=private',
    'type=grpc&extra=%7B%7D',
  ])('retains unsupported VLESS instead of losing an option: %s', (option) => {
    const text = `vless://${id}@edge.example.net:443?security=tls&${option}`;
    const entry = importProfiles(text).groups[0].entries[0];
    expect(entry.profile).toBeNull();
    expect(entry.raw).toBe(text);
    expect(entry.problem).not.toBe('');
  });
  it('maps REALITY identity and native XHTTP extra', () => {
    const p = vlessLink(
      `vless://${id}@edge.example.net:443?type=tcp&security=reality&pbk=${'A'.repeat(43)}&sid=ab12&sni=www.example.net&fp=chrome&flow=xtls-rprx-vision`,
    );
    expect(p.settings).toMatchObject({
      network: 'raw',
      realityPassword: 'A'.repeat(43),
      shortId: 'ab12',
      flow: 'xtls-rprx-vision',
    });
    const x = vlessLink(
      `vless://${id}@edge.example.net:443?type=xhttp&security=tls&mode=stream-one&extra=%7B%22noGRPCHeader%22%3Atrue%7D`,
    );
    expect(JSON.parse(String(x.settings.xhttpExtra))).toEqual({ noGRPCHeader: true });
  });
  it('normalizes international VLESS server hostnames', () => {
    expect(vlessLink(link('', 'пример.рф')).settings.address).toBe('xn--e1afmkfd.xn--p1ai');
  });
  it('rejects ambiguous duplicate parameters and malformed server identity', () => {
    expect(() => vlessLink(link('&fp=chrome&fp=firefox'))).toThrow(/Repeated/);
    expect(() => vlessLink(`vless://${id}@edge.example.net?security=tls`)).toThrow(/explicit port/);
  });
  it('retains mixed protocol subscriptions and reports malformed rows without putting them on the graph', () => {
    const result = importProfiles(
      `${link()}\ntrojan://test@other.example.net:443#Other\nss://opaque#Another\nthis is not a profile`,
    );
    expect(result.groups[0].entries).toHaveLength(3);
    expect(result.groups[0].entries.filter((e) => e.profile)).toHaveLength(2);
    expect(result.rejected).toBe(1);
    expect(result.problems[0]).toMatch(/Entry 4/);
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
  it('refreshes one group atomically and keeps independently copied graph configurations', () => {
    let stash = mergeImport(empty(), importProfiles(link()));
    const group = stash.groups[0];
    group.url = 'https://example.net/list';
    const graph = applyStashedProfile(
      { name: 'Copied', nodes: [], edges: [], defaults: factoryDefaults() },
      group.entries[0],
      { x: 32, y: 48 },
    );
    stash = mergeImport(stash, importProfiles(link('&fp=firefox', 'new.example.net')), group.id);
    expect(stash.groups[0].url).toBe(group.url);
    expect(stash.groups[0].id).toBe(group.id);
    expect(graph.nodes[0].data.settings.address).toBe('edge.example.net');
    expect(() =>
      mergeImport(stash, importProfiles('[{"url":"https://example.net/other"}]'), group.id),
    ).toThrow(/one configuration list/);
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
  it('round-trips the stash and rejects invalid persisted node kinds', () => {
    const stash = mergeImport(empty(), importProfiles(link()));
    expect(parseStash(JSON.stringify(stash))).toEqual(stash);
    const raw = JSON.parse(JSON.stringify(stash));
    raw.groups[0].entries[0].profile.kind = 'app-output';
    expect(() => parseStash(JSON.stringify(raw))).toThrow(/node kind/);
  });
});
describe('Supported Xray outbound import', () => {
  it('maps legacy vnext VLESS account shape without losing explicit false/blank defaults', () => {
    const p = xrayOutbound({
      protocol: 'vless',
      tag: 'remote',
      settings: {
        vnext: [
          {
            address: 'edge.example.net',
            port: 443,
            users: [{ id, encryption: 'none', flow: '', level: 2 }],
          },
        ],
      },
      streamSettings: {
        network: 'tcp',
        security: 'tls',
        tlsSettings: {
          serverName: 'www.example.net',
          fingerprint: '',
          enableSessionResumption: false,
        },
        sockopt: { tcpFastOpen: false },
      },
      mux: { enabled: false, concurrency: 8 },
    });
    expect(p.settings).toMatchObject({
      address: 'edge.example.net',
      userLevel: 2,
      fingerprint: '',
      sessionResumption: false,
      muxEnabled: false,
      tcpFastOpen: 'disabled',
    });
  });
  it.each(['raw', 'ws', 'httpupgrade', 'xhttp', 'grpc', 'kcp', 'hysteria'])(
    'round-trips the existing %s node export',
    (network) => {
      const node = makeNode('vless-outbound', { x: 0, y: 0 });
      Object.assign(node.data.settings, {
        id,
        address: 'edge.example.net',
        network,
        security: 'tls',
        serverName: 'www.example.net',
      });
      const original = outboundPreview(node.data),
        profile = xrayOutbound(original);
      const imported = makeNode(profile.kind, { x: 0, y: 0 });
      Object.assign(imported.data.settings, profile.settings);
      expect(outboundPreview(imported.data)).toEqual(original);
    },
  );
  it('maps Direct and Block, and refuses multiple VLESS users or unknown top-level options', () => {
    expect(
      xrayOutbound({
        protocol: 'freedom',
        tag: 'direct',
        settings: { domainStrategy: 'UseIPv4' },
        streamSettings: { sockopt: { interface: 'test-adapter' } },
      }),
    ).toMatchObject({ kind: 'direct-outbound', settings: { interface: 'test-adapter' } });
    expect(
      xrayOutbound({ protocol: 'blackhole', settings: { response: { type: 'http' } } }),
    ).toMatchObject({ kind: 'block-outbound', settings: { response: 'http' } });
    expect(() =>
      xrayOutbound({ protocol: 'vless', settings: { vnext: [{ users: [{ id }, { id }] }] } }),
    ).toThrow(/One VLESS/);
    expect(() => xrayOutbound({ protocol: 'vless', proxySettings: { tag: 'other' } })).toThrow(
      /Unmapped/,
    );
  });
  it('imports an entire Xray configuration into the stash as separate outbound snapshots', () => {
    const result = importProfiles(
      JSON.stringify({
        inbounds: [],
        outbounds: [
          { protocol: 'freedom', settings: {} },
          { protocol: 'blackhole', settings: { response: { type: 'none' } } },
        ],
      }),
    );
    expect(result.groups[0].entries.map((e) => e.profile?.kind)).toEqual([
      'direct-outbound',
      'block-outbound',
    ]);
  });
});
describe('Assigning a stashed configuration', () => {
  it('preserves replacement identity, tag, position and wires', () => {
    const graph = createTrafficExample(),
      before = graph.nodes.find((n) => n.id === 'preferred')!,
      entry = importProfiles(link()).groups[0].entries[0];
    const next = applyStashedProfile(graph, entry, { x: 999, y: 999 }, before.id),
      after = next.nodes.find((n) => n.id === before.id)!;
    expect(after.position).toEqual(before.position);
    expect(after.data.settings.tag).toBe(before.data.settings.tag);
    expect(after.data.settings.address).toBe('edge.example.net');
    expect(next.edges.map((e) => [e.source, e.target])).toEqual(
      graph.edges.map((e) => [e.source, e.target]),
    );
    expect(next.nodes).toHaveLength(graph.nodes.length);
  });
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
  it('chooses unique tags for newly added nodes and rejects invalid replacement targets', () => {
    const entry = importProfiles(link()).groups[0].entries[0];
    let graph = applyStashedProfile({ name: 'Unique', nodes: [], edges: [] }, entry, {
      x: 0,
      y: 0,
    });
    graph = applyStashedProfile(graph, entry, { x: 10, y: 10 });
    expect(new Set(graph.nodes.map((n) => n.data.settings.tag)).size).toBe(2);
    expect(() => applyStashedProfile(graph, entry, { x: 0, y: 0 }, 'missing')).toThrow(/Select/);
  });
});

it('removes only the fictional placeholder note during replacement', () => {
  const graph = createTrafficExample(),
    entry = importProfiles(link()).groups[0].entries[0];
  const previous = graph.nodes.find((n) => n.data.kind === 'vless-outbound')!;
  previous.data.description =
    'Fictional placeholder. Replace with a working VLESS profile before testing.';
  const replaced = applyStashedProfile(graph, entry, { x: 900, y: 900 }, previous.id);
  expect(replaced.nodes.find((n) => n.id === previous.id)!.data.description).toBe('');
  expect(replaced.nodes.find((n) => n.id === previous.id)!.position).toEqual(previous.position);
  previous.data.description = 'My private route notes';
  expect(
    applyStashedProfile(graph, entry, { x: 900, y: 900 }, previous.id).nodes.find(
      (n) => n.id === previous.id,
    )!.data.description,
  ).toBe('My private route notes');
  expect(previous.data.description).toBe('My private route notes');
});

it.each([true, false])(
  'keeps the original star (%s) when an unlocked provider copy is consolidated',
  (starred) => {
    let stash = mergeImport(empty(), importProfiles(link()));
    const original = stash.groups[0].entries[0];
    original.starred = starred;
    original.locked = true;
    const update = importProfiles(link('&fp=firefox', 'updated.example.net'));
    stash = mergeImport(stash, update, stash.groups[0].id);
    const [copy, locked] = stash.groups[0].entries;
    expect(copy.sourceCopyOf).toBe(original.id);
    expect(copy.starred).toBeUndefined();
    locked.locked = false;
    copy.starred = !starred;
    const restored = mergeImport(stash, update, stash.groups[0].id).groups[0].entries;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: original.id, starred });
    expect(restored[0].profile!.settings.address).toBe('updated.example.net');
  },
);
