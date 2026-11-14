// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { readDnsFilter } from '../graph/dns';
import { bundledExamples } from '../graph/examples';
import { parseGraph } from '../graph/model';
import { readRuleTable } from '../graph/rules';
import { parseEntry, parseStash, type Stash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { defaultLayerTarget, type PoolLayer } from './layers';
import { capturePoolBundle, capturePoolStash, poolInputs, preparePoolWorkspace } from './model';
import { prepareMember, type Member, type Publisher } from './publisher';

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
});
