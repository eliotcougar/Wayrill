import { expect, it } from 'vitest';
import {
  createContent,
  prepareRestore,
  validateContent,
  graphDependencies,
  type RestoreSelection,
} from './model';
import { makeNode, getOutputPorts } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import {
  parseStash,
  parseEntry,
  serializeStash,
  type Stash,
  type StashGroup,
} from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { readRuleTable, tableSettings } from '../graph/rules';
import {
  attachTrafficSource,
  editSourcedRule,
  refreshTrafficSource,
} from '../graph/trafficRuleSource';
import { parseTrafficRules } from '../graph/trafficRuleImport';
import { readDnsFilter } from '../graph/dns';
import { dnsFilterSettings, newDnsRoute } from '../graph/dns';
import { importDnsRules, editSourcedDnsRule, refreshDnsSource } from '../graph/dnsRuleSource';
import { readPolicySources, policyProfileId } from '../graph/policySources';
import { subscriptionSource } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import type { GraphState } from '../graph/types';
import { createRoutingExample } from '../graph/example';
import { enableDefaults } from '../graph/defaults';

const graph = (): GraphState => ({
  name: 'Backup fixture',
  defaults: factoryDefaults(),
  nodes: [],
  edges: [],
});
const library = (...groups: StashGroup[]): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: [defaultGroup(), ...groups],
});
const provider = (id: string, name = id): StashGroup => ({
  ...defaultGroup(),
  id,
  name,
  url: `https://example.test/${id}`,
  entries: [parseEntry(`socks://127.0.0.1:1080#${name}`)],
});
const selection = (patch: Partial<RestoreSelection> = {}): RestoreSelection => ({
  graph: false,
  stash: false,
  preferences: false,
  filters: false,
  stashMode: 'merge',
  ...patch,
});

