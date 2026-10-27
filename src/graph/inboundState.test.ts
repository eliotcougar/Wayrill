import { describe, expect, it } from 'vitest';
import { getOutputPorts, makeNode, makeProxyInbound } from './catalog';
import { factoryDefaults } from './defaults';
import { diagnoseGraph, parseGraph, serializeGraph, updateGraphNode } from './model';
import { diagnoseRuntimeGraph } from './diagnostics';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph, diagnoseXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
import { compileCapturePlan } from './capture';
import { isDisabledInbound } from './inboundState';
import type { GraphState } from './types';

function graph(): GraphState {
  const nodes = [
    makeProxyInbound('mixed', { x: 0, y: 0 }, 'one'),
    makeProxyInbound('http', { x: 0, y: 250 }, 'two'),
    makeNode('direct-outbound', { x: 400, y: 0 }, 'direct'),
  ];
  for (const [i, node] of nodes.slice(0, 2).entries())
    Object.assign(node.data.settings, { tag: node.id, port: 21990 + i });
  return {
    name: 'Inbound activation',
    defaults: factoryDefaults(),
    nodes,
    edges: nodes.slice(0, 2).flatMap((node) =>
      getOutputPorts(node.data.kind, node.data).map((port) => ({
        id: node.id + '-' + port,
        source: node.id,
        sourceHandle: port,
        target: 'direct',
        targetHandle: 'in',
      })),
    ),
  };
}
const native = () =>
  importXrayConfig(
    JSON.stringify({
      inbounds: [
        {
          tag: 'one',
          protocol: 'mixed',
          listen: '127.0.0.1',
          port: 21990,
          settings: { udp: true },
        },
        {
          tag: 'two',
          protocol: 'http',
          listen: '127.0.0.1',
          port: 21991,
          settings: {},
        },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom', settings: {} },
        { tag: 'loop', protocol: 'loopback', settings: { inboundTag: 'one' } },
      ],
      routing: {
        rules: [{ type: 'field', inboundTag: ['one'], outboundTag: 'direct' }],
      },
    }),
  );

