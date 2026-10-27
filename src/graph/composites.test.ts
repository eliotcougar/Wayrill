/// <reference types="node" />
import { defaultGroup, stashRows } from '../profiles/stashModel';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDnsExample } from './example';
import { compileDnsGraph } from './dnsCompilation';
import {
  policyProfile,
  policyProfileId,
  subscriptionSource,
  refreshPolicyGraph,
} from './policySources';
import { preparedPreview } from '../profiles/preparedPreview';
import { makeNode, makeProxyInbound, getOutputPorts } from './catalog';
import { factoryDefaults } from './defaults';
import { preparedEntry, readProxyChain } from './composites';
import { compileRuntimeGraph } from './runtime';
import { diagnoseRuntimeGraph } from './diagnostics';
import { applyStashedProfile } from '../profiles/graph';
import {
  parseStash,
  serializeStash,
  mergeImport,
  importProfiles,
  type Stash,
} from '../profiles/import';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { typedConnectionProblem } from './connectionTypes';
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
  it('applies the previous hop to every exit-policy candidate including native prefix selection', () => {
    const { graph, chain } = setup();
    const group = addGroup(graph, ['b'], 'exit-group');
    Object.assign(group.data.settings, { selection: 'prefixes', selectorPrefixes: 'b' });
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'first', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'exit', outbound: { type: 'node', nodeId: group.id } },
      ],
    });
    const config = compileRuntimeGraph(graph).config;
    const bridge = outbound(config, 'exit');
    expect(bridge.protocol).toBe('loopback');
    const rule = (config.routing as { rules: Record<string, unknown>[] }).rules.find(
      (r) =>
        JSON.stringify(r.inboundTag) ===
        JSON.stringify([(bridge.settings as { inboundTag: string }).inboundTag]),
    )!;
    const balance = (
      config.routing as { balancers: { tag: string; selector: string[] }[] }
    ).balancers.find((b) => b.tag === rule.balancerTag)!;
    const member = (config.outbounds as Record<string, unknown>[]).find((o) =>
      String(o.tag).startsWith(balance.selector[0]),
    )!;
    expect(via(member)).toBeTruthy();
    expect(outbound(config, via(member)!)).toMatchObject({ settings: { port: 16001 } });
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
  it('copies graph dependencies into standalone stash snapshots and replaces in all directions atomically', () => {
    const { graph, chain } = setup();
    const group = addGroup(graph, ['a'], 'group');
    const original = JSON.stringify(graph);
    const c = preparedEntry(graph, chain.id),
      g = preparedEntry(graph, group.id),
      plain = preparedEntry(graph, 'a');
    const copied = readProxyChain({ ...chain.data, settings: c.profile!.settings });
    expect(copied.steps.every((s) => s.outbound.type === 'profile')).toBe(true);
    let current = graph;
    for (const entry of [g, c, plain, c, g]) {
      current = applyStashedProfile(current, entry, { x: 99, y: 99 }, chain.id);
      const n = current.nodes.find((n) => n.id === chain.id)!;
      expect(n.data.settings.tag).toBe('exit');
      expect(n.position).toEqual(chain.position);
      expect(current.edges.find((e) => e.id === graph.edges[0].id)?.target).toBe(chain.id);
      expect(compileRuntimeGraph(current).config).toBeTruthy();
    }
    expect(JSON.stringify(graph)).toBe(original);
    graph.nodes.find((n) => n.id === 'a')!.data.settings.port = 17001;
    expect(
      copied.steps[0].outbound.type === 'profile'
        ? copied.steps[0].outbound.profile.settings.port
        : undefined,
    ).toBe(16001);
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
  it('preserves live observation when replacing the last policy group with a plain outbound', () => {
    const { graph, chain } = setup(),
      group = addGroup(graph, ['a']);
    group.data.settings.strategy = 'leastPing';
    const obs = makeNode('observatory', { x: 0, y: 0 }, 'obs');
    graph.nodes.push(obs);
    graph.edges.push(wire(group.id, 'observation', obs.id));
    const observed = applyStashedProfile(
      graph,
      preparedEntry(graph, group.id),
      { x: 0, y: 0 },
      chain.id,
    );
    observed.nodes = observed.nodes.filter((n) => n.id !== group.id);
    observed.edges = observed.edges.filter((e) => e.source !== group.id);
    const replaced = applyStashedProfile(
      observed,
      preparedEntry(graph, 'a'),
      { x: 0, y: 0 },
      chain.id,
    );
    expect(compileRuntimeGraph(replaced).config.observatory).toMatchObject({
      subjectSelector: ['wayrill-observed-exit'],
    });
    expect(diagnoseRuntimeGraph(replaced).filter((i) => i.severity === 'error')).toEqual([]);
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
  it('round-trips prepared stash tabs and remaps duplicate imports', () => {
    const { graph, chain } = setup();
    const group = addGroup(graph, ['a']);
    const stash: Stash = {
      format: 'wayrill.stash',
      version: 3,
      groups: [
        {
          ...defaultGroup(),
          entries: [preparedEntry(graph, group.id), preparedEntry(graph, chain.id)],
        },
      ],
    };
    expect(parseStash(serializeStash(stash))).toEqual(stash);
    const result = importProfiles(serializeStash(stash));
    const merged = mergeImport(stash, result);
    expect(stashRows(merged, 'policy-group').map((r) => r.entry)).toHaveLength(2);
    expect(new Set(stashRows(merged, 'policy-group').map((r) => JSON.stringify(r.link))).size).toBe(
      2,
    );
    expect(stashRows(merged, 'proxy-chain').map((r) => r.entry)).toHaveLength(2);
    const invalid = structuredClone(stash);
    stashRows(invalid, 'proxy-chain').map((r) => r.entry)[0].profile!.settings.steps = String(
      chain.data.settings.steps,
    );
    expect(() => parseStash(serializeStash(invalid))).toThrow(/independent copies/);
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
  it('keeps ordinary traffic inputs and the bidirectional observation role distinct', () => {
    const { chain, a } = setup();
    const observer = makeNode('observatory', { x: 0, y: 0 });
    expect(typedConnectionProblem(chain.data, 'observation', observer.data)).toBeNull();
    expect(typedConnectionProblem(chain.data, 'observation', a.data)).toMatch(/Observation/);
    expect(typedConnectionProblem(a.data, 'traffic', chain.data)).toBeNull();
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
  it('preserves a final-fragment stage when copying a chain into the stash', () => {
    const { graph, chain, b } = setup();
    const v = makeNode('vless-outbound', { x: 0, y: 0 }, b.id);
    Object.assign(v.data.settings, {
      tag: 'b',
      address: 'example.net',
      port: 443,
      id: 'ba640cce-3c50-46f5-8406-bf36f35b5c90',
      security: 'tls',
      finalFragmentEnabled: true,
    });
    v.data.overrides = ['finalFragmentEnabled'];
    graph.nodes = graph.nodes.map((n) => (n.id === b.id ? v : n));
    const entry = preparedEntry(graph, chain.id);
    const replaced = applyStashedProfile(graph, entry, { x: 0, y: 0 }, chain.id);
    const config = compileRuntimeGraph(replaced).config,
      exit = outbound(config, 'exit');
    expect(exit.protocol).toBe('freedom');
    expect(outbound(config, via(exit)!).protocol).toBe('vless');
  });
  it('remaps subscription identities recursively on a repeated stash import', () => {
    const { graph, chain } = setup(),
      group = addGroup(graph, []);
    const imported = importProfiles('socks://127.0.0.1:16003#Imported');
    group.data.settings.selection = 'subscription';
    group.data.settings.sources = JSON.stringify({
      version: 1,
      manual: [],
      subscriptions: [subscriptionSource(imported.groups[0])],
    });
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'a', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'group', outbound: { type: 'node', nodeId: group.id } },
      ],
    });
    const stash: Stash = {
      format: 'wayrill.stash',
      version: 3,
      groups: [
        ...imported.groups,
        {
          ...defaultGroup(),
          entries: [preparedEntry(graph, group.id), preparedEntry(graph, chain.id)],
        },
      ],
    };
    const merged = mergeImport(stash, importProfiles(serializeStash(stash)));
    const copied = readProxyChain({
      ...chain.data,
      settings: stashRows(merged, 'proxy-chain').map((r) => r.entry)[1].profile!.settings,
    });
    const ref = copied.steps[1].outbound;
    expect(ref.type).toBe('profile');
    if (ref.type !== 'profile') throw new Error('Expected copied policy');
    expect(ref.id).toBe(policyProfileId(ref.profile));
    const sources = JSON.parse(String(ref.profile.settings.sources));
    expect(sources.subscriptions[0].groupId).toBe(merged.groups[2].id);
    expect(merged.groups[0].id).not.toBe(merged.groups[2].id);
    expect(
      JSON.parse(
        String(stashRows(merged, 'policy-group').map((r) => r.entry)[1].profile!.settings.sources),
      ).subscriptions[0].groupId,
    ).toBe(merged.groups[2].id);
    merged.groups[2].entries[0].name = 'Correct refreshed group';
    const added = applyStashedProfile(
      graph,
      stashRows(merged, 'proxy-chain').map((r) => r.entry)[1],
      { x: 0, y: 0 },
      chain.id,
    );
    const refreshed = refreshPolicyGraph(added, merged).nodes.find((n) => n.id === chain.id)!;
    const updated = readProxyChain(refreshed.data).steps[1].outbound;
    if (updated.type !== 'profile') throw new Error('Expected copied group');
    expect(
      JSON.parse(String(updated.profile.settings.sources)).subscriptions[0].entries[0].name,
    ).toBe('Correct refreshed group');
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
  it('does not report compiler-only relays or referenced hops as disconnected cards', () => {
    const { graph } = setup();
    const warnings = diagnoseRuntimeGraph(graph).filter((i) => i.severity === 'warning');
    expect(
      warnings.filter(
        (i) =>
          ['a', 'b', 'chain'].includes(i.nodeId ?? '') &&
          (i.message.includes('no incoming path') || i.message.includes('unreachable')),
      ),
    ).toEqual([]);
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
  it('refreshes a linked subscription inside a copied policy inside a chain', () => {
    const { graph, chain } = setup();
    const imported = importProfiles('socks://127.0.0.1:16003#Old');
    const stash: Stash = { format: 'wayrill.stash', version: 3, groups: imported.groups };
    const group = addGroup(graph, []);
    group.data.settings.selection = 'subscription';
    group.data.settings.sources = JSON.stringify({
      version: 1,
      manual: [],
      subscriptions: [subscriptionSource(stash.groups[0])],
    });
    const copy = policyProfile(preparedEntry(graph, group.id));
    chain.data.settings.steps = JSON.stringify({
      version: 1,
      steps: [
        { id: 'first', outbound: { type: 'node', nodeId: 'a' } },
        { id: 'last', outbound: copy },
      ],
    });
    const updated = {
      ...stash,
      groups: [
        {
          ...stash.groups[0],
          updatedAt: Date.now(),
          entries: importProfiles('socks://127.0.0.1:16004#New').groups[0].entries,
        },
      ],
    };
    const refreshed = refreshPolicyGraph(graph, updated),
      hop = readProxyChain(refreshed.nodes.find((n) => n.id === chain.id)!.data).steps[1].outbound;
    expect(hop.type).toBe('profile');
    if (hop.type !== 'profile') throw new Error('Expected copied group');
    expect(hop.id).toBe(policyProfileId(hop.profile));
    expect(JSON.parse(String(hop.profile.settings.sources)).subscriptions[0].entries[0].name).toBe(
      'New',
    );
    expect(hop.id).not.toBe(copy.id);
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
  const core = process.env.WAYRILL_XRAY_TEST_EXE,
    dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
  it.skipIf(!core || !dir)(
    'passes the pinned Xray parser with a nested policy exit and entry underlay',
    () => {
      const { graph, chain } = setup();
      const group = addGroup(graph, ['b']);
      chain.data.settings.steps = JSON.stringify({
        version: 1,
        steps: [
          { id: 'first', outbound: { type: 'node', nodeId: 'a' } },
          { id: 'last', outbound: { type: 'node', nodeId: group.id } },
        ],
      });
      const config = compileRuntimeGraph(graph).config;
      mkdirSync(dir!, { recursive: true });
      const file = join(dir!, 'composite-policy-chain.json');
      writeFileSync(file, JSON.stringify(config));
      const result = spawnSync(core!, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );
});

it('keeps copied Stash chain hops out of both graph checks and compiled warnings', () => {
  const { graph, chain } = setup();
  const steps = JSON.parse(String(chain.data.settings.steps));
  steps.steps = steps.steps.map((step: { id: string; outbound: { nodeId: string } }) => {
    const entry = preparedEntry(graph, step.outbound.nodeId);
    return {
      ...step,
      outbound: {
        type: 'profile',
        name: entry.name,
        id: policyProfileId(entry.profile!),
        profile: entry.profile,
      },
    };
  });
  chain.data.settings.steps = JSON.stringify(steps);
  // The copied hops are independent prepared definitions, not visible cards.
  graph.nodes = graph.nodes.filter((n) => !['a', 'b'].includes(n.id));
  expect(diagnoseRuntimeGraph(graph).filter((i) => i.message.includes('no incoming path'))).toEqual(
    [],
  );
  expect(compileRuntimeGraph(graph).warnings.filter((i) => i.includes('no incoming path'))).toEqual(
    [],
  );
});

it('probes the complete chain through its public route and retains its Observation wire', () => {
  const { graph, chain } = setup();
  const observer = makeNode('observatory', { x: 900, y: 0 }, 'monitor');
  graph.nodes.push(observer);
  graph.edges.push(wire(chain.id, 'observation', observer.id));
  const config = compileRuntimeGraph(graph).config;
  const root = outbound(config, 'exit'),
    probe = outbound(config, 'wayrill-observed-exit');
  expect(probe).toEqual({ ...root, tag: 'wayrill-observed-exit' });
  expect(via(probe)).toBeTruthy();
  expect(config.observatory).toMatchObject({ subjectSelector: ['wayrill-observed-exit'] });
});
