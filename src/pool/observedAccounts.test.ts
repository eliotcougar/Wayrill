// @vitest-environment node
import { expect, it } from 'vitest';
import { observedPoolAccounts } from '../../aquifer/src/users/observedPoolAccounts';
import { bundledExamples } from '../graph/examples';
import { parseGraph } from '../graph/model';
import { parseStash } from '../profiles/import';
import { accountKey, accountRevision, withObservedAccounts } from './accounts';
import { openGraphLayer, newPoolStash } from './graphLayer';
import { capturePoolBundle, capturePoolGraph, poolInputs } from './model';
import { createProxyStarter } from '../graph/examples';

it('uses the latest observed server and sends only assigned accounts', async () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const bundle = capturePoolBundle('Base', graph, newPoolStash(), [], poolInputs(graph)[0].id);
  const server = {
    id: 'test',
    name: 'Fixture',
    host: 'server.example.test',
    port: 22,
    user: 'admin',
  };
  const snapshot = (port: number, reverse = false) => {
    const clients = [
      { id: 'alice-fixture-id', email: 'Alice' },
      { id: 'bob-fixture-id', email: 'Bob' },
    ];
    if (reverse) clients.reverse();
    return {
      path: '/etc/xray/config.json',
      text: JSON.stringify({
        inbounds: [{ tag: 'edge', protocol: 'vless', port, settings: { clients } }],
      }),
      sha256: '',
      bytes: 0,
    };
  };
  const old = await observedPoolAccounts(server, snapshot(443));
  const latest = await observedPoolAccounts(server, snapshot(8443, true));
  expect(latest.id).toBe(old.id);
  expect(latest.accounts).toHaveLength(2);
  const ref = { server: old.id, account: old.accounts[0].id };
  expect(accountRevision([old], [ref])).not.toBe(accountRevision([latest], [ref]));
  const extra = { ...latest, id: 'second-server', name: 'Second endpoint' };
  const secondRef = {
    server: extra.id,
    account: latest.accounts.find((item) => item.name === 'Alice')!.id,
    host: 'public.example.test',
    port: 9443,
  };
  const delivered = withObservedAccounts(
    bundle,
    'member',
    [latest, extra],
    [ref, secondRef],
    accountKey(ref),
  );
  const recipient = parseGraph(delivered.graph);
  expect(
    recipient.nodes.find((node) => node.id === recipient.mainOutboundId)?.data.settings.port,
  ).toBe(8443);
  const users = parseStash(delivered.stash).groups.flatMap((group) => group.entries);
  expect(
    users.map((item) => [item.profile?.settings.address, item.profile?.settings.port]),
  ).toEqual([
    ['server.example.test', 8443],
    ['public.example.test', 9443],
  ]);
  expect(JSON.stringify(delivered)).not.toContain('bob-fixture-id');
  expect(() =>
    withObservedAccounts(bundle, 'member', [{ ...latest, accounts: [] }], [ref]),
  ).toThrow('account is missing');
});

it('preserves legacy route roles as editable Pool placeholders', () => {
  const base = createProxyStarter();
  const capture = capturePoolBundle('Base', base, newPoolStash(), [], poolInputs(base)[0].id);
  const direct = capture.routes.data!;
  for (const routes of [
    { data: direct, dns: direct, sharing: direct, 'nat-data': direct, 'nat-dns': direct },
    { data: direct, 'encrypted-dns': direct },
  ]) {
    const editor = openGraphLayer({ ...capture, routes });
    const saved = capturePoolGraph('Edited', editor.graph, editor.stash, []);
    const graph = parseGraph(saved.graph);
    expect(saved.version).toBe(2);
    expect(graph.nodes.filter((node) => node.data.kind === 'inbound-placeholder')).toHaveLength(
      routes.sharing ? 2 : 1,
    );
    expect(graph.edges).toHaveLength(Object.keys(routes).length);
    expect(graph.edges.every((edge) => edge.target === direct)).toBe(true);
  }
});
