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
import { createRoutingExample } from './example';
import { readRuleTable, tableSettings } from './rules';
import { createPolicyExample } from './policyExample';
import { policyReferenceSet } from './policySources';
import { resetNodeDefaults, resolveGraph } from './defaults';

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
  it.each([false, true])(
    'keeps copied native dial-through and XHTTP download dependencies within the copied set (inherited=%s)',
    (inherited) => {
      const config = nativeLiveFixture('noauth');
      const outputs = config.outbounds as Record<string, unknown>[];
      outputs.push({
        tag: 'dependent',
        protocol: 'socks',
        settings: { address: '127.0.0.1', port: 29081 },
        streamSettings: {
          network: 'xhttp',
          sockopt: { dialerProxy: 'upstream' },
          xhttpSettings: {
            path: '/tunnel',
            headers: { dialerProxy: 'upstream' },
            extra: {
              downloadSettings: {
                address: 'download.example',
                port: 443,
                network: 'raw',
                sockopt: { dialerProxy: 'upstream' },
              },
            },
          },
        },
      });
      let graph = importXrayConfig(JSON.stringify(config));
      if (inherited) {
        graph.defaults!.settings.xhttpExtra = JSON.stringify({
          downloadSettings: {
            address: 'download.example',
            port: 443,
            network: 'raw',
            sockopt: { dialerProxy: 'upstream' },
          },
        });
        const dependent = graph.nodes.find((node) => node.data.settings.tag === 'dependent')!;
        dependent.data = resetNodeDefaults(dependent.data, graph.defaults!, 'xhttpExtra');
        graph = resolveGraph(graph);
        expect(graph.nodes.find((node) => node.id === dependent.id)!.data.overrides).not.toContain(
          'xhttpExtra',
        );
      }
      const group = makeNode('policy-group', { x: 0, y: 0 }, 'same-tag-balancer');
      group.data.settings.tag = 'upstream';
      group.data.settings.sources = JSON.stringify({
        version: 1,
        manual: [
          {
            type: 'node',
            nodeId: graph.nodes.find((node) => node.data.settings.tag === 'upstream')!.id,
          },
        ],
        subscriptions: [],
      });
      graph.nodes.push(group);
      for (const node of graph.nodes)
        node.selected = ['upstream', 'dependent'].includes(String(node.data.settings.tag));
      const before = serializeGraph(graph);
      const next = duplicateSelection(graph);
      const copiedUpstream = next.nodes.find(
        (node) => node.selected && node.data.label === 'upstream',
      )!;
      const copiedDependent = next.nodes.find(
        (node) => node.selected && node.data.label === 'dependent',
      )!;
      const compiled = compileXrayGraph(syncXrayConnections(next)).config;
      const outbounds = compiled.outbounds as Record<string, unknown>[];
      expect(
        outbounds.find((node) => node.tag === copiedDependent.data.settings.tag),
      ).toMatchObject({
        streamSettings: {
          sockopt: { dialerProxy: copiedUpstream.data.settings.tag },
          xhttpSettings: {
            headers: { dialerProxy: 'upstream' },
            extra: {
              downloadSettings: { sockopt: { dialerProxy: copiedUpstream.data.settings.tag } },
            },
          },
        },
      });
      expect(outbounds.find((node) => node.tag === 'dependent')).toEqual(outputs.at(-1));
      expect(compileXrayGraph(parseGraph(serializeGraph(next))).config).toEqual(compiled);
      expect(serializeGraph(graph)).toBe(before);
    },
  );

  it('preserves native prefix queries when copying a group with an overlapping tagged member', () => {
    const graph = createPolicyExample();
    const group = graph.nodes.find((node) => node.data.kind === 'policy-group')!;
    graph.nodes.find((node) => node.data.settings.tag === 'test-b')!.data.settings.tag =
      'test-a-backup';
    Object.assign(group.data.settings, { selection: 'prefixes', selectorPrefixes: 'test-a' });
    group.selected = true;
    graph.nodes.find((node) => node.data.settings.tag === 'test-a')!.selected = true;
    const before = policyReferenceSet(graph, group).map((entry) => entry.reference);
    const next = duplicateSelection(graph);
    const copy = next.nodes.find((node) => node.selected && node.data.kind === 'policy-group')!;
    expect(copy.data.settings.selectorPrefixes).toBe('test-a');
    expect(policyReferenceSet(next, copy).map((entry) => entry.reference)).toEqual(before);
  });

  it('remaps copied traffic-rule sources without altering the original filter or domain text', () => {
    const graph = createRoutingExample();
    const input = graph.nodes.find((node) => node.data.kind === 'proxy-inbound')!;
    const filter = graph.nodes.find((node) => node.data.kind === 'routing-filter')!;
    const table = readRuleTable(filter.data.settings);
    table.rules[0].conditions.inboundTag = String(input.data.settings.tag);
    table.rules[0].conditions.domain = 'full:' + String(input.data.settings.tag);
    Object.assign(filter.data.settings, tableSettings(table));
    input.selected = filter.selected = true;
    const before = serializeGraph(graph);
    const next = duplicateSelection(graph);
    const copiedInput = next.nodes.find(
      (node) => node.selected && node.data.kind === 'proxy-inbound',
    )!;
    const copiedFilter = next.nodes.find(
      (node) => node.selected && node.data.kind === 'routing-filter',
    )!;
    expect(readRuleTable(copiedFilter.data.settings).rules[0].conditions).toMatchObject({
      inboundTag: copiedInput.data.settings.tag,
      domain: table.rules[0].conditions.domain,
    });
    expect(serializeGraph(graph)).toBe(before);
  });

  it('gives a duplicated proxy chain an independent executable tag', () => {
    const { graph, chain } = chainGraph();
    const next = duplicateSelection(graph);
    const copy = next.nodes.find((n) => n.selected)!;
    expect(copy.data.settings.tag).not.toBe(chain.data.settings.tag);
    expect(String(copy.data.settings.tag)).toHaveLength(28);
    expect(readProxyChain(copy.data)).toEqual(readProxyChain(chain.data));
    const compiled = compileRuntimeGraph(next).config;
    const outbounds = compiled.outbounds as Record<string, unknown>[];
    expect(outbounds.filter((o) => o.tag === 'exit')).toHaveLength(1);
    expect(outbounds.filter((o) => o.tag === copy.data.settings.tag)).toHaveLength(1);
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
    const copiedNode = copy.nodes.find((n) => n.selected)!;
    const compiled = compileXrayGraph(syncXrayConnections(copy)).config;
    const out = compiled.outbounds as Record<string, unknown>[];
    expect(copiedNode.data.settings.tag).not.toBe('upstream');
    expect(out.find((o) => o.tag === copiedNode.data.settings.tag)).toEqual({
      ...outputs[0],
      tag: copiedNode.data.settings.tag,
    });
    expect(out.find((o) => o.tag === 'dependent')).toEqual(outputs.at(-1));
    expect(
      (compiled.routing as { rules: { outboundTag: string }[] }).rules.at(-1)?.outboundTag,
    ).toBe('upstream');
    expect(compileXrayGraph(parseGraph(serializeGraph(copy))).config).toEqual(compiled);
    copiedNode.data.native!.original.settings = { fictional: true };
    expect(
      graph.nodes.find((n) => n.data.settings.tag === 'upstream')!.data.native!.original,
    ).toEqual(outputs[0]);
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
