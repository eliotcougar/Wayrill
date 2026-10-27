import { describe, expect, it } from 'vitest';
import { makeNode, getDefinition, getOutputPorts, summarizeNode } from './catalog';
import { applyDefaults, enableDefaults, overrideSetting, resetNodeDefaults } from './defaults';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { outboundBundle, outboundPreview, outboundProblems } from './outbounds';
import { compileRuntimeGraph } from './runtime';
import { createTrafficExample } from './example';
import { importProfiles, parseStash } from '../profiles/import';
import { applyStashedProfile } from '../profiles/graph';

const configured = () => {
  const node = makeNode('socks-outbound', { x: 0, y: 0 }, 'socks-out');
  Object.assign(node.data.settings, { address: '127.0.0.1', port: 1090 });
  return node;
};
describe('SOCKS outbound', () => {
  it('is a distinct terminal destination with RAW, no security and no auth by default', () => {
    const node = configured();
    expect(getOutputPorts(node.data.kind)).toEqual(['observation']);
    expect(outboundPreview(node.data)).toMatchObject({
      protocol: 'socks',
      settings: { address: '127.0.0.1', port: 1090 },
      streamSettings: { network: 'raw', security: 'none' },
    });
    expect(outboundPreview(node.data).settings).not.toHaveProperty('user');
    expect(outboundPreview(node.data).settings).not.toHaveProperty('id');
    expect(outboundBundle(node.data)).toHaveLength(1);
    expect(
      getDefinition(node.data.kind).fields.some((f) =>
        ['flow', 'encryption', 'reverse', 'finalFragmentEnabled'].includes(f.key),
      ),
    ).toBe(false);
  });
  it('switches authentication without discarding inactive credentials or exposing them in node summaries', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      auth: 'password',
      username: 'qa-user',
      password: 'fictional-test-password',
    });
    expect(outboundPreview(node.data).settings).toMatchObject({
      user: 'qa-user',
      pass: 'fictional-test-password',
    });
    expect(JSON.stringify(summarizeNode(node.data))).not.toContain('fictional-test-password');
    node.data.settings.auth = 'none';
    expect(outboundPreview(node.data).settings).not.toHaveProperty('pass');
    const graph = parseGraph(serializeGraph({ name: 'Auth modes', nodes: [node], edges: [] }));
    expect(graph.nodes[0].data.settings.password).toBe('fictional-test-password');
  });
  it('validates missing addresses and authenticated usernames, using UTF-8 byte limits', () => {
    const node = configured();
    node.data.settings.address = '';
    node.data.settings.auth = 'password';
    expect(
      diagnoseGraph({ name: 'Invalid', nodes: [node], edges: [] }).map((p) => p.fieldKey),
    ).toEqual(expect.arrayContaining(['address', 'username']));
    Object.assign(node.data.settings, {
      address: '127.0.0.1',
      username: 'я'.repeat(128),
      password: 'я'.repeat(128),
    });
    expect(
      outboundProblems(node.data)
        .filter((p) => p.severity === 'error')
        .map((p) => p.fieldKey),
    ).toEqual(['username', 'password']);
    node.data.settings.username = 'я'.repeat(127);
    node.data.settings.password = '';
    expect(outboundProblems(node.data).filter((p) => p.severity === 'error')).toEqual([]);
    node.data.settings.auth = 'none';
    node.data.settings.password = 'x'.repeat(256);
    expect(outboundProblems(node.data).filter((p) => p.severity === 'error')).toEqual([]);
  });
  it('reuses transport/security/socket controls and honours global inheritance and reset', () => {
    const node = configured();
    Object.assign(node.data.settings, {
      network: 'ws',
      security: 'tls',
      serverName: 'edge.example.org',
      host: 'edge.example.org',
      path: '/socks',
      headers: '{"X-Test":"qa"}',
      interface: 'test-adapter',
      dialerProxy: 'direct',
    });
    let graph = enableDefaults({ name: 'Defaults', nodes: [node], edges: [] });
    const defaults = {
      ...graph.defaults!,
      settings: {
        ...graph.defaults!.settings,
        fingerprint: 'firefox',
        userAgent: 'Wayrill QA',
        tcpFastOpen: 'disabled',
      },
    };
    graph = applyDefaults(graph, defaults);
    expect(outboundPreview(graph.nodes[0].data)).toMatchObject({
      streamSettings: {
        tlsSettings: { fingerprint: 'firefox' },
        wsSettings: { headers: { 'User-Agent': 'Wayrill QA', 'X-Test': 'qa' } },
        sockopt: { tcpFastOpen: false, interface: 'test-adapter', dialerProxy: 'direct' },
      },
    });
    Object.assign(
      graph.nodes[0].data,
      overrideSetting(graph.nodes[0].data, 'fingerprint', 'chrome'),
    );
    expect(outboundPreview(graph.nodes[0].data)).toMatchObject({
      streamSettings: { tlsSettings: { fingerprint: 'chrome' } },
    });
    graph.nodes[0].data = resetNodeDefaults(graph.nodes[0].data, defaults, 'fingerprint');
    expect(outboundPreview(graph.nodes[0].data)).toMatchObject({
      streamSettings: { tlsSettings: { fingerprint: 'firefox' } },
    });
  });
  it('compiles as a destination in an ordinary graph', () => {
    const graph = createTrafficExample(),
      node = configured(),
      old = graph.nodes.find((n) => n.data.kind === 'vless-outbound')!;
    node.id = old.id;
    node.data.settings.tag = old.data.settings.tag;
    graph.nodes = graph.nodes.map((n) => (n.id === old.id ? node : n));
    expect(
      (compileRuntimeGraph(graph).config.outbounds as Record<string, unknown>[]).some(
        (o) => o.protocol === 'socks',
      ),
    ).toBe(true);
  });
  it('imports modern and single-server legacy native SOCKS profiles into a secure-stash-compatible shape', () => {
    for (const settings of [
      { address: '127.0.0.1', port: 1090, user: 'qa-user', pass: 'qa-only' },
      {
        servers: [
          {
            address: '127.0.0.1',
            port: 1090,
            users: [{ user: 'qa-user', pass: 'qa-only', level: 3, email: 'test' }],
          },
        ],
      },
    ]) {
      const result = importProfiles(
          JSON.stringify({ protocol: 'socks', tag: 'socks-qa', settings }),
        ),
        entry = result.groups[0].entries[0];
      expect(entry.profile?.kind).toBe('socks-outbound');
      expect(entry.profile?.settings).toMatchObject({
        address: '127.0.0.1',
        port: 1090,
        auth: 'password',
        username: 'qa-user',
        password: 'qa-only',
      });
      const stash = parseStash(
        JSON.stringify({
          format: 'wayrill.stash',
          version: 3,

          groups: result.groups,
        }),
      );
      expect(stash.groups[0].entries[0].profile?.kind).toBe('socks-outbound');
      expect(
        applyStashedProfile(createTrafficExample(), entry, { x: 0, y: 0 }).nodes.some(
          (n) => n.data.kind === 'socks-outbound',
        ),
      ).toBe(true);
    }
    const entry = importProfiles(
      JSON.stringify({
        protocol: 'socks',
        settings: {
          servers: [
            { address: 'one.example.org', port: 1080 },
            { address: 'two.example.org', port: 1080 },
          ],
        },
      }),
    ).groups[0].entries[0];
    expect(entry.profile).toBeNull();
    expect(entry.problem).toContain('policy group');
  });
  it('keeps named auth authoritative over advanced JSON', () => {
    const node = configured();
    node.data.settings.protocolExtra = '{"servers":[],"user":"hidden","pass":"hidden"}';
    const settings = outboundPreview(node.data).settings;
    expect(settings).not.toHaveProperty('servers');
    expect(settings).not.toHaveProperty('user');
    expect(settings).not.toHaveProperty('pass');
  });
});
