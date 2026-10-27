import { describe, it, expect } from 'vitest';
import { createTestPlan, mergeTestPlans, testIdentity, stashTestKey } from './outboundTestPlan';
import { makeNode } from './graph/catalog';
import { factoryDefaults } from './graph/defaults';
import { createPolicyExample } from './graph/policyExample';
import { createDnsExample } from './graph/example';
import { preparedEntry } from './graph/composites';
import { policyProfile } from './graph/policySources';
import { defaultGroup } from './profiles/stashModel';
import { importProfiles, type Stash, type StashEntry } from './profiles/import';
import type { GraphState } from './graph/types';
const empty: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
it('retains visible rows when a later Stash test provides their hidden canvas alias', () => {
  const previous = {
    rows: [
      {
        key: 'node:one',
        name: 'One',
        kind: 'socks-outbound',
        targets: ['one'],
      },
    ],
    targets: [{ id: 'one', name: 'One' }],
  };
  const next = {
    rows: [
      {
        key: 'stash:one',
        name: 'One',
        kind: 'socks-outbound',
        targets: ['one'],
      },
      { ...previous.rows[0], hidden: true },
    ],
    targets: previous.targets,
  };
  const merged = mergeTestPlans(previous, next);
  expect(merged.rows.filter((row) => !row.hidden).map((row) => row.key)).toEqual([
    'node:one',
    'stash:one',
  ]);
  expect(merged.targets).toHaveLength(1);
});
const setup = (): GraphState => ({
  name: 'test',
  nodes: [],
  edges: [],
  defaults: factoryDefaults(),
});
describe('Outbound test plans', () => {
  it('retests an individual stashed policy member without testing the group winner or other members', () => {
    const entry = preparedEntry(createPolicyExample(), 'test-group');
    const stash = { ...empty, groups: [{ ...defaultGroup(), entries: [entry] }] };
    const initial = createTestPlan({ graph: setup(), stash, entries: [entry] });
    const target = initial.plan.targets[1];
    const retest = createTestPlan({
      graph: setup(),
      stash,
      mode: 'speed',
      selection: { id: target.id, origin: target.origin! },
    });
    expect(retest.plan.targets).toEqual([target]);
    expect(retest.plan.rows.every((row) => row.hidden)).toBe(true);
    expect(retest.batch([target.id])).toEqual(initial.batch([target.id]));
    expect(() =>
      createTestPlan({
        graph: setup(),
        stash,
        selection: { id: 'changed', origin: target.origin! },
      }),
    ).toThrow('changed');
    // Retesting the summary in speed mode is different: the entire policy route.
    const group = createTestPlan({
      graph: setup(),
      stash,
      mode: 'speed',
      selection: { key: stashTestKey(stash, entry) },
    });
    expect(group.plan.targets).toHaveLength(1);
    expect(group.plan.targets[0].id).not.toBe(target.id);
    expect(group.batch([group.plan.targets[0].id])[0].config.observatory).toBeDefined();
    expect(() =>
      createTestPlan({
        graph: setup(),
        stash: empty,
        selection: { key: stashTestKey(stash, entry) },
      }),
    ).toThrow('no longer exists');
  });
  it('speed tests one policy route while latency tests still expand its candidates', () => {
    const graph = createPolicyExample();
    const before = JSON.stringify(graph);
    const speed = createTestPlan({
      graph,
      stash: empty,
      nodeIds: ['test-group'],
      mode: 'speed',
    });
    expect(speed.plan.rows).toHaveLength(1);
    expect(speed.plan.rows[0].error).toBeUndefined();
    expect(speed.plan.rows[0].targets).toHaveLength(1);
    const [target] = speed.batch(speed.plan.rows[0].targets);
    expect((target.config.routing as { balancers: unknown[] }).balancers.length).toBeGreaterThan(0);
    expect(
      (target.config.outbounds as { tag: string; protocol: string }[]).find(
        (o) => o.tag === target.outboundTag,
      )?.protocol,
    ).toBe('loopback');
    const latency = createTestPlan({
      graph,
      stash: empty,
      nodeIds: ['test-group'],
    });
    expect(latency.plan.rows[0].targets).toHaveLength(2);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it('retains a stashed policy and its observation settings as one executable speed target', () => {
    const graph = createPolicyExample();
    const entry = preparedEntry(graph, 'test-group');
    const stash = {
      ...empty,
      groups: [{ ...defaultGroup(), entries: [entry] }],
    };
    const speed = createTestPlan({
      graph: setup(),
      stash,
      entries: [entry],
      mode: 'speed',
    });
    expect(speed.plan.rows[0].error).toBeUndefined();
    expect(speed.plan.targets).toHaveLength(1);
    expect(speed.batch(speed.plan.rows[0].targets)[0].config.observatory).toBeDefined();
  });
  it('deduplicates actual configurations, ignoring labels/tags and keeping distinct credentials', () => {
    const g = setup();
    for (const id of ['a', 'b']) {
      const n = makeNode('socks-outbound', { x: 0, y: 0 }, id);
      Object.assign(n.data.settings, {
        tag: id,
        address: '127.0.0.1',
        port: 16001,
      });
      g.nodes.push(n);
    }
    const plan = createTestPlan({ graph: g, stash: empty });
    expect(plan.plan.targets).toHaveLength(1);
    expect(plan.plan.rows[0].targets).toEqual(plan.plan.rows[1].targets);
    Object.assign(g.nodes[1].data.settings, {
      auth: 'password',
      username: 'user',
      password: 'different',
    });
    expect(createTestPlan({ graph: g, stash: empty }).plan.targets).toHaveLength(2);
  });
  it('unrolls nested groups and deduplicates group members also present on the canvas', () => {
    const g = createPolicyExample();
    const nested = makeNode('policy-group', { x: 0, y: 0 }, 'nested');
    Object.assign(nested.data.settings, {
      tag: 'nested',
      sources: JSON.stringify({
        version: 1,
        manual: [
          { type: 'node', nodeId: 'test-group' },
          { type: 'node', nodeId: 'test-first' },
        ],
        subscriptions: [],
      }),
    });
    g.nodes.push(nested);
    const before = JSON.stringify(g);
    const t = createTestPlan({ graph: g, stash: empty });
    expect(t.plan.targets).toHaveLength(2);
    expect(t.plan.rows.find((r) => r.key === 'node:nested')?.targets).toHaveLength(2);
    expect(t.plan.rows.some((r) => r.key === 'node:test-block')).toBe(false);
    expect(JSON.stringify(g)).toBe(before);
  });
  it('does not schedule partial candidates from an unavailable policy group', () => {
    const graph = createPolicyExample();
    const invalid = makeNode('loopback-outbound', { x: 0, y: 0 }, 'loopback');
    graph.nodes.push(invalid);
    graph.nodes.find((n) => n.id === 'test-group')!.data.settings.sources = JSON.stringify({
      version: 1,
      manual: [
        { type: 'node', nodeId: 'test-first' },
        { type: 'node', nodeId: invalid.id },
      ],
      subscriptions: [],
    });
    const rejected = createTestPlan({
      graph,
      stash: empty,
      nodeIds: ['test-group'],
    });
    expect(rejected.plan.rows[0].error).toMatch(/independent HTTP connection/);
    expect(rejected.plan.targets).toEqual([]);
    // The same valid member must still be tested when selected independently.
    const usable = createTestPlan({
      graph,
      stash: empty,
      nodeIds: ['test-group', 'test-first'],
    });
    expect(usable.plan.targets).toHaveLength(1);
    const member = usable.plan.rows.find((r) => r.key === 'node:test-first')!;
    expect(member.error).toBeUndefined();
    expect(usable.batch(member.targets)).toHaveLength(1);
  });
  it('tests chains end to end, including a policy group as the final hop', () => {
    const g = createPolicyExample();
    const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
    Object.assign(chain.data.settings, {
      tag: 'chain',
      steps: JSON.stringify({
        version: 1,
        steps: [
          { id: 'entry', outbound: { type: 'node', nodeId: 'test-first' } },
          { id: 'exit', outbound: { type: 'node', nodeId: 'test-group' } },
        ],
      }),
    });
    g.nodes.push(chain);
    g.edges.push({
      id: 'chain-observer',
      source: chain.id,
      sourceHandle: 'observation',
      target: 'test-observatory',
      targetHandle: 'in',
    });
    const t = createTestPlan({ graph: g, stash: empty });
    const row = t.plan.rows.find((r) => r.key === 'node:chain')!;
    expect(row.error).toBeUndefined();
    expect(row.targets).toHaveLength(1);
    const batch = t.batch(row.targets);
    expect(batch[0].outboundTag).toBe('chain');
    expect((batch[0].config.routing as { balancers: unknown[] }).balancers.length).toBeGreaterThan(
      0,
    );
  });
  it('keeps independent results when a stash entry is incomplete', () => {
    const g = setup();
    const n = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
    g.nodes.push(n);
    const good = preparedEntry(g, n.id);
    const bad = {
      ...good,
      id: 'bad',
      profile: null,
      draft: undefined,
      problem: 'unsupported',
    };
    const stash: Stash = {
      ...empty,
      groups: [
        {
          ...defaultGroup(),
          id: 'g',
          name: '🇫🇮 unusual 🛰️',
          entries: [good, bad],
        },
      ],
    };
    const t = createTestPlan({ graph: g, stash, entries: [bad, good] });
    expect(t.plan.targets).toHaveLength(1);
    expect(t.plan.rows[0].error).toBeTruthy();
  });
  it('includes DNS policies and their transport routes without ordinary traffic filters', () => {
    const g = createDnsExample();
    const n = makeNode('direct-outbound', { x: 0, y: 0 }, 'isolated');
    n.data.settings.tag = 'isolated';
    g.nodes.push(n);
    const t = createTestPlan({ graph: g, stash: empty });
    const row = t.plan.rows.find((r) => r.key === 'node:isolated')!;
    expect(row.error).toBeUndefined();
    const config = t.batch(row.targets)[0].config;
    expect(config.dns).toBeDefined();
    expect(
      (config.routing as { rules: Record<string, unknown>[] }).rules.every((r) =>
        Array.isArray(r.inboundTag),
      ),
    ).toBe(true);
  });
  it('canonicalizes chain references without changing literal transport values', () => {
    const a = {
      outbounds: [
        {
          tag: 'a',
          protocol: 'socks',
          streamSettings: { sockopt: { dialerProxy: 'b' } },
          settings: { address: 'a' },
        },
        { tag: 'b', protocol: 'freedom' },
      ],
      routing: { rules: [], balancers: [] },
    };
    const b = {
      outbounds: [
        {
          tag: 'x',
          protocol: 'socks',
          streamSettings: { sockopt: { dialerProxy: 'y' } },
          settings: { address: 'a' },
        },
        { tag: 'y', protocol: 'freedom' },
      ],
      routing: { rules: [], balancers: [] },
    };
    expect(testIdentity(a, 'a')).toBe(testIdentity(b, 'x'));
    b.outbounds[0].settings!.address = 'x';
    expect(testIdentity(a, 'a')).not.toBe(testIdentity(b, 'x'));
  });
  it('prepares 5000 subscription entries without creating a matching canvas', () => {
    const imported = importProfiles(
      Array.from({ length: 5000 }, (_, i) => `socks://127.0.0.1:${10000 + i}#Node${i}`).join('\n'),
      'large',
    );
    const stash: Stash = { ...empty, groups: imported.groups };
    const g = setup();
    const t = createTestPlan({
      graph: g,
      stash,
      entries: stash.groups[0].entries,
    });
    expect(t.plan.targets).toHaveLength(5000);
    expect(t.batch(t.plan.targets.slice(0, 8).map((v) => v.id))).toHaveLength(8);
    expect(g.nodes).toHaveLength(0);
  });
});
it('keeps unrelated subscription pools out of the DNS configuration for isolated tests', () => {
  const imported = importProfiles(
    Array.from({ length: 5000 }, (_, i) => `socks://127.0.0.1:${10000 + i}#Node${i}`).join('\n'),
    'large',
  );
  const g = createDnsExample();
  const group = makeNode('policy-group', { x: 0, y: 0 }, 'large-group');
  group.data.settings.sources = JSON.stringify({
    version: 1,
    manual: imported.groups[0].entries.map((e) => policyProfile(e)),
    subscriptions: [],
  });
  g.nodes.push(group);
  const planned = createTestPlan({
    graph: g,
    stash: { ...empty, groups: imported.groups },
  });
  expect(planned.plan.rows.find((r) => r.key === 'node:large-group')?.targets).toHaveLength(5000);
  const batch = planned.batch(planned.plan.targets.slice(0, 8).map((t) => t.id));
  expect(batch).toHaveLength(8);
  expect(batch.every((t) => (t.config.outbounds as unknown[]).length < 10)).toBe(true);
  expect(batch.every((t) => !('identity' in t))).toBe(true);
});
it('maps results to linked graph and Stash cards without duplicating the visible report', () => {
  const g = setup();
  const n = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
  const entry = preparedEntry({ ...g, nodes: [n] }, n.id);
  const stash = { ...empty, groups: [{ ...defaultGroup(), entries: [entry] }] };
  n.data.stashLink = { groupId: stash.groups[0].id, entryId: entry.id };
  g.nodes.push(n);
  for (const entries of [undefined, [entry]]) {
    const plan = createTestPlan({ graph: g, stash, entries }).plan;
    expect(plan.targets).toHaveLength(1);
    expect(plan.rows.filter((r) => !r.hidden)).toHaveLength(1);
    expect(plan.rows.some((r) => r.key === 'node:direct')).toBe(true);
    expect(plan.rows.some((r) => r.key.startsWith('stash:'))).toBe(true);
  }
});

it('tests stashed policy chains using their saved or linked observation settings', () => {
  for (const linked of [false, true]) {
    const graph = createPolicyExample();
    const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'entry', outbound: { type: 'node', nodeId: 'test-first' } },
        { id: 'exit', outbound: { type: 'node', nodeId: 'test-group' } },
      ],
    });
    graph.nodes.push(chain);
    graph.edges.push({
      id: 'observation',
      source: chain.id,
      sourceHandle: 'observation',
      target: 'test-observatory',
      targetHandle: 'in',
    });
    const entry = preparedEntry(graph, chain.id);
    const stash = {
      ...empty,
      groups: [{ ...defaultGroup(), entries: [entry] }],
    };
    chain.data.stashLink = { groupId: stash.groups[0].id, entryId: entry.id };
    if (linked) delete entry.profile!.settings.observationSettings;
    const context = linked ? graph : setup();
    const before = JSON.stringify(context);
    const plan = createTestPlan({ graph: context, stash, entries: [entry] });
    expect(plan.plan.rows[0].error).toBeUndefined();
    expect(plan.plan.targets).toHaveLength(1);
    const config = plan.batch(plan.plan.rows[0].targets)[0].config;
    expect(config.observatory).toBeDefined();
    expect((config.routing as { balancers: unknown[] }).balancers.length).toBeGreaterThan(0);
    expect(JSON.stringify(context)).toBe(before);
  }
});

