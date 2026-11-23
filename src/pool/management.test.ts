// @vitest-environment node
import { invoke } from '@tauri-apps/api/core';
import { expect, it, vi } from 'vitest';
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
import { reconcileDelivery, recoverDelivery } from './publisher';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

it('recovers delivery status only from the recorded file states and preserves later edits', () => {
  const { user } = fixture();
  const publishing: Member = {
    ...user,
    publication: 3,
    deliveryChanged: true,
    deliveryTransition: {
      phase: 'publishing',
      before: 'old',
      digest: 'new',
      accounts: 'snapshot',
      at: 500,
    },
  };
  const completed = reconcileDelivery(publishing, 'new');
  expect(completed).toMatchObject({
    publication: 3,
    publishedAt: 500,
    publishedAccounts: 'snapshot',
    deliveryChanged: true,
  });
  expect(completed.deliveryTransition).toBeUndefined();
  expect(reconcileDelivery(publishing, 'old')).toMatchObject({
    publication: 3,
    publishedAt: 123,
    deliveryChanged: true,
  });
  expect(() => reconcileDelivery(publishing, 'external')).toThrow('publishing folder');
  const withdrawing: Member = {
    ...completed,
    deliveryTransition: { phase: 'withdrawing', before: 'new' },
  };
  expect(reconcileDelivery(withdrawing, null)).toMatchObject({
    withdrawn: true,
    deliveryTransition: undefined,
  });
  expect(() => reconcileDelivery(withdrawing, 'external')).toThrow('publishing folder');
});

it('resumes rotation on either side of withdrawal using the same new invitation', async () => {
  const { pool, user } = fixture();
  const recipient = 'a'.repeat(32);
  const invite = `wp1.${'b'.repeat(32)}.${'c'.repeat(64)}`;
  const rotating: Member = {
    ...user,
    invite: `wp1.${recipient}.${'d'.repeat(64)}`,
    deliveryTransition: { phase: 'rotating', before: 'old-digest', invite },
  };
  const native = vi.mocked(invoke);
  native.mockResolvedValueOnce('old-digest').mockResolvedValueOnce(undefined);
  const before = await recoverDelivery(pool, rotating);
  expect(native).toHaveBeenLastCalledWith('pool_publish', {
    folder: pool.folder,
    recipient,
    text: null,
    expected: 'old-digest',
  });
  native.mockResolvedValueOnce(null);
  const after = await recoverDelivery(pool, rotating);
  expect(after).toEqual(before);
  expect(after).toMatchObject({ invite, withdrawn: false, publishedAt: undefined });
  expect(deliveryPending(after, [])).toBe(true);
  native.mockResolvedValueOnce('different-file');
  await expect(recoverDelivery(pool, rotating)).rejects.toThrow('publishing folder');
  expect(native.mock.calls.filter(([method]) => method === 'pool_publish')).toHaveLength(1);
});

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
  expect(resumed).toMatchObject({ publication: 3, publishedAt: 123, withdrawn: true });
  expect(mayHaveDelivery(resumed)).toBe(false);
  expect(deliveryPending(resumed, [])).toBe(false);
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
