import { describe, it, expect } from 'vitest';
import { createTestPlan, testIdentity } from './outboundTestPlan';
import { makeNode } from './graph/catalog';
import { factoryDefaults } from './graph/defaults';
import { createPolicyExample } from './graph/policyExample';
import { createDnsExample } from './graph/example';
import { importXrayConfig } from './graph/xrayImport';
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
  it('preserves native DNS routing, including loopback re-entry and the implicit default', () => {
    const dns = {
      tag: 'dns-query',
      hosts: { 'full:resolver.example': '192.0.2.53' },
      servers: [
        'localhost',
        { address: 'tcp://resolver.example', tag: 'encrypted-dns' },
        '192.0.2.53',
      ],
    };
    const rules = [
      { type: 'field', inboundTag: ['browser'], outboundTag: 'browser-only' },
      { type: 'field', inboundTag: ['encrypted-dns'], outboundTag: 'reenter' },
      { type: 'field', inboundTag: ['second-pass'], balancerTag: 'resolvers' },
      { type: 'field', ip: ['192.0.2.53'], outboundTag: 'underlay' },
    ];
    const direct = (tag: string) => ({ tag, protocol: 'freedom' });
    const graph = importXrayConfig(
      JSON.stringify({
        dns,
        inbounds: [{ tag: 'browser', listen: '127.0.0.1', port: 1081, protocol: 'socks' }],
        outbounds: [
          { tag: 'default-block', protocol: 'blackhole' },
          direct('tested'),
          direct('browser-only'),
          direct('underlay'),
          {
            tag: 'resolver-a',
            protocol: 'freedom',
            streamSettings: { sockopt: { dialerProxy: 'underlay' } },
          },
          { tag: 'reenter', protocol: 'loopback', settings: { inboundTag: 'second-pass' } },
        ],
        routing: {
          domainStrategy: 'IPIfNonMatch',
          rules,
          balancers: [{ tag: 'resolvers', selector: ['resolver-'] }],
        },
      }),
    );
    const tested = graph.nodes.find((n) => n.data.settings.tag === 'tested')!;
    const plan = createTestPlan({ graph, stash: empty, nodeIds: [tested.id] });
    expect(plan.plan.rows[0].error).toBeUndefined();
    const [target] = plan.batch(plan.plan.rows[0].targets);
    expect(target.outboundTag).toBe('tested');
    expect(target.config.dns).toEqual(dns);
    expect(target.config.routing).toMatchObject({
      domainStrategy: 'IPIfNonMatch',
      rules: rules.slice(1),
      balancers: [{ tag: 'resolvers' }],
    });
    const outputs = target.config.outbounds as { tag: string }[];
    expect(outputs[0].tag).toBe('default-block');
    expect(outputs.map((o) => o.tag).sort()).toEqual([
      'default-block',
      'reenter',
      'resolver-a',
      'tested',
      'underlay',
    ]);
  });

  it('keeps a Stash probe out of a DNS balancer and its Observatory when prefixes overlap', () => {
    const graph = importXrayConfig(
      JSON.stringify({
        dns: { tag: 'dns', servers: ['192.0.2.53'] },
        outbounds: [
          { tag: 'default', protocol: 'blackhole' },
          { tag: 'west', protocol: 'freedom' },
        ],
        routing: {
          rules: [{ type: 'field', inboundTag: ['dns'], balancerTag: 'resolver' }],
          balancers: [{ tag: 'resolver', selector: ['w'] }],
        },
        observatory: { subjectSelector: ['w'], probeURL: 'http://192.0.2.1/health' },
      }),
    );
    const { groups } = importProfiles('socks://192.0.2.2:1080#Stash', 'saved');
    const test = createTestPlan({ graph, stash: { ...empty, groups }, entries: groups[0].entries });
    const [row] = test.plan.rows;
    expect(row.error).toBeUndefined();
    const [{ config }] = test.batch(row.targets);
    const tags = (config.outbounds as { tag: string }[]).map((o) => o.tag);
    const { balancers } = config.routing as { balancers: { selector: string[] }[] };
    const { subjectSelector } = config.observatory as { subjectSelector: string[] };
    for (const prefixes of [balancers[0].selector, subjectSelector])
      expect(tags.filter((t) => prefixes.some((p) => t.startsWith(p)))).toEqual(['west']);
  });

  it('tests an untagged imported outbound with local DNS without changing the import', () => {
    const dns = { servers: ['h2c+local://127.0.0.1/dns-query'], queryStrategy: 'UseIPv4' };
    const graph = importXrayConfig(
      JSON.stringify({
        dns,
        outbounds: [{ protocol: 'freedom' }, { tag: 'spare', protocol: 'blackhole' }],
      }),
    );
    const before = structuredClone(graph);
    const plan = createTestPlan({ graph, stash: empty });
    expect(plan.plan.rows[0].error).toBeUndefined();
    const [target] = plan.batch(plan.plan.rows[0].targets);
    expect(target.outboundTag).toBeTruthy();
    expect(target.config.outbounds).toEqual([{ protocol: 'freedom', tag: target.outboundTag }]);
    expect(target.config.dns).toEqual(dns);
    expect(graph).toEqual(before);
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

it('includes the active XHTTP download underlay in isolated outbound tests', () => {
  const graph = setup();
  const underlay = makeNode('direct-outbound', { x: 0, y: 0 }, 'underlay');
  underlay.data.settings.tag = 'underlay';
  const node = makeNode('xray-outbound', { x: 0, y: 0 }, 'download');
  node.data.settings.tag = 'download';
  node.data.settings.json = JSON.stringify({
    protocol: 'socks',
    settings: { address: '192.0.2.1', port: 1080 },
    streamSettings: {
      network: 'xhttp',
      xhttpSettings: {
        extra: { downloadSettings: { sockopt: { dialerProxy: 'underlay' } } },
      },
    },
  });
  graph.nodes.push(node, underlay);
  const planned = createTestPlan({ graph, stash: empty, nodeIds: [node.id] });
  expect(planned.plan.rows[0].error).toBeUndefined();
  expect(planned.batch(planned.plan.rows[0].targets)[0].config.outbounds).toEqual([
    expect.objectContaining({ tag: 'download' }),
    expect.objectContaining({ tag: 'underlay', protocol: 'freedom' }),
  ]);
});

it('tests through the same DNS download transport and fragment stages as routing', () => {
  const graph = createDnsExample();
  const resolverProxy = graph.nodes.find((n) => n.id === 'preferred')!;
  resolverProxy.data.kind = 'xray-outbound';
  resolverProxy.data.settings = {
    tag: 'preferred',
    json: JSON.stringify({
      protocol: 'socks',
      settings: { address: '192.0.2.1', port: 1080 },
      streamSettings: {
        network: 'xhttp',
        xhttpSettings: {
          extra: {
            downloadSettings: { sockopt: { dialerProxy: 'underlay' } },
          },
        },
      },
    }),
  };
  const relay = makeNode('vless-outbound', { x: 0, y: 0 }, 'relay');
  Object.assign(relay.data.settings, {
    tag: 'underlay',
    address: 'example.org',
    id: 'wayrill-example',
    finalFragmentEnabled: true,
  });
  relay.data.overrides = ['finalFragmentEnabled'];
  graph.nodes.push(relay);
  // Test a different server: the fragment stages must come from the DNS context.
  for (const id of ['direct', resolverProxy.id, relay.id]) {
    const job = createTestPlan({ graph, stash: empty, nodeIds: [id] });
    const [row] = job.plan.rows;
    expect(row.error).toBeUndefined();
    const [target] = job.batch(row.targets);
    const outbounds = target.config.outbounds as {
      tag: string;
      protocol: string;
      streamSettings?: { sockopt: { dialerProxy: string } };
    }[];
    const wrapper = outbounds.find((o) => o.tag === 'underlay');
    expect(wrapper?.protocol).toBe('freedom');
    const inner = outbounds.find((o) => o.tag === wrapper?.streamSettings?.sockopt.dialerProxy);
    expect(inner?.protocol).toBe('vless');
    expect(new Set(outbounds.map((o) => o.tag)).size).toBe(outbounds.length);
  }
});

it('deduplicates structural identities without normalizing transport headers or selector membership', () => {
  const config = (tag: string, header: string, prefix = tag) => ({
    outbounds: [
      {
        tag,
        protocol: 'socks',
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: { headers: { tag: header, dialerProxy: header } },
        },
      },
    ],
    routing: {
      balancers: [{ tag, selector: [prefix] }],
      rules: [
        {
          type: 'field',
          balancerTag: tag,
        },
      ],
    },
  });
  const baseline = testIdentity(config('a', 'value'), 'a');
  expect(testIdentity(config('renamed', 'value'), 'renamed')).toBe(baseline);
  const separateNamespace = config('a', 'value');
  separateNamespace.routing.balancers[0].tag = 'group';
  separateNamespace.routing.rules[0].balancerTag = 'group';
  expect(testIdentity(separateNamespace, 'a')).toBe(baseline);
  expect(testIdentity(config('b', 'value', 'a'), 'b')).not.toBe(baseline);
  expect(testIdentity(config('region-a', 'value', 'region-'), 'region-a')).not.toBe(
    testIdentity(config('other-a', 'value', 'region-'), 'other-a'),
  );
  expect(testIdentity(config('a', 'a'), 'a')).not.toBe(testIdentity(config('b', 'b'), 'b'));
  const weighted = config('region-a', 'value'),
    renamed = config('other-a', 'value');
  for (const object of [weighted, renamed])
    Object.assign(object.routing.balancers[0], {
      strategy: {
        type: 'leastLoad',
        settings: {
          costs: [{ regexp: false, match: 'region-', value: 2 }],
        },
      },
    });
  expect(testIdentity(weighted, 'region-a')).not.toBe(testIdentity(renamed, 'other-a'));
});