it('reports an invalid saved observation only once and keeps neighboring targets usable', () => {
  const graph = setup();
  const direct = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
  const good = preparedEntry({ ...graph, nodes: [direct] }, direct.id);
  const bad = {
    ...good,
    id: 'bad',
    name: 'bad',
    profile: {
      kind: 'proxy-chain' as const,
      settings: { observationSettings: 'invalid json' },
    },
  };
  const stash = {
    ...empty,
    groups: [{ ...defaultGroup(), entries: [bad, good] }],
  };
  const plan = createTestPlan({ graph, stash, entries: [bad, good] });
  expect(plan.plan.rows.filter((r) => !r.hidden)).toHaveLength(2);
  expect(plan.plan.rows[0].error).toBeTruthy();
  expect(plan.plan.targets).toHaveLength(1);
});

it('omits Block from graph, Stash and policy candidate tests', () => {
  const graph = createPolicyExample();
  const group = graph.nodes.find((n) => n.id === 'test-group')!;
  group.data.settings.sources = JSON.stringify({
    version: 1,
    manual: [
      { type: 'node', nodeId: 'test-first' },
      { type: 'node', nodeId: 'test-block' },
    ],
    subscriptions: [],
  });
  const graphPlan = createTestPlan({ graph, stash: empty }).plan;
  expect(graphPlan.rows.some((r) => r.kind === 'block-outbound')).toBe(false);
  expect(graphPlan.rows.find((r) => r.key === 'node:test-group')?.targets).toHaveLength(1);
  const entries = ['test-block', 'test-first'].map((id) => preparedEntry(graph, id));
  const stash = { ...empty, groups: [{ ...defaultGroup(), entries }] };
  const stashPlan = createTestPlan({ graph, stash, entries }).plan;
  expect(stashPlan.rows.filter((r) => !r.hidden)).toHaveLength(1);
  expect(stashPlan.rows[0].name).toBe('Test destination A');
  const blockOnly = createTestPlan({
    graph,
    stash,
    entries: [entries[0]],
  }).plan;
  expect(blockOnly.rows).toHaveLength(0);
  expect(blockOnly.targets).toHaveLength(0);
});