it('round trips the complete draft, including disabled inputs, defaults, Unicode and stash metadata', () => {
  const original = enableDefaults(createRoutingExample());
  const inbound = original.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
  inbound.data.enabled = false;
  original.name = 'Home 🦊 / 家';
  const group = provider('provider');
  Object.assign(group.entries[0], { locked: true, starred: true });
  const stash = library(group);
  const content = createContent(
    'full',
    original,
    stash,
    { 'wayrill.appearance.theme': 'dark' },
    [],
  );
  const restored = prepareRestore(
    validateContent(JSON.parse(JSON.stringify(content))),
    selection({ graph: true, stash: true, preferences: true, stashMode: 'replace' }),
    graph(),
    library(),
  );
  expect(restored.graph!.name).toBe(original.name);
  expect(restored.graph!.nodes.find((n) => n.id === inbound.id)?.data.enabled).toBe(false);
  expect(restored.graph!.defaults).toEqual(original.defaults);
  expect(restored.stash!.groups.find((g) => g.id === group.id)?.entries).toEqual(group.entries);
  expect(restored.preferences).toEqual({ 'wayrill.appearance.theme': 'dark' });
});
it('includes complete dynamic pools and follows nested chain references without adding unrelated providers', () => {
  const pool = provider('pool');
  pool.entries.push(parseEntry('socks://127.0.0.1:1081#Second'));
  const stash = library(pool, provider('unrelated'));
  const policy = makeNode('policy-group', { x: 0, y: 0 });
  const sub = subscriptionSource(pool);
  sub.filter.name = 'Second';
  policy.data.settings.sources = JSON.stringify({ version: 1, manual: [], subscriptions: [sub] });
  expect(graphDependencies({ ...graph(), nodes: [policy] }, stash).groups).toEqual([pool]);
  const chain = makeNode('proxy-chain', { x: 0, y: 0 });
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: pool.entries.map((entry, i) => ({
      id: `hop-${i}`,
      outbound: {
        type: 'profile',
        id: policyProfileId(entry.profile!),
        name: entry.name,
        profile: entry.profile,
        source: { groupId: pool.id, entryId: entry.id },
      },
    })),
  });
  const content = createContent('full', { ...graph(), nodes: [chain] }, stash, {}, []);
  const current = structuredClone(pool);
  current.name = 'Existing';
  const restored = prepareRestore(
    content,
    selection({ graph: true, stash: true }),
    graph(),
    library(current),
  );
  const fork = restored.stash!.groups.find((g) => g.name === 'pool (restored)')!;
  const steps = readProxyChain(restored.graph!.nodes.find((n) => n.id === chain.id)!.data).steps;
  expect(
    steps.map((step) => step.outbound.type === 'profile' && step.outbound.source?.groupId),
  ).toEqual([fork.id, fork.id]);
});
it('forks conflicting provider identities and remaps graph, manual members and fallbacks together', () => {
  const saved = provider('shared'),
    current = structuredClone(saved);
  current.entries[0].name = 'Current settings';
  const stash = library(saved),
    source = graph();
  const profile = saved.entries[0].profile!;
  const ref = {
    type: 'profile' as const,
    id: policyProfileId(profile),
    name: 'Pinned',
    profile,
    source: { groupId: saved.id, entryId: saved.entries[0].id },
  };
  const policy = makeNode('policy-group', { x: 0, y: 0 });
  policy.data.settings.sources = JSON.stringify({
    version: 1,
    manual: [ref],
    subscriptions: [],
    fallback: ref,
  });
  source.nodes.push(policy);
  const content = createContent('full', source, stash, {}, []);
  const restored = prepareRestore(
    content,
    selection({ graph: true, stash: true }),
    graph(),
    library(current),
  );
  const fork = restored.stash!.groups.find((g) => g.name === 'shared (restored)')!;
  expect(fork.id).not.toBe(saved.id);
  const sources = readPolicySources(restored.graph!.nodes.find((n) => n.id === policy.id)!.data);
  expect(sources.manual[0]).toMatchObject({
    source: { groupId: fork.id, entryId: saved.entries[0].id },
  });
  expect(sources.fallback).toMatchObject({ source: { groupId: fork.id } });
  expect(restored.stash!.groups.find((g) => g.id === current.id)).toEqual(current);
  expect(parseStash(serializeStash(restored.stash!))).toEqual(restored.stash);
});
it.each(['routing-filter', 'dns-routing-filter'] as const)(
  'restores %s outputs by name, keeps input wires and removes only obsolete output wires',
  (kind) => {
    const source = graph(),
      target = makeNode(kind, { x: 0, y: 0 }, 'target');
    const dns = kind === 'dns-routing-filter';
    target.data.settings.outputs = JSON.stringify(
      dns
        ? [
            { id: 'old', name: 'Keep', fallback: false },
            { id: 'gone', name: 'Gone', fallback: false },
            { id: 'default', name: 'Fallback', fallback: true },
          ]
        : [
            { id: 'old', name: 'Keep' },
            { id: 'gone', name: 'Gone' },
            { id: 'default', name: 'Default' },
          ],
    );
    const destination = makeNode(dns ? 'dns-servers' : 'direct-outbound', { x: 500, y: 0 }, 'out');
    const input = makeNode(dns ? 'dns-handler' : 'proxy-inbound', { x: -500, y: 0 }, 'in');
    source.nodes.push(target, destination, input);
    source.edges = [
      { id: 'kept', source: 'target', sourceHandle: 'old', target: 'out', targetHandle: 'in' },
      { id: 'removed', source: 'target', sourceHandle: 'gone', target: 'out', targetHandle: 'in' },
      {
        id: 'incoming',
        source: 'in',
        sourceHandle: getOutputPorts(input.data.kind, input.data)[0],
        target: 'target',
        targetHandle: 'in',
      },
    ];
    const replacement = structuredClone(target);
    replacement.data.label = 'Restored filter';
    replacement.data.settings.outputs = JSON.stringify(
      dns
        ? [
            { id: 'new', name: 'Keep', fallback: false },
            { id: 'default', name: 'Fallback', fallback: true },
          ]
        : [
            { id: 'new', name: 'Keep' },
            { id: 'default', name: 'Default' },
          ],
    );
    const backup = createContent(
      'filters',
      { ...source, nodes: [replacement], edges: [] },
      library(),
      {},
      ['target'],
    );
    const restored = prepareRestore(
      backup,
      selection({ filters: true, targetId: 'target' }),
      source,
      library(),
    );
    const data = restored.graph!.nodes.find((n) => n.id === target.id)!.data;
    expect(data.label).toBe('Restored filter');
    expect(
      (dns ? readDnsFilter(data.settings) : readRuleTable(data.settings)).outputs.find(
        (o) => o.name === 'Keep',
      )?.id,
    ).toBe('old');
    expect(restored.graph!.nodes.find((n) => n.id === target.id)?.position).toEqual(
      target.position,
    );
    expect(restored.graph!.edges).toEqual([source.edges[0], source.edges[2]]);
  },
);
it('rejects invalid filter contents and unsafe preferences before restoration', () => {
  const content = createContent(
    'filters',
    { ...graph(), nodes: [makeNode('routing-filter', { x: 0, y: 0 }, 'filter')] },
    library(),
    {},
    ['filter'],
  );
  content.filters![0].settings.rules = '[{"enabled":true}]';
  expect(() => validateContent(content)).toThrow();
  expect(() =>
    validateContent({
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      preferences: { 'unrelated.key': 'overwrite' },
    }),
  ).toThrow('preferences');
});

