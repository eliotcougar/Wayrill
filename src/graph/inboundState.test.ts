import { describe, expect, it } from 'vitest';
import { getOutputPorts, makeNode, makeProxyInbound } from './catalog';
import { factoryDefaults } from './defaults';
import { parseGraph, serializeGraph, updateGraphNode } from './model';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
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
