/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { observedTag } from './tags';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDnsExample } from './example';
import { compileDnsGraph } from './dnsCompilation';
import { policyProfile, policyProfileId } from './policySources';
import { preparedPreview } from '../profiles/preparedPreview';
import { makeNode, makeProxyInbound, getOutputPorts } from './catalog';
import { factoryDefaults } from './defaults';
import { preparedEntry } from './composites';
import { compileRuntimeGraph } from './runtime';
import { diagnoseRuntimeGraph } from './diagnostics';
import { applyStashedProfile } from '../profiles/graph';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import type { GraphState } from './types';

const wire = (source: string, port: string, target: string) => ({
  id: crypto.randomUUID(),
  source,
  sourceHandle: port,
  target,
  targetHandle: 'in',
});
function setup() {
  const input = makeProxyInbound('socks', { x: 0, y: 0 }, 'input');
  input.data.settings.tag = 'client';
  const a = makeNode('socks-outbound', { x: 300, y: 0 }, 'a');
  Object.assign(a.data.settings, { tag: 'a', address: '127.0.0.1', port: 16001 });
  const b = makeNode('socks-outbound', { x: 300, y: 300 }, 'b');
  Object.assign(b.data.settings, { tag: 'b', address: '127.0.0.1', port: 16002 });
  const block = makeNode('block-outbound', { x: 300, y: 600 }, 'block');
  const chain = makeNode('proxy-chain', { x: 600, y: 0 }, 'chain');
  chain.data.settings.tag = 'exit';
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'first', outbound: { type: 'node', nodeId: 'a' } },
      { id: 'last', outbound: { type: 'node', nodeId: 'b' } },
    ],
  });
  const graph: GraphState = {
    name: 'Chain test',
    defaults: factoryDefaults(),
    nodes: [input, a, b, block, chain],
    edges: [wire('input', 'data', 'chain'), wire('input', 'dns', 'block')],
  };
  return { graph, chain, a, b, block, input };
}
const outbound = (config: Record<string, unknown>, tag: string) =>
  (config.outbounds as Record<string, unknown>[]).find((o) => o.tag === tag)!;
const via = (o: Record<string, unknown>) =>
  (o.streamSettings as { sockopt?: { dialerProxy?: string } })?.sockopt?.dialerProxy;
