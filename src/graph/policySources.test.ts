import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPolicyExample } from './policyExample';
import { compileRuntimeGraph } from './runtime';
import { compileXrayGraph } from './xrayCompiler';
import { importXrayConfig } from './xrayImport';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { duplicateSelection } from './editing';
import { applyDefaults, factoryDefaults } from './defaults';
import { makeNode } from './catalog';
import { importProfiles } from '../profiles/import';
import type { Stash, StashEntry, StashGroup } from '../profiles/import';
import {
  emptyPolicySources,
  filterPolicyEntries,
  policyCandidates,
  policyProfile,
  policyProfileId,
  policyReferenceSet,
  readPolicySources,
  refreshPolicyGraph,
  refreshPolicySources,
  subscriptionSource,
  type PolicySources,
} from './policySources';

const stash = (groups: StashGroup[]): Stash => ({
  format: 'wayrill.stash',
  version: 3,

  groups,
});
const subscription = () =>
  importProfiles(
    [
      'vless://qa-a@a.example.net:443?security=tls#JP%20Tokyo%20fast',
      'vless://qa-b@b.example.net:443?security=tls#JP%20Tokyo%20slow',
      'vless://qa-c@c.example.net:443?security=tls#DE%20Berlin',
    ].join('\n'),
    'Public sample',
  ).groups[0];
const groupNode = (graph: ReturnType<typeof createPolicyExample>) =>
  graph.nodes.find((n) => n.data.kind === 'policy-group')!;
const configure = (
  graph: ReturnType<typeof createPolicyExample>,
  sources: PolicySources,
  mode = 'subscription',
) => {
  Object.assign(groupNode(graph).data.settings, {
    selection: mode,
    sources: JSON.stringify(sources),
  });
  return graph;
};
const selectors = (config: Record<string, unknown>) =>
  (config.routing as { balancers: { selector: string[] }[] }).balancers[0].selector;

