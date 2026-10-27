/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDefinition, getOutputPorts, makeNode, makeProxyInbound } from './catalog';
import { applyDefaults, factoryDefaults, resetNodeDefaults, resolveGraph } from './defaults';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { diagnoseRuntimeGraph } from './diagnostics';
import { inboundEndpoints } from './inbounds';
import { importXrayConfig } from './xrayImport';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import {
  commonKeys,
  isProtocolKind,
  loopbackProblems,
  protocolConfig,
  protocolInboundKinds,
  protocolOutboundKinds,
  protocolProblems,
  protocolSpecs,
  specForKind,
} from './protocols';
import { fieldsForStructure, structureProblems } from './protocolFields';
import { protocolSource } from './protocolSource';
import { fixtureId, protocolFixture } from './protocolFixtures';
import { xrayOutbound, importProfiles, parseStash } from '../profiles/import';
import { applyStashedProfile } from '../profiles/graph';
import { editNativeField } from './nativeFields';
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
const wrap = (outbound: Record<string, unknown>) => ({
  inbounds: [
    {
      tag: 'in',
      protocol: 'mixed',
      listen: '127.0.0.1',
      port: 20920,
      settings: { auth: 'noauth', udp: true },
    },
  ],
  outbounds: [outbound],
  routing: { rules: [] },
});
describe('Every pinned Xray protocol family', () => {
  it('covers every registered protocol and alias from the audited loaders', () => {
    expect(
      protocolSpecs
        .filter((p) => p.direction === 'inbound' && p.kind !== 'ics-tun')
        .flatMap((p) => [p.protocol, ...(p.aliases ?? [])])
        .sort(),
    ).toEqual(
      [
        'tunnel',
        'dokodemo-door',
        'http',
        'shadowsocks',
        'mixed',
        'socks',
        'vless',
        'vmess',
        'trojan',
        'wireguard',
        'hysteria',
        'masque',
        'tun',
      ].sort(),
    );
    expect(
      protocolSpecs
        .filter((p) => p.direction === 'outbound')
        .flatMap((p) => [p.protocol, ...(p.aliases ?? [])])
        .sort(),
    ).toEqual(
      [
        'block',
        'blackhole',
        'loopback',
        'direct',
        'freedom',
        'http',
        'shadowsocks',
        'socks',
        'vless',
        'vmess',
        'trojan',
        'hysteria',
        'masque',
        'dns',
        'wireguard',
      ].sort(),
    );
  });
  // Native TUN JSON does not carry the service-owned ICS role; its graph round trip
  // and activation metadata are tested in internetSharing.test.ts.
  for (const kind of [
    ...protocolInboundKinds.filter((k) => k !== 'ics-tun'),
    ...protocolOutboundKinds,
  ])
    it(`${kind}: graph storage and no-change native equality`, () => {
      const spec = specForKind(kind)!,
        raw = protocolFixture(spec),
        config =
          spec.direction === 'outbound'
            ? wrap(raw)
            : { inbounds: [raw], outbounds: [{ tag: 'direct', protocol: 'direct', settings: {} }] };
      const graph = parseGraph(serializeGraph(importXrayConfig(JSON.stringify(config))));
      expect(graph.nodes.some((n) => n.data.kind === kind)).toBe(true);
      expect(compileXrayGraph(graph).config).toEqual(config);
      expect(getOutputPorts(kind)).toEqual(
        spec.direction === 'inbound'
          ? kind === 'tun-inbound'
            ? ['traffic', 'dns']
            : ['traffic']
          : ['observation'],
      );
    });
  for (const kind of protocolOutboundKinds)
    it(`${kind}: stash import, graph insertion and replacement`, () => {
      const raw = protocolFixture(specForKind(kind)!),
        profile = xrayOutbound(raw);
      expect(profile.kind).toBe(kind);
      const result = importProfiles(JSON.stringify({ outbounds: [raw] }));
      expect(result.groups[0].entries[0].profile?.kind).toBe(kind);
      const stash = parseStash(
          JSON.stringify({
            format: 'wayrill.stash',
            version: 3,

            groups: result.groups,
          }),
        ),
        entry = stash.groups[0].entries[0];
      const graph = applyStashedProfile(
        { name: 'QA', nodes: [], edges: [], defaults: factoryDefaults() },
        entry,
        { x: 0, y: 0 },
      );
      expect(protocolConfig(graph.nodes[0].data)).toEqual(raw);
      const next = applyStashedProfile(graph, entry, { x: 99, y: 99 }, graph.nodes[0].id);
      expect(next.nodes[0].id).toBe(graph.nodes[0].id);
      expect(next.nodes[0].position).toEqual({ x: 0, y: 0 });
    });
  it('exports defaults and explicit false/zero overrides without changing imported omissions', () => {
    const raw = {
        tag: 'vmess',
        protocol: 'vmess',
        settings: { address: '127.0.0.1', port: 20922, id: fixtureId, security: 'auto' },
        streamSettings: { network: 'raw', security: 'tls' },
      },
      graph = importXrayConfig(JSON.stringify(wrap(raw))),
      node = graph.nodes.find((n) => n.data.kind === 'vmess-outbound')!;
    let next = applyDefaults(graph, {
      version: 1,
      settings: { ...graph.defaults!.settings, fingerprint: 'firefox', tcpKeepAliveIdle: -1 },
    });
    expect(compileXrayGraph(next).config).toEqual(wrap(raw));
    next = {
      ...next,
      nodes: next.nodes.map((n) =>
        n.id === node.id
          ? { ...n, data: resetNodeDefaults(n.data, next.defaults!, 'fingerprint') }
          : n,
      ),
    };
    expect((compileXrayGraph(next).config.outbounds as Record<string, unknown>[])[0]).toMatchObject(
      { streamSettings: { tlsSettings: { fingerprint: 'firefox' } } },
    );
    const output = next.nodes.find((n) => n.id === node.id)!;
    output.data.settings.tcpKeepAliveIdle = 0;
    output.data.settings.muxEnabled = false;
    expect(protocolConfig(output.data).settings).toEqual(raw.settings);
  });
  it('handles nested legacy endpoints, alias spelling, unknown fields and ordered accounts', () => {
    const raw = {
      tag: 'vmess',
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: '127.0.0.1',
            port: 20922,
            users: [
              {
                id: fixtureId,
                security: 'auto',
                level: 0,
                email: 'qa@example.invalid',
                future: 'retained',
              },
            ],
          },
        ],
      },
      StreamSettings: { Network: 'tcp', Security: 'tls' },
      future: false,
    };
    const graph = importXrayConfig(JSON.stringify(wrap(raw)));
    expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(wrap(raw));
    const node = graph.nodes.find((n) => n.data.kind === 'vmess-outbound')!,
      json = JSON.parse(String(node.data.settings.json));
    json.settings.vnext[0].users[0].email = 'new@example.invalid';
    node.data.settings.json = JSON.stringify(json);
    expect(protocolConfig(node.data)).toEqual({
      ...raw,
      settings: {
        vnext: [
          {
            ...raw.settings.vnext[0],
            users: [{ ...raw.settings.vnext[0].users[0], email: 'new@example.invalid' }],
          },
        ],
      },
    });
  });
  it('edits and validates value-struct mask arrays as ordered collections', () => {
    for (const key of ['tcp', 'udp'])
      expect(fieldsForStructure('FinalMask').find((f) => f.key === key)).toMatchObject({
        structure: 'Mask',
        collection: true,
        jsonShape: 'array',
        label: key === 'tcp' ? 'TCP masks' : 'UDP masks',
      });
    expect(structureProblems('FinalMask', { udp: [{ type: 42 }] })).toEqual([
      'settings.udp[0].type must be text.',
    ]);
    expect(
      structureProblems('FinalMask', {
        tcp: [{ type: 'fragment', settings: { packets: 'tlshello', future: true } }],
      }),
    ).toEqual([]);
  });
  it('validates unsigned/byte bounds, arrays and removed features', () => {
    expect(structureProblems('TrojanClientConfig', { level: 256 })).toHaveLength(1);
    expect(structureProblems('WireGuardConfig', { peers: [false] })).toHaveLength(1);
    const n = makeNode('masque-outbound', { x: 0, y: 0 });
    const j = JSON.parse(String(n.data.settings.json));
    j.mux = { enabled: true };
    n.data.settings.json = JSON.stringify(j);
    expect(protocolProblems(n.data).some((i) => i.message.includes('mux'))).toBe(true);
    j.mux.enabled = false;
    n.data.settings.json = JSON.stringify(j);
    expect(protocolProblems(n.data).some((i) => i.message.includes('mux'))).toBe(false);
  });
  it('applies policy levels to legacy accounts and removes an explicitly cleared transport header', () => {
    const raw = {
        tag: 'vmess',
        protocol: 'vmess',
        settings: {
          vnext: [
            {
              address: '127.0.0.1',
              port: 20922,
              users: [
                { id: fixtureId, level: 2 },
                { id: fixtureId, level: 3 },
              ],
            },
          ],
        },
        streamSettings: {
          network: 'ws',
          wsSettings: { headers: { 'User-Agent': 'QA', Host: 'qa.example.invalid' } },
        },
      },
      graph = importXrayConfig(JSON.stringify(wrap(raw))),
      node = graph.nodes.find((n) => n.data.kind === 'vmess-outbound')!;
    expect(node.data.settings.userLevel).toBe(2);
    node.data.settings.userLevel = 4;
    node.data.settings.userAgent = '';
    expect(protocolConfig(node.data)).toMatchObject({
      settings: {
        vnext: [
          {
            users: [
              { id: fixtureId, level: 4 },
              { id: fixtureId, level: 4 },
            ],
          },
        ],
      },
      streamSettings: { wsSettings: { headers: { Host: 'qa.example.invalid' } } },
    });
    expect(
      (
        protocolConfig(node.data).streamSettings as {
          wsSettings: { headers: Record<string, unknown> };
        }
      ).wsSettings.headers,
    ).not.toHaveProperty('User-Agent');
  });
  it('diagnoses invalid native drafts without crashing graph inspection', () => {
    const input = makeNode('vmess-inbound', { x: 0, y: 0 });
    input.data.settings.json = '{invalid';
    const other = makeProxyInbound('http', { x: 300, y: 0 }),
      graph = { name: 'QA', nodes: [input, other], edges: [], defaults: factoryDefaults() };
    expect(diagnoseGraph(graph).some((i) => i.nodeId === input.id && i.severity === 'error')).toBe(
      true,
    );
    expect(() => diagnoseRuntimeGraph(graph)).not.toThrow();
  });
  it('permits separate TCP and UDP listeners on one numeric port', () => {
    const tcp = makeProxyInbound('http', { x: 0, y: 0 }),
      udp = makeNode('wireguard-inbound', { x: 300, y: 0 }),
      raw = protocolFixture(specForKind('wireguard-inbound')!);
    raw.port = tcp.data.settings.port;
    delete raw.tag;
    udp.data.settings.json = JSON.stringify(raw);
    expect(inboundEndpoints(tcp.data)[0]).toMatch(/^tcp:/);
    expect(inboundEndpoints(udp.data)[0]).toMatch(/^udp:/);
    expect(
      diagnoseGraph({ name: 'QA', nodes: [tcp, udp], edges: [], defaults: factoryDefaults() }).some(
        (i) => i.message.includes('another inbound uses'),
      ),
    ).toBe(false);
  });
  it('allows a static UDP Tunnel beside SOCKS or Mixed on the same numeric port', () => {
    for (const mode of ['socks', 'mixed'] as const) {
      const tcp = makeProxyInbound(mode, { x: 0, y: 0 }),
        udp = makeNode('tunnel-inbound', { x: 300, y: 0 });
      tcp.data.settings.udp = true;
      udp.data.settings.json = JSON.stringify({
        protocol: 'tunnel',
        listen: '127.0.0.1',
        port: tcp.data.settings.port,
        settings: { network: 'udp', address: '127.0.0.1', port: 18881 },
      });
      expect(inboundEndpoints(tcp.data)).toHaveLength(1);
      expect(inboundEndpoints(udp.data)[0]).toMatch(/^udp:/);
      expect(
        diagnoseGraph({
          name: 'QA',
          nodes: [tcp, udp],
          edges: [],
          defaults: factoryDefaults(),
        }).some((i) => i.message.includes('another inbound uses')),
      ).toBe(false);
    }
  });
  it('updates loopback references when an imported real input is renamed', () => {
    const raw = {
        ...wrap({ tag: 'loop', protocol: 'loopback', settings: { inboundTag: 'in' } }),
        routing: { rules: [{ type: 'field', inboundTag: ['in'], outboundTag: 'loop' }] },
      },
      graph = importXrayConfig(JSON.stringify(raw));
    graph.nodes.find((n) => n.data.settings.tag === 'in')!.data.settings.tag = 'renamed';
    expect(
      (compileXrayGraph(graph).config.outbounds as Record<string, unknown>[])[0].settings,
    ).toEqual({ inboundTag: 'renamed' });
  });
  it('detects reinjection loops and accepts an explicit terminating route', () => {
    const config = {
      outbounds: [
        { tag: 'loop', protocol: 'loopback', settings: { inboundTag: 'virtual' } },
        { tag: 'direct', protocol: 'freedom' },
      ],
      routing: { rules: [] as Record<string, unknown>[] },
    };
    expect(loopbackProblems(config)[0].severity).toBe('error');
    config.routing.rules = [{ type: 'field', inboundTag: ['virtual'], outboundTag: 'direct' }];
    expect(loopbackProblems(config)).toEqual([]);
    config.routing.rules = [
      {
        type: 'field',
        inboundTag: ['virtual'],
        domain: ['full:qa.example.invalid'],
        outboundTag: 'direct',
      },
    ];
    expect(loopbackProblems(config)[0].severity).toBe('warning');
  });
  it('maps Hysteria shared bandwidth and hop defaults to the current FinalMask schema', () => {
    const node = makeNode('hysteria-outbound', { x: 0, y: 0 }),
      defaults = factoryDefaults();
    defaults.settings.hysteriaUp = 20;
    defaults.settings.hysteriaDown = 40;
    defaults.settings.hysteriaHopInterval = '10';
    defaults.settings.finalmask = JSON.stringify({
      udp: [
        { type: 'udphop', settings: { mode: 'intervalRemote', remotePorts: '20922', interval: 5 } },
      ],
      quicParams: { brutalUp: '1mbps', future: 7 },
    });
    const resolved = resolveGraph({ name: 'QA', nodes: [node], edges: [], defaults }).nodes[0];
    expect(protocolConfig(resolved.data)).toMatchObject({
      streamSettings: {
        finalmask: {
          quicParams: { brutalUp: '20mbps', brutalDown: '40mbps', congestion: 'brutal', future: 7 },
          udp: [{ type: 'udphop', settings: { interval: '10', remotePorts: '20922' } }],
        },
      },
    });
  });
  it('preserves false and zero through native controls and keeps secret/list field types', () => {
    const field = fieldsForStructure('TunConfig').find((f) => f.key === 'autoSystemDnsToGateway')!;
    expect(editNativeField({ future: 1 }, field, 'false')).toEqual({
      future: 1,
      autoSystemDnsToGateway: false,
    });
    expect(fieldsForStructure('WireGuardConfig').find((f) => f.key === 'secretKey')?.type).toBe(
      'password',
    );
    expect(
      fieldsForStructure('WireGuardConfig').find((f) => f.key === 'reserved')?.jsonShape,
    ).toBeUndefined();
    for (const kind of [...protocolInboundKinds, ...protocolOutboundKinds])
      expect(
        commonKeys(kind).every((k) => getDefinition(kind).fields.some((f) => f.key === k)),
      ).toBe(true);
  });
  for (const kind of protocolInboundKinds.filter((k) => k !== 'tun-inbound' && k !== 'ics-tun'))
    it(`${kind}: ordinary graph compiles all traffic without invented DNS classifiers`, () => {
      const input = makeNode(kind, { x: 0, y: 0 }),
        raw = protocolFixture(specForKind(kind)!);
      delete raw.tag;
      input.data.settings.json = JSON.stringify(raw);
      const output = makeNode('direct-outbound', { x: 300, y: 0 }),
        graph = resolveGraph({
          name: 'QA',
          defaults: factoryDefaults(),
          nodes: [input, output],
          edges: [
            {
              id: 'route',
              source: input.id,
              sourceHandle: 'traffic',
              target: output.id,
              targetHandle: 'in',
            },
          ],
        });
      const config = compileRuntimeGraph(graph).config as {
        routing: { rules: Record<string, unknown>[] };
      };
      expect(config.routing.rules).toHaveLength(1);
      expect(config.routing.rules[0].port).toBeUndefined();
    });
});
describe.skipIf(!core || !dir)('Configured core validation for supported protocols', () => {
  for (const spec of protocolSpecs.filter((s) => isProtocolKind(s.kind)))
    it(`${spec.kind}: Xray accepts graph-generated config`, () => {
      const raw = protocolFixture(spec),
        config =
          spec.direction === 'outbound'
            ? wrap(raw)
            : { inbounds: [raw], outbounds: [{ protocol: 'freedom' }] };
      const exported = compileXrayGraph(importXrayConfig(JSON.stringify(config))).config;
      mkdirSync(dir!, { recursive: true });
      const file = join(dir!, `all-${spec.kind}.json`);
      writeFileSync(file, JSON.stringify(exported, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      writeFileSync(file + '.log', `${result.stdout}\n${result.stderr}`);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
});

it.skipIf(!process.env.WAYRILL_XRAY_SOURCE)(
  'keeps the generated source field catalogue in sync with configured Go structures',
  () => {
    const reference = process.env.WAYRILL_XRAY_SOURCE!;
    for (const [name, spec] of Object.entries(protocolSource)) {
      if (spec.file.includes('+')) continue;
      const source = readFileSync(join(reference, 'infra', 'conf', spec.file), 'utf8');
      const text = new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`).exec(source)![1],
        fields = [...text.matchAll(/json:"([^",]+)(?:,[^"]*)?"/g)].map((m) => m[1]);
      expect(spec.fields.map((f) => f.key)).toEqual(fields);
    }
  },
);
