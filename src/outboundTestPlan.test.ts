import { describe, it, expect } from 'vitest';
import { createTestPlan } from './outboundTestPlan';
import { makeNode } from './graph/catalog';
import { factoryDefaults } from './graph/defaults';
import { createPolicyExample } from './graph/policyExample';
import { createDnsExample } from './graph/example';
import { defaultGroup } from './profiles/stashModel';
import { importProfiles, type Stash, type StashEntry } from './profiles/import';
import type { GraphState } from './graph/types';
const empty: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
const setup = (): GraphState => ({
  name: 'test',
  nodes: [],
  edges: [],
  defaults: factoryDefaults(),
});
describe('Outbound test plans', () => {
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
