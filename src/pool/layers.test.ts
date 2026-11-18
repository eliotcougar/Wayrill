// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { readDnsFilter } from '../graph/dns';
import { bundledExamples } from '../graph/examples';
import { parseGraph } from '../graph/model';
import { readRuleTable } from '../graph/rules';
import { parseEntry, parseStash, serializeStash, type Stash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { defaultLayerTarget, type PoolLayer } from './layers';
import {
  capturePoolBundle,
  capturePoolGraph,
  capturePoolStash,
  poolInputs,
  preparePoolWorkspace,
} from './model';
import { prepareMember, type Member, type Publisher } from './publisher';
import { putLayer, removeLayer } from './management';
import { addLinkedFilterPorts, resolveGraphLinks } from './graphLinks';

it('composes a delivery per user and keeps the base graph wiring and other users intact', () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const traffic = graph.nodes.find((node) => node.data.kind === 'routing-filter')!;
  const dns = makeNode('dns-routing-filter', { x: 0, y: 300 }, 'test-dns');
  const handler = makeNode('dns-handler', { x: 0, y: 0 }, 'handler');
  const resolver = makeNode('dns-servers', { x: 0, y: 0 }, 'resolver');
  graph.nodes.push(dns, handler, resolver);
  const wire = (source: string, sourceHandle: string, target: string) => ({
    id: `${source}-${sourceHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  });
  graph.edges = graph.edges.filter(
    ({ source, sourceHandle }) => source !== 'proxy' || sourceHandle !== 'dns',
  );
  graph.edges.push(
    wire('proxy', 'dns', handler.id),
    wire(handler.id, 'resolver', dns.id),
    wire(dns.id, readDnsFilter(dns.data.settings).outputs[0].id, resolver.id),
    wire(resolver.id, 'queries', 'direct'),
  );
  const table = readRuleTable(traffic.data.settings);
  const filter = { ...readDnsFilter(dns.data.settings), parallel: true };
  table.defaultOutput =
    table.outputs.find((output) => output.id !== table.defaultOutput)?.id ?? table.defaultOutput;

  const entry = parseEntry('socks://selected.example.test:1080');
  const library: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: [
      {
        ...defaultGroup(),
        id: 'servers',
        name: 'Servers',
        entries: [entry],
        url: 'https://private.example.test',
      },
    ],
  };
  const base = capturePoolBundle('Base', graph, library, [], poolInputs(graph)[0].id);
  const layers: PoolLayer[] = [
    {
      id: 'traffic',
      name: 'Traffic rules',
      data: { kind: 'traffic', filter: { nodeId: traffic.id, table } },
    },
    { id: 'dns', name: 'DNS rules', data: { kind: 'dns', nodeId: dns.id, filter } },
    {
      id: 'servers',
      name: 'Server list',
      data: { kind: 'stash', stash: capturePoolStash(library, ['servers']) },
    },
  ];
  const pool: Publisher = {
    id: 'qa',
    name: 'Test',
    folder: 'C:\\Pool',
    configurations: [{ id: 'base', bundle: base }],
    members: [],
    layers,
  };
  const plain: Member = { id: 'plain', name: 'Plain', configurationId: 'base', invite: '' };
  const personalized = prepareMember(pool, {
    ...plain,
    id: 'with-layers',
    assignments: layers.map((layer) => ({
      id: layer.id,
      target: defaultLayerTarget(base, layer.data),
    })),
  });
  const result = parseGraph(personalized.graph);
  expect(result.edges).toEqual(parseGraph(base.graph).edges);
  expect(
    readRuleTable(result.nodes.find((node) => node.id === traffic.id)!.data.settings).defaultOutput,
  ).toBe(table.defaultOutput);
  expect(
    readDnsFilter(result.nodes.find((node) => node.id === dns.id)!.data.settings).parallel,
  ).toBe(true);
  expect(parseStash(personalized.stash).groups[0].entries[0].id).toBe(entry.id);
  expect(personalized.stash).not.toContain('private.example.test');
  expect(prepareMember(pool, plain)).toEqual(base);
  const recipient = preparePoolWorkspace(
    personalized,
    undefined,
    { ...library, groups: [] },
    '0123456789abcdef0123456789abcdef',
    'tun',
  );
  expect(recipient.stash.groups[0].name).toBe('Pool · Servers');
  expect(() =>
    prepareMember(pool, {
      ...plain,
      assignments: [
        { id: 'traffic', target: traffic.id },
        { id: 'traffic', target: traffic.id },
      ],
    }),
  ).toThrow('one layer for each destination');
  expect(() =>
    prepareMember(pool, { ...plain, assignments: [{ id: 'dns', target: traffic.id }] }),
  ).toThrow('compatible destination');
  const dedicated = capturePoolGraph('Linked DNS', graph, library, [], [poolInputs(graph)[0].id]);
  const linked = { ...dedicated, linkedLayers: [{ id: 'dns', target: dns.id }] };
  const parallel = (layer: ReturnType<typeof resolveGraphLinks>) =>
    readDnsFilter(parseGraph(layer.graph).nodes.find(({ id }) => id === dns.id)!.data.settings)
      .parallel;
  expect(parallel(resolveGraphLinks(linked, layers))).toBe(true);
  expect(
    parallel(
      resolveGraphLinks(linked, [
        {
          ...layers[1],
          data: { kind: 'dns', nodeId: dns.id, filter: { ...filter, parallel: false } },
        },
      ]),
    ),
  ).toBe(false);
});

it('publishes current graph-linked layers, keeps two default Stash groups distinct, and marks affected users', () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const filter = graph.nodes.find((node) => node.data.kind === 'routing-filter')!;
  const authored = readRuleTable(filter.data.settings);
  const extraOutput = { id: 'other-path', name: 'Another path' };
  const rules = { ...authored, outputs: [...authored.outputs, extraOutput] };
  const traffic: PoolLayer = {
    id: 'rules',
    name: 'Shared traffic rules',
    data: { kind: 'traffic', filter: { nodeId: 'source-node', table: rules } },
  };
  const from = (address: string, id: string) => ({
    ...parseEntry(`socks://${address}:1080`),
    id,
  });
  const stashText = (...entries: ReturnType<typeof from>[]) =>
    serializeStash({
      format: 'wayrill.stash',
      version: 3,
      groups: [{ ...defaultGroup(), entries }],
    });
  const primary = from('first.example.test', 'server');
  const secondary = from('second.example.test', 'server');
  const stashes: PoolLayer[] = [
    { id: 'first', name: 'First Stash', data: { kind: 'stash', stash: stashText(primary) } },
    { id: 'second', name: 'Second Stash', data: { kind: 'stash', stash: stashText(secondary) } },
  ];
  const links = [{ id: traffic.id, target: filter.id }, ...stashes.map(({ id }) => ({ id }))];
  const layers = [traffic, ...stashes];
  const withPorts = addLinkedFilterPorts(graph, layers, links);
  expect(withPorts.edges).toEqual(graph.edges);
  expect(
    readRuleTable(withPorts.nodes.find(({ id }) => id === filter.id)!.data.settings).outputs,
  ).toContainEqual(extraOutput);
  const base = capturePoolGraph(
    'Shared',
    withPorts,
    parseStash(stashText()),
    [],
    poolInputs(graph).map(({ id }) => id),
  );
  const bundle = { ...base, linkedLayers: links };
  const member = { id: 'alice', name: 'Alice', configurationId: 'shared', invite: '' };
  const other = { ...member, id: 'bob', name: 'Bob', configurationId: 'independent' };
  const pool: Publisher = {
    id: 'pool',
    name: 'Test',
    folder: 'C:\\Pool',
    layers,
    members: [member, other],
    configurations: [
      { id: 'shared', bundle },
      { id: 'independent', bundle: base },
    ],
  };
  const entries = (value: ReturnType<typeof prepareMember>) =>
    parseStash(value.stash).groups.filter(({ entries }) => entries.length);
  const initial = prepareMember(pool, member);
  const firstGroups = entries(initial);
  expect(firstGroups.map(({ entries }) => entries[0].address)).toEqual([
    'first.example.test',
    'second.example.test',
  ]);
  expect(new Set(firstGroups.map(({ id }) => id)).size).toBe(2);
  expect(entries(prepareMember(pool, other))).toEqual([]);
  expect('linkedLayers' in initial).toBe(false);
  const updated = putLayer(pool, 'first', {
    kind: 'stash',
    name: 'First Stash',
    stash: stashText(from('updated.example.test', primary.id)),
  });
  expect(updated.members.map(({ deliveryChanged }) => !!deliveryChanged)).toEqual([true, false]);
  expect(
    entries(prepareMember(updated, member)).map(({ id, entries }) => [id, entries[0].address]),
  ).toEqual([
    [firstGroups[0].id, 'updated.example.test'],
    [firstGroups[1].id, 'second.example.test'],
  ]);
  const nextRule = { ...rules.rules[0], name: 'Updated shared rule' };
  const trafficUpdated = putLayer(updated, 'rules', {
    kind: 'traffic',
    name: traffic.name,
    filter: { nodeId: 'source-node', table: { ...rules, rules: [nextRule] } },
  });
  const effectiveFilter = parseGraph(prepareMember(trafficUpdated, member).graph).nodes.find(
    ({ id }) => id === filter.id,
  )!;
  expect(readRuleTable(effectiveFilter.data.settings).rules[0].name).toBe(nextRule.name);
  expect(() => removeLayer(updated, 'first')).toThrow('Unlink');
  const lost = { ...bundle, linkedLayers: [{ id: 'missing' }] };
  expect(() => resolveGraphLinks(lost, layers)).toThrow('linked layer is unavailable');
});