describe('internal outbound sources', () => {
  it('treats manually selected graph outbounds as connected, regardless of their node IDs', () => {
    const graph = createPolicyExample();
    const first = graph.nodes.find((n) => n.id === 'test-first')!;
    first.id = 'policy-profile-real-outbound';
    const sources = readPolicySources(groupNode(graph).data);
    sources.manual[0] = { type: 'node', nodeId: first.id };
    groupNode(graph).data.settings.sources = JSON.stringify(sources);
    expect(compileRuntimeGraph(graph).config.outbounds).toHaveLength(4);
    expect(diagnoseGraph(graph).filter((p) => p.message.includes('no incoming path'))).toEqual([]);
  });
  it('preserves copied profile dial-through dependencies and fragment stages under generated tags', () => {
    const sub = subscription();
    sub.entries[0].profile!.settings.dialerProxy = 'source-b';
    sub.entries[0].profile!.settings.finalFragmentEnabled = true;
    sub.entries[1].profile!.settings.tag = 'source-b';
    const sources = {
      ...emptyPolicySources(),
      manual: sub.entries.slice(0, 2).map((entry) => policyProfile(entry)),
      fallback: { type: 'node' as const, nodeId: 'test-block' },
    };
    const graph = configure(createPolicyExample(), sources, 'manual');
    const config = compileRuntimeGraph(graph).config;
    const outputs = config.outbounds as Record<string, unknown>[];
    const target = outputs.find((o) => JSON.stringify(o.settings).includes('b.example.net'))!;
    const first = outputs.find((o) => JSON.stringify(o.settings).includes('a.example.net'))!;
    expect(first.streamSettings).toMatchObject({ sockopt: { dialerProxy: target.tag } });
    const wrapper = outputs.find((o) => o.tag === selectors(config)[0])!;
    expect(wrapper.streamSettings).toMatchObject({ sockopt: { dialerProxy: first.tag } });
    expect(selectors(config)).not.toContain(first.tag);
  });
  it('rejects ambiguous, missing and cyclic dial-through dependencies in internal pools', () => {
    const sub = subscription();
    sub.entries[0].profile!.settings.dialerProxy = 'source-b';
    sub.entries[1].profile!.settings.tag = 'source-b';
    sub.entries[2].profile!.settings.tag = 'source-b';
    const graphWith = (entries: StashEntry[]) =>
      configure(
        createPolicyExample(),
        {
          ...emptyPolicySources(),
          manual: entries.map((entry) => policyProfile(entry)),
          fallback: { type: 'node', nodeId: 'test-block' },
        },
        'manual',
      );
    expect(() => compileRuntimeGraph(graphWith(sub.entries))).toThrow(/matches multiple/);
    expect(() => compileRuntimeGraph(graphWith([sub.entries[0]]))).toThrow(/missing/);
    sub.entries[0].profile!.settings.tag = 'source-a';
    sub.entries[1].profile!.settings.dialerProxy = 'source-a';
    expect(() => compileRuntimeGraph(graphWith(sub.entries.slice(0, 2)))).toThrow(/loop/);
  });
  it('previews the filtered subscription, excludes unsupported rows and keeps the canvas free of candidate nodes', () => {
    const sub = subscription();
    sub.entries.push({
      id: 'unsupported',
      name: 'JP Tokyo unsupported',
      protocol: 'other',
      address: 'broken.example.net',
      profile: null,
      problem: 'Unsupported protocol',
      raw: 'public-test',
    });
    const source = subscriptionSource(sub);
    source.filter.name = 'jp tokyo';
    source.filter.exclude = 'slow';
    source.filter.address = 'example.net';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    expect(sources.subscriptions[0].entries.map((e) => e.name)).toEqual(['JP Tokyo fast']);
    expect(sources.subscriptions[0].rejected).toBe(1);
    const graph = configure(createPolicyExample('leastPing'), sources);
    const result = compileRuntimeGraph(graph),
      tags = selectors(result.config);
    expect(tags).toHaveLength(1);
    expect(
      (result.config.outbounds as Record<string, unknown>[]).find((o) => o.tag === tags[0]),
    ).toMatchObject({ protocol: 'vless', settings: { address: 'a.example.net', id: 'qa-a' } });
    expect(result.config.observatory).toMatchObject({ subjectSelector: tags });
    expect(graph.nodes).toHaveLength(6);
    expect(
      graph.edges.filter((e) => e.source === groupNode(graph).id).map((e) => e.sourceHandle),
    ).toEqual(['observation']);
    expect(result.warnings.some((s) => s.includes('unsupported'))).toBe(true);
  });
  it('unions a manual set with multiple subscriptions and removes duplicate copies before compilation', () => {
    const sub = subscription(),
      second = { ...sub, id: 'another', name: 'Second group' };
    const first = subscriptionSource(sub),
      extra = subscriptionSource(second);
    first.filter.name = 'Tokyo';
    extra.filter.name = 'Tokyo';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [first, extra],
        manual: [policyProfile(sub.entries[0]), { type: 'node', nodeId: 'test-first' }],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub, second]),
    );
    const graph = configure(createPolicyExample(), sources, 'combined');
    expect(policyReferenceSet(graph, groupNode(graph))).toHaveLength(3);
    const config = compileRuntimeGraph(graph).config;
    expect(selectors(config)).toHaveLength(3);
    expect(config.outbounds).toHaveLength(6);
    expect(compileRuntimeGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
  });
  it('filters Unicode names and literal punctuation with safe wildcard matching and protocol checks', () => {
    const sub = subscription();
    sub.entries[0].name = '東京 [JP] Fast';
    sub.entries[1].name = '東京 [JP] Slow';
    const source = subscriptionSource(sub);
    source.filter = {
      ...source.filter,
      mode: 'glob',
      name: '東京 [jp] *',
      exclude: '*slow',
      protocol: 'vless',
      address: '?.example.net',
    };
    expect(filterPolicyEntries(sub, source.filter).map((e) => e.name)).toEqual(['東京 [JP] Fast']);
    source.filter.protocol = 'socks';
    expect(filterPolicyEntries(sub, source.filter)).toEqual([]);
    source.filter.mode = 'contains';
    source.filter.name = '[JP]';
    source.filter.address = '';
    source.filter.protocol = '';
    source.filter.exclude = '';
    expect(filterPolicyEntries(sub, source.filter)).toHaveLength(2);
  });
  it('keeps linked runtime tags stable across subscription ordering', () => {
    const sub = subscription(),
      source = subscriptionSource(sub);
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample(), sources),
      before = selectors(compileRuntimeGraph(graph).config);
    const refreshed = {
      ...sub,
      updatedAt: 123,
      entries: [...sub.entries].reverse(),
    };
    const next = refreshPolicyGraph(graph, stash([refreshed]));
    expect(new Set(selectors(compileRuntimeGraph(next).config))).toEqual(new Set(before));
    expect(refreshPolicyGraph(next, stash([refreshed]))).toBe(next);
  });
  it('refreshes live subscriptions while retaining independent manual copies and allowing a saved snapshot when the group disappears', () => {
    const sub = subscription(),
      source = subscriptionSource(sub),
      copied = policyProfile(sub.entries[0]);
    source.filter.name = 'fast';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        manual: [copied],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample(), sources, 'combined');
    const changed = subscription();
    changed.id = sub.id;
    changed.entries[0].profile!.settings.address = 'new.example.net';
    const next = refreshPolicyGraph(graph, stash([changed]));
    expect(readPolicySources(groupNode(next).data).manual).toEqual([copied]);
    expect(policyReferenceSet(next, groupNode(next))).toHaveLength(2);
    const absent = refreshPolicyGraph(next, stash([]));
    expect(readPolicySources(groupNode(absent).data).subscriptions[0].missing).toBe(true);
    expect(compileRuntimeGraph(absent).config).toEqual(compileRuntimeGraph(next).config);
    expect(
      compileRuntimeGraph(absent).warnings.some((w) => w.includes('saved outbound snapshot')),
    ).toBe(true);
  });
  it('uses a configured fallback for an empty filtered set and reports an unprotected empty set', () => {
    const sub = subscription(),
      source = subscriptionSource(sub);
    source.filter.name = 'no match';
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [source],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample('leastPing'), sources);
    const config = compileRuntimeGraph(graph).config;
    expect(selectors(config)).toEqual(['wayrill-policy-empty-test-group']);
    expect(
      (config.routing as { balancers: { fallbackTag: string }[] }).balancers[0].fallbackTag,
    ).toBe('block');
    groupNode(graph).data.settings.fallbackEnabled = false;
    expect(() => compileRuntimeGraph(graph)).toThrow(/No outbound matches/);
  });
  it('applies workspace inheritance to copied profiles and honors explicit overrides', () => {
    const sub = subscription(),
      sources = emptyPolicySources();
    sources.manual = [policyProfile(sub.entries[0])];
    sources.fallback = { type: 'node', nodeId: 'test-block' };
    let graph = configure(createPolicyExample(), sources, 'manual');
    const defaults = factoryDefaults();
    defaults.settings.fingerprint = 'firefox';
    graph = applyDefaults(graph, defaults);
    expect(policyCandidates(graph, groupNode(graph))[0].node.data.settings.fingerprint).toBe(
      'firefox',
    );
    const explicit = {
      ...sub.entries[0],
      profile: {
        ...sub.entries[0].profile!,
        settings: { ...sub.entries[0].profile!.settings, fingerprint: 'chrome' },
      },
    };
    sources.manual = [policyProfile(explicit)];
    configure(graph, sources, 'manual');
    expect(policyCandidates(graph, groupNode(graph))[0].node.data.settings.fingerprint).toBe(
      'chrome',
    );
  });
  it('previews all 5,000 matches without creating graph nodes or silently truncating the runtime pool', () => {
    const sub = subscription();
    const sample = sub.entries[0];
    sub.entries = Array.from({ length: 5000 }, (_, i): StashEntry => ({
      ...sample,
      id: `row-${i}`,
      name: `Region ${i}`,
      address: `edge${i}.example.net`,
      profile: {
        ...sample.profile!,
        settings: { ...sample.profile!.settings, address: `edge${i}.example.net` },
      },
    }));
    const sources = refreshPolicySources(
      {
        ...emptyPolicySources(),
        subscriptions: [subscriptionSource(sub)],
        fallback: { type: 'node', nodeId: 'test-block' },
      },
      stash([sub]),
    );
    const graph = configure(createPolicyExample(), sources);
    expect(policyReferenceSet(graph, groupNode(graph))).toHaveLength(5000);
    expect(graph.nodes).toHaveLength(6);
    const config = compileRuntimeGraph(graph).config;
    expect(config.outbounds).toHaveLength(5004);
    const selected = selectors(config);
    expect(selected.length).toBeLessThan(16);
    const members = (config.outbounds as { tag: string }[]).filter((o) =>
      selected.some((p) => o.tag.startsWith(p)),
    );
    expect(members).toHaveLength(5000);
    expect(parseGraph(serializeGraph(graph)).nodes).toHaveLength(6);
  });
  it('shares an internal configuration across groups without duplicating its generated core outbound', () => {
    const sub = subscription(),
      sources = emptyPolicySources();
    sources.manual = [policyProfile(sub.entries[0])];
    sources.fallback = { type: 'node', nodeId: 'test-block' };
    const graph = configure(createPolicyExample(), sources, 'manual'),
      second = makeNode('policy-group', { x: 0, y: 0 }, 'other');
    Object.assign(second.data.settings, {
      tag: 'second',
      selection: 'manual',
      sources: JSON.stringify(sources),
    });
    graph.nodes.push(second);
    const config = compileRuntimeGraph(graph).config;
    expect(config.outbounds).toHaveLength(5);
    expect(
      (config.routing as { balancers: { selector: string[] }[] }).balancers.map((b) => b.selector),
    ).toEqual([selectors(config), selectors(config)]);
  });
  it('remaps internal graph references when a group and its candidate are duplicated together', () => {
    const graph = createPolicyExample();
    graph.nodes.forEach((n) => {
      n.selected = n.id === 'test-group' || n.id === 'test-first';
    });
    const copied = duplicateSelection(graph),
      newGroup = copied.nodes.find((n) => n.data.kind === 'policy-group' && n.id !== 'test-group')!;
    const newOutbound = copied.nodes.find((n) => n.data.settings.tag === 'test-a-2')!;
    expect(readPolicySources(newGroup.data).manual).toEqual([
      { type: 'node', nodeId: newOutbound.id },
      { type: 'node', nodeId: 'test-second' },
    ]);
    expect(readPolicySources(groupNode(copied).data).manual[0]).toEqual({
      type: 'node',
      nodeId: 'test-first',
    });
  });
  it('preserves a native balancer and fallback exactly with only the observatory wire, then supports an internal copied configuration', () => {
    const config = {
      inbounds: [{ tag: 'in', protocol: 'socks', listen: '127.0.0.1', port: 1081 }],
      outbounds: [
        { tag: 'edge-a', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
      ],
      routing: {
        rules: [{ type: 'field', network: 'tcp', balancerTag: 'group' }],
        balancers: [
          {
            tag: 'group',
            selector: ['edge-'],
            strategy: { type: 'leastPing' },
            fallbackTag: 'block',
          },
        ],
      },
      observatory: {
        subjectSelector: ['edge-'],
        probeURL: 'https://example.net/',
        probeInterval: '30s',
      },
    };
    const graph = importXrayConfig(JSON.stringify(config)),
      group = groupNode(graph);
    expect(graph.edges.filter((e) => e.source === group.id).map((e) => e.sourceHandle)).toEqual([
      'observation',
    ]);
    expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
    const sources = structuredClone(readPolicySources(group.data));
    sources.manual = [policyProfile(subscription().entries[0])];
    Object.assign(group.data.settings, { selection: 'manual', sources: JSON.stringify(sources) });
    graph.nodes.find((n) => n.data.kind === 'observatory')!.data.settings.subjects = 'groups';
    expect(selectors(compileXrayGraph(graph).config)).toHaveLength(1);
  });
  it('rejects inconsistent identities and nested manual groups', () => {
    const sub = subscription(),
      ref = policyProfile(sub.entries[0]);
    expect(
      policyProfileId({
        kind: ref.profile.kind,
        settings: { ...ref.profile.settings, tag: 'renamed' },
      }),
    ).toBe(ref.id);
    const sources = emptyPolicySources();
    sources.manual = [ref];
    sources.fallback = { type: 'node', nodeId: 'test-block' };
    const graph = configure(createPolicyExample(), sources, 'manual');
    ref.profile.settings.address = 'tampered.example.net';
    groupNode(graph).data.settings.sources = JSON.stringify(sources);
    expect(() => compileRuntimeGraph(graph)).toThrow(/identity/);
    sources.manual = [{ type: 'node', nodeId: groupNode(graph).id }];
    groupNode(graph).data.settings.sources = JSON.stringify(sources);
    expect(() => compileRuntimeGraph(graph)).toThrow(/cycle/);
  });
});

