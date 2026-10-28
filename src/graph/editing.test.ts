import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { duplicateSelection } from './editing';
import { nativeLiveFixture } from './nativeLiveFixture';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph, syncXrayConnections } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';
import { readProxyChain } from './proxyChains';
import { compileRuntimeGraph } from './runtime';
import type { GraphState } from './types';

function chainGraph() {
  const graph = importXrayConfig(JSON.stringify(nativeLiveFixture('noauth')));
  const first = graph.nodes.find((n) => n.data.settings.tag === 'upstream')!;
  const last = makeNode('socks-outbound', { x: 0, y: 0 }, 'last');
  Object.assign(last.data.settings, { tag: 'last', address: '127.0.0.1', port: 20924 });
  const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
  chain.data.settings.tag = 'exit';
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'first', outbound: { type: 'node', nodeId: first.id } },
      { id: 'last', outbound: { type: 'node', nodeId: last.id } },
    ],
  });
  graph.nodes.push(last, chain);
  chain.selected = true;
  return { graph, first, last, chain };
}

describe('independent node copies', () => {
  it('gives a duplicated proxy chain an independent executable tag', () => {
    const { graph, chain } = chainGraph();
    const next = duplicateSelection(graph);
    const copy = next.nodes.find((n) => n.selected)!;
    expect(copy.data.settings.tag).toBe('exit-2');
    expect(readProxyChain(copy.data)).toEqual(readProxyChain(chain.data));
    const compiled = compileRuntimeGraph(next).config;
    const outbounds = compiled.outbounds as Record<string, unknown>[];
    expect(outbounds.filter((o) => o.tag === 'exit')).toHaveLength(1);
    expect(outbounds.filter((o) => o.tag === 'exit-2')).toHaveLength(1);
  });
  it('rewires copied chain hops to copied nodes while retaining unselected dependencies', () => {
    const { graph, first, last, chain } = chainGraph();
    first.selected = true;
    const before = serializeGraph(graph);
    const next = duplicateSelection(graph);
    const copiedChain = next.nodes.find((n) => n.selected && n.data.kind === 'proxy-chain')!;
    const copiedFirst = next.nodes.find((n) => n.selected && n.data.kind !== 'proxy-chain')!;
    expect(readProxyChain(copiedChain.data).steps.map((s) => s.outbound)).toEqual([
      { type: 'node', nodeId: copiedFirst.id },
      { type: 'node', nodeId: last.id },
    ]);
    copiedFirst.data.settings.port = 20925;
    const compiled = compileRuntimeGraph(parseGraph(serializeGraph(next))).config;
    const outbounds = compiled.outbounds as Record<string, unknown>[];
    const relayFor = (tag: string) => {
      const exit = outbounds.find((o) => o.tag === tag)!;
      const relay = (exit.streamSettings as { sockopt: { dialerProxy: string } }).sockopt
        .dialerProxy;
      return outbounds.find((o) => o.tag === relay)!.settings;
    };
    expect(relayFor(String(copiedChain.data.settings.tag))).toMatchObject({ port: 20925 });
    expect(relayFor(String(chain.data.settings.tag))).toMatchObject({ port: 20922 });
    expect(serializeGraph(graph)).toBe(before);
  });
  it('preserves native omissions and extensions without redirecting original references', () => {
    const config = nativeLiveFixture('noauth');
    const outputs = config.outbounds as Record<string, unknown>[];
    outputs[0].streamSettings = {
      network: 'raw',
      sockopt: { tcpNoDelay: false, tcpKeepAliveIdle: 0 },
    };
    outputs[0].settings = { ...(outputs[0].settings as object), email: '', level: 0 };
    outputs.push({
      tag: 'dependent',
      protocol: 'freedom',
      streamSettings: { sockopt: { dialerProxy: 'upstream' } },
    });
    const graph = importXrayConfig(JSON.stringify(config));
    graph.nodes.find((n) => n.data.settings.tag === 'upstream')!.selected = true;
    const copy = duplicateSelection(graph);
    const compiled = compileXrayGraph(syncXrayConnections(copy)).config;
    const out = compiled.outbounds as Record<string, unknown>[];
    expect(out.find((o) => o.tag === 'upstream-2')).toEqual({ ...outputs[0], tag: 'upstream-2' });
    expect(out.find((o) => o.tag === 'dependent')).toEqual(outputs.at(-1));
    expect(
      (compiled.routing as { rules: { outboundTag: string }[] }).rules.at(-1)?.outboundTag,
    ).toBe('upstream');
    expect(compileXrayGraph(parseGraph(serializeGraph(copy))).config).toEqual(compiled);
    const copiedNode = copy.nodes.find((n) => n.data.settings.tag === 'upstream-2')!;
    copiedNode.data.native!.original.settings = { fictional: true };
    expect(
      graph.nodes.find((n) => n.data.settings.tag === 'upstream')!.data.native!.original,
    ).toEqual(outputs[0]);
  });
  it('copies endpoint nodes while retaining one shared global configuration', () => {
    const graph = importXrayConfig(JSON.stringify(nativeLiveFixture('noauth')));
    graph.nodes.forEach((n) => {
      n.selected = true;
    });
    const next = duplicateSelection(graph);
    for (const kind of ['xray-options', 'routing-filter', 'xray-dns']) {
      expect(next.nodes.filter((n) => n.data.kind === kind)).toHaveLength(1);
    }
    expect(next.nodes.filter((n) => n.data.settings.tag === 'upstream-2')).toHaveLength(1);
  });
  it('does not leave renderer state or shared override arrays on a copy', () => {
    const node = makeNode('socks-outbound', { x: 0, y: 0 }, 'original');
    node.selected = true;
    node.dragging = true;
    node.measured = { width: 200, height: 100 };
    const graph: GraphState = { name: 'copy', nodes: [node], edges: [] };
    const copy = duplicateSelection(graph).nodes[1];
    expect(copy.dragging).toBeUndefined();
    expect(copy.measured).toBeUndefined();
    copy.data.overrides!.push('fingerprint');
    expect(node.data.overrides).toEqual([]);
  });
  it('rejects excessive duplication before modifying the graph', () => {
    const graph: GraphState = {
      name: 'limit',
      nodes: Array.from({ length: 500 }, (_, i) =>
        makeNode('block-outbound', { x: 0, y: 0 }, `n-${i}`),
      ),
      edges: [],
    };
    graph.nodes[0].selected = true;
    expect(() => duplicateSelection(graph)).toThrow(/at most 500/);
    expect(graph.nodes).toHaveLength(500);
  });
});
