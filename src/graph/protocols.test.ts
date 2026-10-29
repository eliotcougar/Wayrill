/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeNode, makeProxyInbound } from './catalog';
import { applyDefaults, factoryDefaults, resetNodeDefaults } from './defaults';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { diagnoseRuntimeGraph } from './diagnostics';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import {
  loopbackProblems,
  protocolConfig,
  protocolInboundKinds,
  protocolOutboundKinds,
  specForKind,
} from './protocols';
import { fieldsForStructure, structureProblems } from './protocolFields';
import { protocolSource } from './protocolSource';
import { fixtureId, protocolFixture } from './protocolFixtures';
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
