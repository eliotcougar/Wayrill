import { expect, it } from 'vitest';
import {
  readApplicationIdentity,
  writeApplicationIdentity,
  type PoolApplicationIdentity,
  type PoolApplicationSelector,
} from '../graph/applications';
import { makeNode } from '../graph/catalog';
import { createProxyStarter } from '../graph/examples';
import { parseGraph, serializeGraph } from '../graph/model';
import { readRuleTable, tableSettings } from '../graph/rules';
import { subscriptionEngine } from '../profiles/serviceEngine';
import type { Stash } from '../profiles/import';
import { capturePoolGraph } from './model';
import { validatePublishedGraph } from './validation';
import { resolvePoolDelivery, type PoolDelivery } from './delivery';
import { encodePoolDelivery } from './deliveryCompatibility';

const recipient = '0123456789abcdef0123456789abcdef';
const app: PoolApplicationIdentity = {
  id: 'e2418d69-628a-4a05-a577-459a9af0c423',
  name: 'Example client',
  identities: [
    { kind: 'package', value: 'Wayrill.QA_7a1b2c3d4e5f6' },
    { kind: 'service', value: 'WrQaService' },
  ],
};
const manual = { ...app, identities: [] };
const path = 'D:/Installed Apps/qa-app.exe';
const stash: Stash = { format: 'wayrill.stash', version: 3, groups: [] };

function publication(
  identity: PoolApplicationIdentity,
  name = 'Original',
  targetMatch: 'any' | 'all' = 'all',
) {
  const graph = createProxyStarter();
  const filter = makeNode('routing-filter', { x: 100, y: 0 }, 'filter');
  const block = makeNode('block-outbound', { x: 200, y: 0 }, 'block');
  const item: PoolApplicationSelector = { kind: 'pool', identity, children: true, enabled: true };
  filter.data.settings = tableSettings({
    outputs: [
      { id: 'block', name: 'Block' },
      { id: 'direct', name: 'Direct' },
    ],
    defaultOutput: 'direct',
    rules: [
      {
        id: 'app-rule',
        name: 'Managed app',
        enabled: true,
        matchAll: false,
        conditions: { domain: 'full:pool-qa.example', port: '443' },
        targetMatch,
        output: 'block',
        applications: [item],
      },
    ],
  });
  graph.nodes.push(filter, block);
  graph.edges.find((edge) => edge.sourceHandle === 'data')!.target = filter.id;
  for (const id of ['block', 'direct'])
    graph.edges.push({
      id: 'filter-' + id,
      source: filter.id,
      sourceHandle: id,
      target: id,
      targetHandle: 'in',
    });
  return capturePoolGraph(name, graph, stash, [], ['proxy']);
}

function apply(
  bundle: ReturnType<typeof publication>,
  changes: Parameters<typeof subscriptionEngine>[0]['applicationChanges'] = undefined,
  appliedGraph?: string,
  capture: 'proxy' | 'tun' | 'current' = 'tun',
) {
  const result = subscriptionEngine({
    operation: 'poolPrepare',
    recipient,
    capture,
    stash: '',
    bundle,
    applicationChanges: changes,
    appliedGraph,
  });
  if (!('graph' in result) || !result.graph || !result.config)
    throw new Error('Pool preparation did not return a compiled graph.');
  return result;
}

it('compiles package aliases and service ownership on TUN and keeps a PC binding across a later delivery', () => {
  const original = publication(app);
  expect(() => validatePublishedGraph(original)).not.toThrow();
  const first = apply(original, { [app.id]: { kind: 'process', value: path } });
  const afterRestart = serializeGraph(parseGraph(first.graph!));
  const update = publication(app, 'Updated Pool');
  expect(update.graph).not.toContain(path);
  const refreshed = apply(update, undefined, afterRestart, 'current');
  const graph = parseGraph(refreshed.graph!);
  expect(graph.name).toBe('Updated Pool');
  expect(graph.poolApplicationBindings?.[app.id]).toEqual({ kind: 'process', value: path });
  expect(refreshed.capture?.inputs[0].predicates).toContainEqual([
    {
      kind: 'package',
      value: app.identities[0].value,
      mode: 'name',
      children: true,
      enabled: true,
    },
    {
      kind: 'service',
      value: app.identities[1].value,
      mode: 'name',
      children: false,
      enabled: true,
    },
    { kind: 'process', value: path, mode: 'path', children: true, enabled: true },
  ]);
  const filter = graph.nodes.find(({ id }) => id === 'filter')!;
  expect(readRuleTable(filter.data.settings).rules[0].applications?.[0]).toMatchObject({
    kind: 'pool',
    identity: app,
  });
  const cleared = apply(update, { [app.id]: null }, refreshed.graph, 'current');
  expect(parseGraph(cleared.graph!).poolApplicationBindings).toBeUndefined();
  expect(cleared.capture?.inputs[0].predicates?.flat().some(({ value }) => value === path)).toBe(
    false,
  );
});