const core = process.env.WAYRILL_XRAY_TEST_EXE,
  fixtureDir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
describe.skipIf(!core || !fixtureDir)('Pinned core internal policy pools', () => {
  for (const mode of ['manual', 'subscription', 'combined', 'empty-fallback'])
    it(`accepts ${mode} sources without candidate canvas nodes`, () => {
      const sub = subscription(),
        source = subscriptionSource(sub);
      sub.entries[0].profile!.settings.finalFragmentEnabled = true;
      if (mode === 'empty-fallback') source.filter.name = 'no matching name';
      const sources = refreshPolicySources(
        {
          ...emptyPolicySources(),
          manual: sub.entries.slice(0, 1).map((entry) => policyProfile(entry)),
          subscriptions: [source],
          fallback: { type: 'node', nodeId: 'test-block' },
        },
        stash([sub]),
      );
      const graph = configure(
        createPolicyExample('leastPing'),
        sources,
        mode === 'empty-fallback' ? 'subscription' : mode,
      );
      mkdirSync(fixtureDir!, { recursive: true });
      const path = join(fixtureDir!, `policy-internal-${mode}.json`);
      writeFileSync(path, JSON.stringify(compileRuntimeGraph(graph).config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', path], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      writeFileSync(
        join(fixtureDir!, `policy-internal-${mode}.log`),
        `${result.stdout}\n${result.stderr}`,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    });
});

it('updates linked subscription names without changing candidates or executable observation settings', () => {
  const sub = subscription();
  const sources = {
    ...emptyPolicySources(),
    subscriptions: [subscriptionSource(sub)],
    fallback: { type: 'node' as const, nodeId: 'test-block' },
  };
  const graph = refreshPolicyGraph(configure(createPolicyExample(), sources), {
    format: 'wayrill.stash',
    version: 3,

    groups: [sub],
  });
  const previous = readPolicySources(groupNode(graph).data).subscriptions[0];
  const before = compileRuntimeGraph(graph).config;
  const renamed = { ...sub, name: 'Renamed subscription' };
  const refreshed = refreshPolicyGraph(graph, {
    format: 'wayrill.stash',
    version: 3,

    groups: [renamed],
  });
  const next = readPolicySources(groupNode(refreshed).data).subscriptions[0];
  expect(next.groupId).toBe(sub.id);
  expect(next.name).toBe(renamed.name);
  expect(next.entries).toEqual(previous.entries);
  expect(compileRuntimeGraph(refreshed).config).toEqual(before);
});