it('preserves DNS source overrides through portable backup, in-place restore and subsequent refresh', () => {
  const source = makeNode('dns-routing-filter', { x: 0, y: 0 }, 'source');
  const upstream = {
    ...readDnsFilter(source.data.settings),
    rules: [{ ...newDnsRoute('default', 'provider'), domains: 'domain:source.test' }],
  };
  const filter = importDnsRules(readDnsFilter(source.data.settings), upstream, {}, 'replace', {
    kind: 'url',
    location: 'https://example.test/dns.json',
    allowHttp: false,
    viaWayrill: false,
  });
  filter.rules[0] = editSourcedDnsRule(filter.rules[0], {
    domains: 'domain:source.test\nfull:mine.test',
    enabled: false,
  });
  Object.assign(source.data.settings, dnsFilterSettings(filter));
  const target = makeNode('dns-routing-filter', { x: 300, y: 0 }, 'target');
  const targetFilter = readDnsFilter(target.data.settings);
  targetFilter.outputs[0].id = 'preserved-fallback';
  Object.assign(target.data.settings, dnsFilterSettings(targetFilter));
  const backup = validateContent(
    JSON.parse(
      JSON.stringify(
        createContent('filters', { ...graph(), nodes: [source] }, library(), {}, [source.id]),
      ),
    ),
  );
  const result = prepareRestore(
    backup,
    selection({ filters: true, targetId: target.id }),
    { ...graph(), nodes: [target] },
    library(),
  );
  const restored = readDnsFilter(result.graph!.nodes[0].data.settings);
  expect(restored.source?.bindings.default).toBe('preserved-fallback');
  expect(restored.rules[0].source?.base.output).toBe('preserved-fallback');
  upstream.rules[0].domains = 'domain:updated.test';
  const updated = refreshDnsSource(restored, upstream, {});
  expect(updated.rules[0]).toMatchObject({
    output: 'preserved-fallback',
    enabled: false,
    domains: 'domain:updated.test\nfull:mine.test',
  });
});

it('preserves source overrides and remaps all output references during in-place filter restore', () => {
  const source = makeNode('routing-filter', { x: 0, y: 0 }, 'source');
  const parse = (domain: string[]) =>
    parseTrafficRules(JSON.stringify([{ id: 'web', domain, outboundTag: 'proxy' }]));
  const table = attachTrafficSource(
    readRuleTable(source.data.settings),
    parse(['one.example']),
    { 'outbound:proxy': 'preferred' },
    'replace',
    {
      kind: 'url',
      location: 'https://example.net/rules',
      allowHttp: false,
      viaWayrill: false,
    },
  );
  table.rules[0] = editSourcedRule(table.rules[0], {
    output: 'default',
    conditions: { domain: 'one.example\nlocal.example' },
  });
  source.data.settings = { ...source.data.settings, ...tableSettings(table) };
  const target = makeNode('routing-filter', { x: 500, y: 0 }, 'target');
  const targetTable = readRuleTable(target.data.settings);
  targetTable.outputs = targetTable.outputs.map((o) => ({ ...o, id: `target-${o.id}` }));
  targetTable.defaultOutput = 'target-default';
  target.data.settings = { ...target.data.settings, ...tableSettings(targetTable) };
  const backup = validateContent(
    JSON.parse(
      JSON.stringify(
        createContent('filters', { ...graph(), nodes: [source] }, library(), {}, [source.id]),
      ),
    ),
  );
  const result = prepareRestore(
    backup,
    selection({ filters: true, targetId: target.id }),
    { ...graph(), nodes: [target] },
    library(),
  );
  const restored = readRuleTable(
    result.graph!.nodes.find((n) => n.id === target.id)!.data.settings,
  );
  expect(restored.source?.bindings['outbound:proxy']).toBe('target-preferred');
  expect(restored.rules[0].source?.base.output).toBe('target-preferred');
  const updated = refreshTrafficSource(restored, parse(['new.example']));
  expect(updated.rules[0].output).toBe('target-default');
  expect(updated.rules[0].conditions.domain).toBe('new.example\nlocal.example');
});