it('tests one selected graph root while keeping its dependencies and skipping Block', () => {
  const graph = createPolicyExample();
  const group = createTestPlan({
    graph,
    stash: empty,
    nodeIds: ['test-group'],
  });
  expect(group.plan.targets).toHaveLength(2);
  expect(group.plan.rows.filter((r) => !r.hidden).map((r) => r.key)).toEqual(['node:test-group']);
  const single = createTestPlan({
    graph,
    stash: empty,
    nodeIds: ['test-first'],
  });
  expect(single.plan.targets).toHaveLength(1);
  expect(single.plan.rows.filter((r) => !r.hidden).map((r) => r.key)).toEqual(['node:test-first']);
  const second = createTestPlan({
    graph,
    stash: empty,
    nodeIds: ['test-second'],
  });
  expect(second.plan.rows[0].targets[0]).toBe(group.plan.rows[0].targets[1]);
  expect(
    createTestPlan({ graph, stash: empty, nodeIds: ['test-block'] }).plan.targets,
  ).toHaveLength(0);
});

it('keeps a stashed outbound separate from a DNS transport with the same saved tag', () => {
  const graph = createDnsExample();
  const transport = graph.nodes.find((n) => n.id === 'direct')!;
  const entry: StashEntry = {
    id: 'independent-proxy',
    name: 'Imported proxy',
    protocol: 'socks',
    address: '192.0.2.8',
    raw: '',
    problem: '',
    profile: {
      kind: 'socks-outbound',
      settings: {
        tag: transport.data.settings.tag,
        address: '192.0.2.8',
        port: 1080,
      },
    },
  };
  const stash = { ...empty, groups: [{ ...defaultGroup(), entries: [entry] }] };
  const before = JSON.stringify({ graph, stash });
  const planned = createTestPlan({ graph, stash, entries: [entry] });
  expect(planned.plan.rows[0].error).toBeUndefined();
  const [{ config, outboundTag }] = planned.batch(planned.plan.rows[0].targets);
  const outbounds = config.outbounds as Record<string, unknown>[];
  expect(outbounds.find((o) => o.tag === outboundTag)?.protocol).toBe('socks');
  const routes = (config.routing as { rules: Record<string, unknown>[] }).rules;
  const localDns = routes.find((r) => r.outboundTag === transport.data.settings.tag)!;
  expect(localDns).toBeDefined();
  expect(outbounds.find((o) => o.tag === localDns.outboundTag)?.protocol).toBe('freedom');
  expect(JSON.stringify({ graph, stash })).toBe(before);
});

