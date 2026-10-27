/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNode, makeProxyInbound } from './catalog';
import { compileRuntimeGraph } from './runtime';
import { compileDnsGraph } from './dnsCompilation';
import { diagnoseRuntimeGraph } from './diagnostics';
import { connectionProblem, parseGraph, serializeGraph } from './model';
import { importXrayConfig } from './xrayImport';
import { editPolicyGraph, policyProblems } from './policies';
import { policyCandidates, readPolicySources } from './policySources';
import { getDefinition, getOutputPorts } from './catalog';
import { isOutboundKind, isExecutableOutboundKind } from './outbounds';
import { createPolicyExample } from './policyExample';
import { createDnsExample, createTrafficExample } from './example';
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
const setFallback = (graph: ReturnType<typeof createPolicyExample>, nodeId: string) => {
  const node = group(graph),
    sources = structuredClone(readPolicySources(node.data));
  sources.fallback = { type: 'node', nodeId };
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
  it('leaves observations optional for random and round robin', () => {
    const graph = createPolicyExample();
    Object.assign(group(graph).data.settings, { observe: false, fallbackEnabled: false });
    graph.nodes = graph.nodes.filter((n) => n.data.kind !== 'observatory');
    graph.edges = graph.edges.filter(
      (e) => !['observation', 'fallback'].includes(e.sourceHandle ?? ''),
    );
    expect(compileRuntimeGraph(graph).config).not.toHaveProperty('observatory');
  });
  it('requires observation for random and round robin with fallback', () => {
    for (const strategy of ['random', 'roundRobin']) {
      const graph = createPolicyExample(strategy);
      group(graph).data.settings.observe = false;
      graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'observation');
      expect(() => compileRuntimeGraph(graph)).toThrow(/connect Observatory/);
    }
  });
  it('reports every missing group path at its node', () => {
    const graph = createPolicyExample('leastPing');
    graph.edges = graph.edges.filter((e) => e.source !== group(graph).id);
    const issues = diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error');
    expect(issues.filter((i) => i.nodeId === group(graph).id)).toHaveLength(1);
    expect(() => compileRuntimeGraph(graph)).toThrow(/connect/i);
  });
  it('diagnoses invalid nested groups and typed observation mistakes', () => {
    const graph = createPolicyExample(),
      second = makeNode('policy-group', { x: 0, y: 0 }, 'other-group');
    graph.nodes.push(second);
    setManual(graph, [second.id]);
    expect(() => compileRuntimeGraph(graph)).toThrow(/another policy group|No outbound/);
    expect(
      connectionProblem({ ...graph, edges: [] }, wire(group(graph).id, 'first', second.id)),
    ).toMatch(/output port/i);
    expect(
      connectionProblem(
        { ...graph, edges: [] },
        wire(group(graph).id, 'observation', 'test-first'),
      ),
    ).toMatch(/Observation/);
    expect(
      connectionProblem({ ...graph, edges: [] }, wire('policy-input', 'data', observer(graph).id)),
    ).toMatch(/observation connections/);
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
  it('allows inactive separate observatories but rejects duplicate balancer tags', () => {
    const graph = createPolicyExample();
    graph.nodes.push(
      makeNode('observatory', { x: 0, y: 0 }, 'observer2'),
      makeNode('policy-group', { x: 0, y: 0 }, 'group2'),
    );
    const issues = diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'error');
    expect(issues.some((i) => i.nodeId === 'observer2')).toBe(false);
    expect(issues.some((i) => i.nodeId === 'group2' && i.fieldKey === 'tag')).toBe(true);
  });
  it('rejects observation selectors that omit a candidate', () => {
    const graph = createPolicyExample('leastPing');
    Object.assign(observer(graph).data.settings, {
      subjects: 'prefixes',
      selectorPrefixes: 'test-a',
    });
    expect(() => compileRuntimeGraph(graph)).toThrow(/omit/);
  });
  it('treats groups as outbounds with one optional observation port and follows native prefixes without wires', () => {
    const graph = createPolicyExample();
    expect(isOutboundKind('policy-group')).toBe(true);
    expect(isExecutableOutboundKind('policy-group')).toBe(false);
    expect(getDefinition('policy-group')).toMatchObject({
      group: 'Outbounds',
      category: 'outbound',
    });
    expect(getOutputPorts('policy-group', group(graph).data)).toEqual(['observation']);
    Object.assign(group(graph).data.settings, { selection: 'prefixes', selectorPrefixes: 'test-' });
    expect(policyCandidates(graph, group(graph)).map((c) => c.node.id)).toEqual([
      'test-first',
      'test-second',
    ]);
    expect(graph.edges.filter((e) => e.source === group(graph).id)).toHaveLength(1);
    expect(balance(compileRuntimeGraph(parseGraph(serializeGraph(graph))).config).selector).toEqual(
      ['test-'],
    );
    graph.nodes.find((n) => n.id === 'test-second')!.data.settings.tag = 'other';
    expect(policyCandidates(graph, group(graph)).map((c) => c.node.id)).toEqual(['test-first']);
    expect(balance(compileRuntimeGraph(graph).config).selector).toEqual(['test-']);
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
  it('reports broken internal candidate and fallback references at the group', () => {
    const graph = createPolicyExample();
    setManual(graph, ['gone']);
    const issues = diagnoseRuntimeGraph(graph);
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: group(graph).id,
        fieldKey: 'sources',
        severity: 'error',
        message: expect.stringMatching(/missing/),
      }),
    );
    setManual(graph, ['test-first']);
    setFallback(graph, 'gone');
    expect(() => compileRuntimeGraph(graph)).toThrow(/missing/);
  });
  it('aliases overlapping tag prefixes without changing credentials or fallback', () => {
    const graph = createPolicyExample();
    graph.nodes.find((n) => n.id === 'test-second')!.data.settings.tag = 'test-a-extra';
    setManual(graph, ['test-first']);
    const result = compileRuntimeGraph(graph),
      balancer = balance(result.config),
      outbounds = result.config.outbounds as Record<string, unknown>[];
    expect(balancer.selector).toEqual(['wayrill-policy-member-10-test-first']);
    expect(outbounds.find((o) => o.tag === 'wayrill-policy-member-10-test-first')).toMatchObject({
      protocol: 'freedom',
      settings: { redirect: '127.0.0.1:18881' },
    });
    expect(balancer.fallbackTag).toBe('block');
  });
  it('keeps fragment inner transports out of aliased candidate selection', () => {
    const graph = createPolicyExample(),
      node = makeNode('vless-outbound', { x: 0, y: 0 }, 'vless-candidate');
    Object.assign(node.data.settings, {
      tag: 'test-a',
      address: 'server.example.net',
      id: 'test-only',
      finalFragmentEnabled: true,
    });
    graph.nodes = graph.nodes.filter((n) => n.id !== 'test-first');
    graph.nodes.push(node);
    node.data.overrides = ['finalFragmentEnabled'];
    graph.nodes.find((n) => n.id === 'test-second')!.data.settings.tag = 'test-a-extra';
    setManual(graph, [node.id]);
    graph.edges.push(wire(node.id, 'observation', observer(graph).id));
    const result = compileRuntimeGraph(graph),
      selected = String((balance(result.config).selector as string[])[0]),
      all = result.config.outbounds as Record<string, unknown>[];
    expect(new Set(all.map((o) => o.tag)).size).toBe(all.length);
    expect(all.find((o) => o.tag === 'wayrill-observed-test-a')).toMatchObject({
      streamSettings: {
        sockopt: { dialerProxy: 'wayrill-monitor-inner-vless-candidate-0' },
      },
    });
    expect(all.filter((o) => String(o.tag).startsWith(selected))).toHaveLength(1);
    expect(all.find((o) => o.tag === selected)).toMatchObject({
      streamSettings: { sockopt: { dialerProxy: 'wayrill-policy-inner-vless-candidate-0' } },
    });
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
            { match: '^wayrill-policy-member-10-test-first$', regexp: true, value: 4 },
            { match: 'test-a', regexp: false, value: 4 },
          ],
        },
      },
    });
    group(graph).data.settings.costs = '[{"match":"test-a","regexp":true,"value":4}]';
    expect(() => compileRuntimeGraph(graph)).toThrow(/regular-expression weights/);
  });
  it('keeps generated aliases prefix-free for related node IDs', () => {
    const graph = createPolicyExample(),
      first = graph.nodes.find((n) => n.id === 'test-first')!,
      second = graph.nodes.find((n) => n.id === 'test-second')!;
    second.id = 'test-first-member-other';
    second.data.settings.tag = 'test-b';
    setManual(graph, [first.id, second.id]);
    for (const [id, tag] of [
      ['extra-a', 'test-a-other'],
      ['extra-b', 'test-b-other'],
    ]) {
      const n = makeNode('block-outbound', { x: 0, y: 0 }, id);
      n.data.settings.tag = tag;
      graph.nodes.push(n);
    }
    const result = compileRuntimeGraph(graph),
      selectors = balance(result.config).selector as string[],
      all = result.config.outbounds as Record<string, unknown>[];
    expect(selectors).toHaveLength(2);
    for (const prefix of selectors)
      expect(all.filter((o) => String(o.tag).startsWith(prefix))).toHaveLength(1);
  });
  it('guards generated alias collisions', () => {
    const graph = createPolicyExample();
    const other = makeNode('direct-outbound', { x: 0, y: 0 }, 'reserved');
    other.data.settings.tag = 'wayrill-policy-member-10-test-first';
    graph.nodes.push(other);
    expect(() => compileRuntimeGraph(graph)).toThrow(/reserved/);
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
  it('routes DNS server query traffic through policy groups but keeps dial-through ports typed', () => {
    const graph = createDnsExample(),
      policy = makeNode('policy-group', { x: 0, y: 0 }, 'dns-policy');
    graph.nodes.push(policy);
    graph.edges.find((e) => e.id === 'remote-query')!.target = policy.id;
    policy.data.settings.sources = JSON.stringify({
      version: 1,
      manual: [{ type: 'node', nodeId: 'direct' }],
      subscriptions: [],
    });
    const fragment = compileDnsGraph(graph);
    expect(fragment.routing.rules.filter((r) => r.balancerTag === 'policy-group')).toHaveLength(2);
    expect(fragment.routing.balancers).toHaveLength(1);
    const data = graph.nodes.find((n) => n.id === 'dns')!.data;
    expect(connectionProblem({ ...graph, edges: [] }, wire('dns', 'resolver', policy.id))).toMatch(
      /resolver/,
    );
    data.settings.policyDefault = 'forward';
    expect(connectionProblem({ ...graph, edges: [] }, wire('dns', 'forward', policy.id))).toMatch(
      /outbound/,
    );
    data.settings.policyDefault = 'return';
    expect(compileRuntimeGraph(graph).config.routing).toHaveProperty('balancers');
  });
  it('retains ordinary graphs without added policy sections', () => {
    expect(compileRuntimeGraph(createTrafficExample()).config).not.toHaveProperty('observatory');
  });
  for (const [key, value] of [
    ['maxRTT', '-1s'],
    ['maxRTT', '1e8s'],
    ['maxRTT', '999999999999h'],
    ['tolerance', '1.1'],
    ['baselines', '0s'],
    ['costs', '[{"match":"test","regexp":false,"value":-1}]'],
  ])
    it(`rejects invalid least-load ${key}=${value}`, () => {
      const data = group(createPolicyExample('leastLoad')).data;
      data.settings[key] = value;
      expect(policyProblems(data).some((i) => i.severity === 'error' && i.fieldKey === key)).toBe(
        true,
      );
    });
  for (const [key, value] of [
    ['probeURL', 'file:///etc/test'],
    ['probeURL', 'https://user:pass@example.net'],
    ['probeInterval', '0s'],
  ])
    it(`rejects invalid probe ${key}`, () => {
      const data = observer(createPolicyExample()).data;
      data.settings[key] = value;
      expect(policyProblems(data).some((i) => i.severity === 'error' && i.fieldKey === key)).toBe(
        true,
      );
    });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !dir)('Pinned Xray policy-group compatibility', () => {
  for (const strategy of ['random', 'roundRobin', 'leastPing', 'leastLoad'])
    for (const mode of ['standard', 'burst'])
      it(`${strategy}-${mode}`, () => {
        const graph = createPolicyExample(strategy, mode);
        if (strategy === 'leastLoad')
          Object.assign(group(graph).data.settings, {
            expected: 0,
            maxRTT: '5s',
            tolerance: '0.2',
            baselines: '100ms\n1s',
            costs: '[{"match":"test-a","regexp":false,"value":2}]',
          });
        const http = makeProxyInbound('http', { x: 0, y: 0 }, 'qa-http');
        Object.assign(http.data.settings, { tag: 'qa-http', port: 2081 });
        graph.nodes.push(http);
        graph.edges.push(
          wire(http.id, 'data', group(graph).id),
          wire(http.id, 'dns', 'test-block'),
        );
        const fallback = makeNode('direct-outbound', { x: 0, y: 0 }, 'qa-fallback');
        Object.assign(fallback.data.settings, {
          tag: 'test-fallback',
          redirect: '127.0.0.1:18883',
        });
        graph.nodes.push(fallback);
        setFallback(graph, fallback.id);
        const config = compileRuntimeGraph(graph).config;
        mkdirSync(dir!, { recursive: true });
        const name = `policy-${strategy}-${mode}`,
          path = join(dir!, `${name}.json`);
        writeFileSync(path, JSON.stringify(config, null, 2));
        const r = spawnSync(core!, ['run', '-test', '-config', path], {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        writeFileSync(join(dir!, `${name}.log`), `${r.stdout}\n${r.stderr}`);
        expect(r.error).toBeUndefined();
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      });
});

it('observes only a connected plain path even when another tag shares its prefix', () => {
  const graph = createPolicyExample();
  const first = graph.nodes.find((n) => n.id === 'test-first')!;
  const other = makeNode('direct-outbound', { x: 0, y: 0 }, 'similar');
  other.data.settings.tag = `${first.data.settings.tag}-other`;
  graph.nodes.push(other);
  expect(connectionProblem(graph, wire(first.id, 'observation', observer(graph).id))).toBeNull();
  graph.edges.push(wire(first.id, 'observation', observer(graph).id));
  const config = compileRuntimeGraph(graph).config;
  const subjects = (config.observatory as { subjectSelector: string[] }).subjectSelector;
  expect(subjects).toContain(`wayrill-observed-${first.data.settings.tag}`);
  expect(subjects).not.toContain(other.data.settings.tag);
  const aliases = (config.outbounds as Record<string, unknown>[]).filter((o) =>
    String(o.tag).startsWith('wayrill-observed-'),
  );
  expect(aliases).toHaveLength(1);
  expect(aliases[0].protocol).toBe('freedom');
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
  ).toContain('wayrill-observed-test-a');
  second.data.settings.probeURL = 'https://different.example/test';
  expect(() => compileRuntimeGraph(graph)).toThrow('one observation provider');
});

it('keeps an active separate native observer when the first canvas observer is inactive', () => {
  const graph = importXrayConfig(
    JSON.stringify({
      inbounds: [{ tag: 'input', protocol: 'socks', listen: '127.0.0.1', port: 1080 }],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }),
  );
  const idle = makeNode('observatory', { x: 0, y: 0 }, 'idle');
  const active = makeNode('observatory', { x: 0, y: 0 }, 'active');
  active.data.settings.mode = 'burst';
  const direct = graph.nodes.find((n) => n.data.settings.tag === 'direct')!;
  graph.nodes.push(idle, active);
  graph.edges.push(wire(direct.id, 'observation', active.id));
  const config = compileRuntimeGraph(graph).config;
  expect(config.observatory).toBeUndefined();
  expect(config.burstObservatory).toMatchObject({ subjectSelector: ['wayrill-observed-direct'] });
});