it('never treats a missing or unavailable application as a match on the remaining AND conditions', () => {
  const and = publication(manual);
  const or = publication(manual, 'Either', 'any');
  expect(JSON.stringify(apply(and).config.routing)).not.toContain('pool-qa.example');
  expect(JSON.stringify(apply(or).config.routing)).toContain('pool-qa.example');
  expect(
    JSON.stringify(apply(publication(app), undefined, undefined, 'proxy').config.routing),
  ).not.toContain('pool-qa.example');
});

it('blocks local paths in portable identity files', () => {
  expect(readApplicationIdentity(writeApplicationIdentity(app))).toEqual(app);
  const carryingLocalPath = writeApplicationIdentity(app).replace(
    `"kind": "package",\n        "value": "${app.identities[0].value}"`,
    `"kind": "process",\n        "value": "${path}"`,
  );
  expect(() => readApplicationIdentity(carryingLocalPath)).toThrow('local executable paths');
});

it('requires an explicit binding before preparing a delivery marked as required', () => {
  const previous = apply(publication(manual)).graph;
  const required = publication({ ...manual, requireLocal: true });
  expect(() => apply(required, undefined, previous, 'current')).toThrow('Choose “Example client”');
  const applied = apply(
    required,
    { [app.id]: { kind: 'process', value: path } },
    previous,
    'current',
  );
  expect(() => apply(required, { [app.id]: null }, applied.graph, 'current')).toThrow(
    'Choose “Example client”',
  );
});

it('publishes a usable baseline for old clients and restores only supported extensions', () => {
  const table = (bundle: ReturnType<typeof publication>) =>
    readRuleTable(parseGraph(bundle.graph).nodes.find(({ id }) => id === 'filter')!.data.settings);
  const baseline = publication(app);
  const layer = publication(app, 'Alternate filter', 'any');
  const delivery: PoolDelivery = {
    format: 'wayrill.pool.catalog',
    version: 1,
    defaultGraph: 'graph',
    graphs: [{ id: 'graph', bundle: baseline }],
    layers: [
      {
        id: 'optional',
        name: 'Optional filter',
        data: { kind: 'traffic', filter: { nodeId: 'filter', table: table(layer) } },
      },
    ],
    defaultLayers: [],
  };
  const wire = encodePoolDelivery(delivery);
  expect(table(wire.graphs[0].bundle).rules[0]).toMatchObject({ enabled: false, applications: [] });
  const previous = {
    ...wire,
    graphs: wire.graphs.map(({ id, bundle }) => ({ id, bundle })),
    layers: wire.layers.map(({ id, name, data }) => ({ id, name, data })),
  };
  const read = (delivery: PoolDelivery, selectLayer = false) =>
    resolvePoolDelivery(
      delivery,
      selectLayer ? { graph: 'graph', filters: { filter: 'optional' } } : undefined,
    ).bundle;
  expect(table(read(previous, true)).rules[0]).toMatchObject({
    enabled: true,
    applications: [],
    conditions: { domain: 'full:pool-qa.example' },
  });
  expect(table(read(wire)).rules).toEqual(table(baseline).rules);
  expect(table(read(wire, true)).rules[0].applications).toEqual(table(layer).rules[0].applications);
  wire.graphs[0].extensions = { futureCapabilityV2: { unknownShape: [1, 2, 3] } };
  expect(table(read(wire)).rules).toEqual(table(read(previous)).rules);
});