describe('individual inbound activation', () => {
  it('saves disabled state, configuration and links, and restores the same runtime when re-enabled', () => {
    const original = graph(),
      config = compileRuntimeGraph(original).config;
    const disabled = updateGraphNode(original, 'one', { enabled: false });
    const saved = parseGraph(serializeGraph(disabled));
    expect(isDisabledInbound(saved.nodes[0].data)).toBe(true);
    expect(saved.nodes[0].data.settings).toEqual(
      parseGraph(serializeGraph(original)).nodes[0].data.settings,
    );
    expect(saved.edges).toEqual(original.edges);
    const compiled = compileRuntimeGraph(saved);
    expect(compiled.config.inbounds).toMatchObject([{ tag: 'two' }]);
    expect(JSON.stringify(compiled.config.routing)).not.toContain('"one"');
    expect(compiled.summary.listeners).toHaveLength(1);
    expect(compileRuntimeGraph(updateGraphNode(saved, 'one', { enabled: true })).config).toEqual(
      config,
    );
    expect(
      JSON.parse(serializeGraph(updateGraphNode(saved, 'one', { enabled: true }))).nodes[0].data,
    ).not.toHaveProperty('enabled');
  });
  it('ignores a disabled inbound listener conflict, invalid fields and disconnected required outputs', () => {
    const g = graph();
    g.nodes[0].data.enabled = false;
    g.nodes[0].data.settings.listen = 'unfinished address';
    g.nodes[0].data.settings.port = 21991;
    g.edges = g.edges.filter((e) => e.source !== 'one');
    expect(diagnoseGraph(g).filter((p) => p.severity === 'error')).toEqual([]);
    expect(diagnoseRuntimeGraph(g).filter((p) => p.severity === 'error')).toEqual([]);
    expect(compileRuntimeGraph(g).summary.listeners).toHaveLength(1);
    g.nodes[0].data.enabled = true;
    expect(diagnoseRuntimeGraph(g).some((p) => p.nodeId === 'one' && p.severity === 'error')).toBe(
      true,
    );
  });
  it('does not silently disable other node types or accept malformed activation flags', () => {
    for (const value of ['false', 0, null]) {
      const raw = JSON.parse(serializeGraph(graph()));
      raw.nodes[0].data.enabled = value;
      expect(() => parseGraph(JSON.stringify(raw))).toThrow(/boolean enabled state/);
    }
    const raw = JSON.parse(serializeGraph(graph()));
    raw.nodes[2].data.enabled = false;
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/Only inbounds/);
  });
  it('excludes disabled TUN and WinDivert nodes from the runtime and capture plan', () => {
    const g = graph();
    for (const kind of ['tun-inbound', 'windivert-inbound'] as const) {
      const node = makeNode(kind, { x: 0, y: 500 }, kind);
      node.data.enabled = false;
      g.nodes.push(node);
    }
    expect(compileCapturePlan(g)).toBeUndefined();
    const compiled = compileRuntimeGraph(g);
    expect(compiled.capture).toBeUndefined();
    expect(compiled.config.inbounds).toHaveLength(2);
    expect(diagnoseRuntimeGraph(g).filter((p) => p.severity === 'error')).toEqual([]);
  });
  it('exports only enabled native inputs and keeps virtual redispatch tag renames intact', () => {
    const g = native(),
      before = compileXrayGraph(g).config,
      input = g.nodes.find((n) => n.data.settings.tag === 'one')!;
    const disabled = updateGraphNode(g, input.id, { enabled: false });
    const config = compileXrayGraph(disabled).config;
    expect(config.inbounds).toMatchObject([{ tag: 'two' }]);
    expect(config.routing).toEqual(before.routing);
    expect(config.outbounds).toEqual(before.outbounds);
    expect(config).not.toHaveProperty('enabled');
    const renamed = updateGraphNode(disabled, input.id, {
      settings: { ...input.data.settings, tag: 'renamed' },
    });
    expect(compileXrayGraph(renamed).config.outbounds).toContainEqual({
      tag: 'loop',
      protocol: 'loopback',
      settings: { inboundTag: 'renamed' },
    });
    expect(compileXrayGraph(updateGraphNode(disabled, input.id, { enabled: true })).config).toEqual(
      before,
    );
  });
  it('excludes disabled native inputs from collision and missing-path checks', () => {
    const g = native(),
      input = g.nodes.find((n) => n.data.settings.tag === 'one')!;
    input.data.enabled = false;
    input.data.settings.port = 21991;
    g.edges = g.edges.filter((e) => e.source !== input.id);
    expect(diagnoseXrayGraph(g).filter((p) => p.severity === 'error')).toEqual([]);
    expect(compileXrayGraph(g).config.inbounds).toHaveLength(1);
  });
  it('requires an enabled traffic source for activation when every input is disabled', () => {
    for (const g of [graph(), native()]) {
      for (const node of g.nodes) if (node.data.kind.endsWith('inbound')) node.data.enabled = false;
      expect(() => compileRuntimeGraph(g)).toThrow(/Enable at least one/);
      expect(diagnoseRuntimeGraph(g)).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          message: expect.stringMatching(/Enable at least one/),
        }),
      );
      expect(parseGraph(serializeGraph(g)).nodes).toHaveLength(g.nodes.length);
    }
  });
});

it('retains explicit sharing-off intent after disabled ICS nodes are removed from execution', () => {
  const g = graph();
  const shared = makeNode('ics-tun', { x: 0, y: 500 }, 'sharing');
  shared.data.enabled = false;
  g.nodes.push(shared);
  const compiled = compileRuntimeGraph(g);
  expect(compiled.capture).toMatchObject({ version: 2, sharingDisabled: true, inputs: [] });
  expect(compiled.capture).not.toHaveProperty('tunSharing');
  expect(compiled.config.inbounds).toHaveLength(2);
  expect(JSON.stringify(compiled.config)).not.toContain('sharingDisabled');
  const restored = compileRuntimeGraph(parseGraph(serializeGraph(g)));
  expect(restored.capture).toEqual(compiled.capture);
});
