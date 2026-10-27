import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { duplicateSelection } from './editing';
import { nativeLiveFixture } from './nativeLiveFixture';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph, syncXrayConnections } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';
import type { GraphState } from './types';

describe('independent node copies', () => {
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
