/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { generatedTag, observedTag } from './tags';
import { makeNode } from './catalog';
import { compileRuntimeGraph } from './runtime';
import { diagnoseRuntimeGraph } from './diagnostics';
import { parseGraph, serializeGraph } from './model';
import { editPolicyGraph } from './policies';
import { readPolicySources } from './policySources';
import { createPolicyExample } from './policyExample';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';

const group = (graph: ReturnType<typeof createPolicyExample>) =>
  graph.nodes.find((n) => n.data.kind === 'policy-group')!;
const observer = (graph: ReturnType<typeof createPolicyExample>) =>
  graph.nodes.find((n) => n.data.kind === 'observatory')!;
const wire = (source: string, sourceHandle: string, target: string) => ({
  id: crypto.randomUUID(),
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});
const balance = (config: Record<string, unknown>) =>
  (config.routing as { balancers: Record<string, unknown>[] }).balancers[0];

const setManual = (graph: ReturnType<typeof createPolicyExample>, ids: string[]) => {
  const node = group(graph),
    sources = structuredClone(readPolicySources(node.data));
  sources.manual = ids.map((nodeId) => ({ type: 'node', nodeId }));
  node.data.settings.sources = JSON.stringify(sources);
};
describe('Policy-group compilation and graph editing', () => {
  for (const strategy of ['random', 'roundRobin', 'leastPing', 'leastLoad'])
    it(`compiles ${strategy} and preserves routing order`, () => {
      const graph = createPolicyExample(strategy, strategy === 'leastLoad' ? 'burst' : 'standard');
      const result = compileRuntimeGraph(graph),
        routing = result.config.routing as { rules: Record<string, unknown>[] };
      expect(balance(result.config)).toMatchObject({
        tag: 'policy-group',
        selector: ['test-a', 'test-b'],
        strategy: { type: strategy },
        fallbackTag: 'block',
      });
      expect(routing.rules.map((r) => r.balancerTag ?? r.outboundTag)).toEqual([
        'block',
        'policy-group',
      ]);
      expect(result.config.outbounds).toHaveLength(4);
      expect(
        result.config[strategy === 'leastLoad' ? 'burstObservatory' : 'observatory'],
      ).toMatchObject({ subjectSelector: ['test-a', 'test-b'] });
      expect(diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error')).toEqual([]);
    });
  it('shares one observer across groups and includes all subjects', () => {
    const graph = createPolicyExample('leastPing'),
      second = makeNode('policy-group', { x: 0, y: 0 }, 'second');
    Object.assign(second.data.settings, { tag: 'second', strategy: 'leastLoad' });
    graph.nodes.push(second);
    second.data.settings.sources = JSON.stringify({
      version: 1,
      manual: [{ type: 'node', nodeId: 'test-block' }],
      subscriptions: [],
    });
    graph.edges.push(wire('second', 'observation', observer(graph).id));
    expect(compileRuntimeGraph(graph).config.observatory).toMatchObject({
      subjectSelector: ['test-a', 'test-b', 'block'],
    });
  });
  it('rejects observation selectors that omit a candidate', () => {
    const graph = createPolicyExample('leastPing');
    Object.assign(observer(graph).data.settings, {
      subjects: 'prefixes',
      selectorPrefixes: 'test-a',
    });
    expect(() => compileRuntimeGraph(graph)).toThrow(/omit/);
  });
  it('allows an empty native-prefix group with an explicit fallback', () => {
    const graph = createPolicyExample('leastPing');
    Object.assign(group(graph).data.settings, {
      selection: 'prefixes',
      selectorPrefixes: 'missing-',
    });
    expect(balance(compileRuntimeGraph(graph).config)).toMatchObject({
      selector: ['missing-'],
      fallbackTag: 'block',
    });
    group(graph).data.settings.fallbackEnabled = false;
    graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'fallback');
    expect(() => compileRuntimeGraph(graph)).toThrow(/No outbound/);
  });
  it('aliases overlapping tag prefixes without changing credentials or fallback', () => {
    const graph = createPolicyExample();
    graph.nodes.find((n) => n.id === 'test-second')!.data.settings.tag = 'test-a-extra';
    setManual(graph, ['test-first']);
    const result = compileRuntimeGraph(graph),
      balancer = balance(result.config),
      outbounds = result.config.outbounds as Record<string, unknown>[];
    expect(balancer.selector).toEqual([generatedTag('wpm', 'test-first')]);
    expect(outbounds.find((o) => o.tag === generatedTag('wpm', 'test-first'))).toMatchObject({
      protocol: 'freedom',
      settings: { redirect: '127.0.0.1:18881' },
    });
    expect(balancer.fallbackTag).toBe('block');
  });
  it('preserves substring and automatic weights when aliasing', () => {
    const graph = createPolicyExample('leastLoad', 'burst');
    graph.nodes.find((n) => n.id === 'test-second')!.data.settings.tag = 'test-a-extra';
    setManual(graph, ['test-first']);
    group(graph).data.settings.costs = '[{"match":"test-a","regexp":false,"value":4}]';
    expect(balance(compileRuntimeGraph(graph).config)).toMatchObject({
      strategy: {
        settings: {
          costs: [
            { match: `^${generatedTag('wpm', 'test-first')}$`, regexp: true, value: 4 },
            { match: 'test-a', regexp: false, value: 4 },
          ],
        },
      },
    });
    group(graph).data.settings.costs = '[{"match":"test-a","regexp":true,"value":4}]';
    expect(() => compileRuntimeGraph(graph)).toThrow(/regular-expression weights/);
  });
  it('applies a new shared observer and connections atomically, with undo', () => {
    const graph = createPolicyExample();
    graph.nodes = graph.nodes.filter((n) => n.data.kind !== 'observatory');
    graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'observation');
    const node = group(graph),
      newObserver = makeNode('observatory', { x: 0, y: 0 }, 'new-observer');
    const next = editPolicyGraph(
      graph,
      node.id,
      { ...node.data.settings, strategy: 'leastPing' },
      newObserver.id,
      newObserver,
    );
    expect(compileRuntimeGraph(next).config).toHaveProperty('observatory');
    const history = commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: next });
    expect(undoWorkspaceHistory(history).present.graph).toEqual(graph);
    expect(parseGraph(serializeGraph(next)).nodes).toHaveLength(6);
  });
});

it('merges separate compatible observatories and rejects conflicting probe settings', () => {
  const graph = createPolicyExample();
  const second = structuredClone(observer(graph));
  second.id = 'second-monitor';
  graph.nodes.push(second);
  graph.edges.push(wire('test-first', 'observation', second.id));
  expect(
    (compileRuntimeGraph(graph).config.observatory as { subjectSelector: string[] })
      .subjectSelector,
  ).toContain(observedTag('test-a'));
  second.data.settings.probeURL = 'https://different.example/test';
  expect(() => compileRuntimeGraph(graph)).toThrow('one observation provider');
});