function addGroup(graph: GraphState, refs: string[], id = 'group') {
  const group = makeNode('policy-group', { x: 0, y: 0 }, id);
  group.data.settings.tag = id;
  group.data.settings.sources = JSON.stringify({
    version: 1,
    manual: refs.map((nodeId) => ({ type: 'node', nodeId })),
    subscriptions: [],
  });
  graph.nodes.push(group);
  return group;
}
describe('Interchangeable prepared outbounds', () => {
  it('flattens first-to-last hops without mutating source nodes or losing the public exit tag', () => {
    const { graph, chain, a, b } = setup();
    const before = JSON.stringify(graph);
    const compiled = compileRuntimeGraph(graph).config;
    const exit = outbound(compiled, 'exit');
    expect(exit).toMatchObject({
      protocol: 'socks',
      settings: { address: '127.0.0.1', port: 16002 },
    });
    const entry = outbound(compiled, via(exit)!);
    expect(entry).toMatchObject({ settings: { port: 16001 } });
    expect(via(entry)).toBeUndefined();
    expect(JSON.stringify(graph)).toBe(before);
    expect(getOutputPorts(chain.data.kind, chain.data)).toEqual(['observation']);
    expect(diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.data.settings.dialerProxy).toBe('');
    expect(b.data.settings.dialerProxy).toBe('');
  });
  it('bridges a policy group used as the entry hop and routes reinjection before ordinary rules', () => {
    const { graph, chain } = setup();
    addGroup(graph, ['a'], 'entry-group');
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'first', outbound: { type: 'node', nodeId: 'entry-group' } },
        { id: 'exit', outbound: { type: 'node', nodeId: 'b' } },
      ],
    });
    const config = compileRuntimeGraph(graph).config;
    const bridge = outbound(config, via(outbound(config, 'exit'))!);
    expect(bridge.protocol).toBe('loopback');
    expect((config.routing as { rules: Record<string, unknown>[] }).rules[0]).toMatchObject({
      inboundTag: [(bridge.settings as { inboundTag: string }).inboundTag],
      balancerTag: expect.any(String),
    });
    expect(diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('supports chains and policy groups as manual candidates and fallbacks', () => {
    const { graph, chain } = setup();
    const inner = addGroup(graph, ['a'], 'inner');
    const outer = addGroup(graph, [chain.id, inner.id], 'outer');
    outer.data.settings.fallbackEnabled = true;
    const sources = JSON.parse(String(outer.data.settings.sources));
    sources.fallback = { type: 'node', nodeId: chain.id };
    outer.data.settings.sources = JSON.stringify(sources);
    const observer = makeNode('observatory', { x: 0, y: 0 }, 'observer');
    graph.nodes.push(observer);
    graph.edges.push(wire(outer.id, 'observation', observer.id));
    graph.edges[0] = wire('input', 'data', outer.id);
    const config = compileRuntimeGraph(graph).config;
    const group = (config.routing as { balancers: Record<string, unknown>[] }).balancers.find(
      (g) => g.tag === 'outer',
    )!;
    expect(group.selector).toHaveLength(2);
    expect(group.fallbackTag).toBeTruthy();
    expect(config.observatory).toBeTruthy();
  });
  it('restores saved observation settings when adding a prepared group to a fresh graph', () => {
    const { graph } = setup();
    const group = addGroup(graph, ['a']);
    Object.assign(group.data.settings, { strategy: 'leastPing', observe: true });
    const obs = makeNode('observatory', { x: 0, y: 0 }, 'obs');
    obs.data.settings.probeInterval = '45s';
    graph.nodes.push(obs);
    graph.edges.push(wire(group.id, 'observation', obs.id));
    const entry = preparedEntry(graph, group.id);
    const added = applyStashedProfile(
      { name: 'Fresh', nodes: [], edges: [], defaults: factoryDefaults() },
      entry,
      { x: 0, y: 0 },
    );
    expect(
      added.nodes.find((n) => n.data.kind === 'observatory')?.data.settings.probeInterval,
    ).toBe('45s');
    expect(added.edges).toHaveLength(1);
  });
  it('rejects cycles, missing references, oversized chains, Block relays and external dial-through at the owning card', () => {
    for (const mode of ['cycle', 'missing', 'block', 'dialer', 'too-many']) {
      const { graph, chain, b } = setup();
      const s = JSON.parse(String(chain.data.settings.steps));
      if (mode === 'cycle') s.steps[0].outbound.nodeId = 'chain';
      if (mode === 'missing') s.steps[0].outbound.nodeId = 'missing';
      if (mode === 'block') s.steps[0].outbound.nodeId = 'block';
      if (mode === 'dialer') b.data.settings.dialerProxy = 'a';
      if (mode === 'too-many')
        s.steps = Array.from({ length: 33 }, (_, i) => ({
          id: 'h' + i,
          outbound: { type: 'node', nodeId: 'a' },
        }));
      chain.data.settings.steps = JSON.stringify(s);
      const issues = diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toMatchObject({ nodeId: chain.id, fieldKey: 'steps' });
    }
  });
  it('lets imported native default and explicit destinations become a group or chain, and reimports flattened output faithfully', () => {
    const { graph, chain } = setup();
    const group = addGroup(graph, ['a']);
    const native = importXrayConfig(
      JSON.stringify({
        inbounds: [
          {
            tag: 'client',
            listen: '127.0.0.1',
            port: 18080,
            protocol: 'socks',
            settings: { udp: true },
          },
        ],
        outbounds: [{ tag: 'default', protocol: 'freedom', settings: {} }],
        routing: { rules: [] },
      }),
    );
    const old = native.nodes.find((n) => n.data.settings.tag === 'default')!;
    for (const entry of [preparedEntry(graph, group.id), preparedEntry(graph, chain.id)]) {
      const replaced = applyStashedProfile(native, entry, { x: 0, y: 0 }, old.id);
      const config = compileXrayGraph(replaced).config;
      expect(config.routing).toBeTruthy();
      expect(compileXrayGraph(importXrayConfig(JSON.stringify(config))).config).toEqual(config);
    }
  });

  it('retains fragment inner transports when the fragmented stage uses an earlier hop', () => {
    const { graph, chain } = setup();
    const v = makeNode('vless-outbound', { x: 0, y: 0 }, 'fragmented');
    Object.assign(v.data.settings, {
      tag: 'fragmented',
      address: 'example.net',
      port: 443,
      id: 'ba640cce-3c50-46f5-8406-bf36f35b5c90',
      finalFragmentEnabled: true,
      security: 'tls',
    });
    v.data.overrides = ['finalFragmentEnabled'];
    graph.nodes.push(v);
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'entry', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'last', outbound: { type: 'node', nodeId: v.id } },
      ],
    });
    const config = compileRuntimeGraph(graph).config,
      exit = outbound(config, 'exit'),
      inner = outbound(config, via(exit)!);
    expect(exit.protocol).toBe('freedom');
    expect(inner.protocol).toBe('vless');
    expect(outbound(config, via(inner)!)).toMatchObject({
      protocol: 'socks',
      settings: { port: 16001 },
    });
  });
  it('derives nested observation needs even when an imported chain flag is false', () => {
    const { graph, chain } = setup(),
      group = addGroup(graph, ['b']);
    group.data.settings.strategy = 'leastPing';
    const obs = makeNode('observatory', { x: 0, y: 0 }, 'obs');
    graph.nodes.push(obs);
    graph.edges.push(wire(group.id, 'observation', obs.id));
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'a', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'group', outbound: { type: 'node', nodeId: group.id } },
      ],
    });
    const entry = preparedEntry(graph, chain.id);
    entry.profile!.settings.observe = false;
    const added = applyStashedProfile(graph, entry, { x: 0, y: 0 }, chain.id);
    expect(added.edges.some((e) => e.source === chain.id && e.sourceHandle === 'observation')).toBe(
      true,
    );
    expect(compileRuntimeGraph(added).config.observatory).toBeTruthy();
  });
  it('routes DNS requests through chains in both complete and standalone DNS compilation', () => {
    const { graph: reference, chain } = setup(),
      graph = createDnsExample();
    const entry = preparedEntry(reference, chain.id),
      added = applyStashedProfile(graph, entry, { x: 0, y: 0 });
    const root = added.nodes.find((n) => n.data.kind === 'proxy-chain')!;
    added.edges = added.edges.map((e) =>
      e.source === 'remote-dns' && e.sourceHandle === 'queries' ? { ...e, target: root.id } : e,
    );
    const fragment = compileDnsGraph(added);
    expect(fragment.outbounds.find((o) => o.tag === root.data.settings.tag)).toBeTruthy();
    expect(compileRuntimeGraph(added).config).toBeTruthy();
  });
  it('validates a 5,000-candidate group in a chain without applying the 500 canvas-card limit to compiler nodes', () => {
    const { graph, chain, a } = setup();
    const group = addGroup(graph, []);
    const profile = policyProfile(preparedEntry(graph, a.id));
    group.data.settings.sources = JSON.stringify({
      version: 1,
      manual: Array.from({ length: 5000 }, (_, i) => {
        const p = {
          ...profile.profile,
          settings: { ...profile.profile.settings, address: 'hop' + i + '.example.net' },
        };
        return { ...profile, id: policyProfileId(p), profile: p };
      }),
      subscriptions: [],
    });
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'entry', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'last', outbound: { type: 'node', nodeId: group.id } },
      ],
    });
    const start = performance.now(),
      preview = preparedPreview(graph, chain),
      elapsedMs = performance.now() - start;
    expect((preview.config.outbounds as unknown[]).length).toBeGreaterThan(5000);
    expect(diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
    if (process.env.WAYRILL_COMPOSITE_FIXTURE_DIR) {
      mkdirSync(process.env.WAYRILL_COMPOSITE_FIXTURE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.WAYRILL_COMPOSITE_FIXTURE_DIR, 'large-chain-measurement.json'),
        JSON.stringify({
          candidates: 5000,
          elapsedMs,
          configBytes: new TextEncoder().encode(JSON.stringify(preview.config)).length,
        }),
      );
    }
  }, 30000);
});

it('probes the complete chain through its public route and retains its Observation wire', () => {
  const { graph, chain } = setup();
  const observer = makeNode('observatory', { x: 900, y: 0 }, 'monitor');
  graph.nodes.push(observer);
  graph.edges.push(wire(chain.id, 'observation', observer.id));
  const compiled = compileRuntimeGraph(graph);
  const config = compiled.config;
  const root = outbound(config, 'exit'),
    probe = outbound(config, observedTag('exit'));
  expect(probe).toEqual({ ...root, tag: observedTag('exit') });
  expect(via(probe)).toBeTruthy();
  expect(config.observatory).toMatchObject({ subjectSelector: [observedTag('exit')] });
  expect(compiled.displayNames?.observed).toEqual({ [observedTag('exit')]: 'exit' });
});