it('resolves dial-through dependencies from the graph instead of neighboring Stash test roots', () => {
  const graph = setup();
  const underlay = makeNode('direct-outbound', { x: 0, y: 0 }, 'underlay');
  underlay.data.settings.tag = 'underlay';
  graph.nodes.push(underlay);
  const entries: StashEntry[] = ['outer', 'underlay'].map((tag, i) => ({
    id: `entry-${i}`,
    name: `Proxy ${i}`,
    protocol: 'socks',
    address: `192.0.2.${i + 1}`,
    raw: '',
    problem: '',
    profile: {
      kind: 'socks-outbound',
      settings: {
        tag,
        address: `192.0.2.${i + 1}`,
        port: 1080,
        ...(i === 0 ? { dialerProxy: 'underlay' } : {}),
      },
    },
  }));
  const stash = { ...empty, groups: [{ ...defaultGroup(), entries }] };
  const planned = createTestPlan({ graph, stash, entries });
  expect(planned.plan.rows[0].error).toBeUndefined();
  const [{ config, outboundTag }] = planned.batch(planned.plan.rows[0].targets);
  const outbounds = config.outbounds as Record<string, unknown>[];
  expect(outbounds.find((o) => o.tag === outboundTag)?.protocol).toBe('socks');
  expect(outbounds.find((o) => o.tag === 'underlay')?.protocol).toBe('freedom');
  expect(outbounds).toHaveLength(2);
});
