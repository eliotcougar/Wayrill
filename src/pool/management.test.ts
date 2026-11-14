// @vitest-environment node
import { expect, it } from 'vitest';
import { bundledExamples } from '../graph/examples';
import { readRuleTable } from '../graph/rules';
import { parseTransfer, type PoolTransfer } from './layers';
import { capturePoolBundle, poolInputs } from './model';
import {
  deliveryPending,
  getLayer,
  mayHaveDelivery,
  putLayer,
  removeLayer,
  reserveDelivery,
  setLayerUsers,
} from './management';
import type { Member, Publisher } from './publisher';

function fixture() {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const filter = graph.nodes.find((node) => node.data.kind === 'routing-filter')!;
  const input = poolInputs(graph)[0].id;
  const bundle = capturePoolBundle(
    'Base',
    graph,
    { format: 'wayrill.stash', version: 3, groups: [] },
    [],
    input,
  );
  const layer: PoolTransfer = {
    name: 'Override',
    kind: 'traffic',
    filter: { nodeId: filter.id, table: readRuleTable(filter.data.settings) },
  };
  const user: Member = {
    id: 'alice',
    name: 'Alice',
    configurationId: 'base',
    invite: 'fixture',
    publishedAt: 123,
    publication: 2,
  };
  const pool: Publisher = {
    id: 'pool',
    name: 'Pool',
    folder: 'C:\\Pool',
    configurations: [
      { id: 'base', bundle },
      { id: 'second', bundle },
    ],
    members: [user, { ...user, id: 'bob' }],
  };
  return { pool: putLayer(pool, 'filter', layer), filter, layer, user };
}

it('keeps the last delivery when bulk assigning, detaching and replacing layers', () => {
  const { pool, filter } = fixture();
  const assigned = setLayerUsers(pool, 'filter', new Map([['alice', filter.id]]));
  expect(assigned.members[0]).toMatchObject({
    publishedAt: 123,
    deliveryChanged: true,
    assignments: [{ id: 'filter', target: filter.id }],
  });
  expect(assigned.members[1]).toBe(pool.members[1]);
  const replacement = removeLayer(assigned, 'base', 'second');
  expect(replacement.members[0]).toMatchObject({
    configurationId: 'second',
    assignments: [{ id: 'filter', target: filter.id }],
  });
  const removed = removeLayer(replacement, 'filter');
  expect(removed.members[0]).toMatchObject({ publishedAt: 123, assignments: [] });
  const unassigned = removeLayer(removed, 'second').members[0];
  expect(unassigned.configurationId).toBe('');
  expect(deliveryPending(unassigned, [])).toBe(true);
  expect(mayHaveDelivery(unassigned)).toBe(true);
  expect(deliveryPending({ ...unassigned, withdrawn: true }, [])).toBe(false);
  expect(mayHaveDelivery({ ...unassigned, withdrawn: true })).toBe(false);
  expect(reserveDelivery(unassigned).publishedAt).toBe(123);
  const resumed = reserveDelivery({ ...unassigned, withdrawn: true });
  expect(resumed).toMatchObject({ publication: 3, publishedAt: undefined, withdrawn: false });
  expect(mayHaveDelivery(resumed)).toBe(true);
  expect(deliveryPending(resumed, [])).toBe(true);
});

it('rejects malformed saved layer files before they can replace a layer', () => {
  const { pool, layer } = fixture();
  const graph = getLayer(pool, 'base')!;
  expect(parseTransfer(JSON.stringify(graph))).toEqual(graph);
  if (graph.kind !== 'graph' || layer.kind !== 'traffic') throw new Error('Unexpected fixture');
  expect(() =>
    parseTransfer(
      JSON.stringify({ ...graph, bundle: { ...graph.bundle, routes: { data: 'missing' } } }),
    ),
  ).toThrow('valid entry path');
  expect(() =>
    parseTransfer(
      JSON.stringify({
        ...layer,
        filter: { ...layer.filter, table: { ...layer.filter.table, defaultOutput: 'missing' } },
      }),
    ),
  ).toThrow('existing default output');
});
