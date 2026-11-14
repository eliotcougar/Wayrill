// @vitest-environment node
import { expect, it } from 'vitest';
import { generatePoolConnections } from '../../aquifer/src/users/poolConnections';
import type { UserSet } from '../../aquifer/src/users/model';
import { generateServerKeys } from '../../aquifer/src/serverKeys';
import { bundledExamples } from '../graph/examples';
import { parseGraph } from '../graph/model';
import { readRuleTable } from '../graph/rules';
import { parseEntry, parseStash, type Stash } from '../profiles/import';
import { poolFilterTargets, withPoolFilter, withPoolUser } from './exports';
import { capturePoolBundle, poolInputs, preparePoolWorkspace } from './model';

const stash: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
const first = 'bbd46d36-3c68-4d1b-8a7d-64b0161d07a3';
const second = 'cae48d68-866f-4f49-b5e1-25c4b60d5289';
const removed = 'd13ed09b-7f6c-447d-b045-ce4c21c3c96e';

it('exports Aquifer users as isolated Pool routes and excludes server-only keys', async () => {
  const keys = await generateServerKeys(false);
  const userSet: UserSet = {
    id: 'test-set',
    protocol: 'vless',
    name: 'VPN users',
    users: [
      { id: 'first', name: 'First', enabled: true, account: { id: first, email: 'first' } },
      { id: 'second', name: 'Second', enabled: true, account: { id: second, email: 'second' } },
      { id: 'removed', name: 'Disabled', enabled: false, account: { id: removed } },
    ],
  };
  const settings = await generatePoolConnections(
    userSet,
    {
      protocol: 'vless',
      settings: { clients: [], decryption: 'none' },
      streamSettings: {
        network: 'raw',
        security: 'reality',
        realitySettings: {
          privateKey: keys.privateKey,
          serverNames: ['sni.example.test'],
          shortIds: ['78ab'],
        },
      },
    },
    'public.example.test',
    8443,
    '',
  );
  const transfer = JSON.stringify(settings);
  expect(transfer).not.toContain(keys.privateKey);
  expect(transfer).not.toContain(removed);
  expect(transfer).toContain(keys.publicKey);
  const [a, b] = settings.users;
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const saved = capturePoolBundle('Managed', graph, stash, [], poolInputs(graph)[0].id);
  const template = parseEntry('socks://template:private-template-secret@gateway.example.test:1080');
  const hidden = parseEntry('socks://127.0.0.1:24000#Unrelated');
  const main = graph.nodes.find((node) => node.id === graph.mainOutboundId)!;
  main.data.stashLink = { groupId: 'templates', entryId: template.id };
  const linked = capturePoolBundle(
    'Managed',
    graph,
    {
      ...stash,
      groups: [
        {
          id: 'templates',
          name: 'Templates',
          url: '',
          headers: {},
          userAgent: '',
          allowHttp: false,
          updatedAt: null,
          entries: [template, hidden],
        },
      ],
    },
    [],
    poolInputs(graph)[0].id,
  );
  expect(parseStash(linked.stash).groups[0].entries.map((entry) => entry.id)).toEqual([
    template.id,
  ]);
  const personalA = withPoolUser(linked, 'member-a', a);
  expect(JSON.stringify(personalA)).not.toContain('private-template-secret');
  const personalB = withPoolUser(saved, 'member-b', b);
  for (const [bundle, included, excluded] of [
    [personalA, first, second],
    [personalB, second, first],
  ] as const) {
    const ready = preparePoolWorkspace(
      bundle,
      undefined,
      stash,
      '0123456789abcdef0123456789abcdef',
      'proxy',
    );
    const node = ready.graph.nodes.find((item) => item.id === ready.graph.mainOutboundId)!;
    expect(node.data.settings.id).toBe(included);
    expect(node.data.settings.address).toBe('public.example.test');
    expect(ready.stash.groups[0].entries[0].profile?.settings.id).toBe(included);
    expect(JSON.stringify(bundle)).not.toContain(excluded);
  }
  expect(parseStash(saved.stash).groups).toHaveLength(0);
});

it('exports edited filter rules while preserving Pool output wiring', () => {
  const graph = bundledExamples.find((item) => item.id === 'traffic')!.create();
  const saved = capturePoolBundle('Managed', graph, stash, [], poolInputs(graph)[0].id);
  const node = graph.nodes.find((item) => item.data.kind === 'routing-filter')!;
  const table = readRuleTable(node.data.settings);
  table.rules[0] = { ...table.rules[0], name: 'Delivered update' };
  const source = { nodeId: node.id, table };
  const result = parseGraph(withPoolFilter(saved, source, node.id).graph);
  expect(
    readRuleTable(result.nodes.find((item) => item.id === node.id)!.data.settings).rules[0].name,
  ).toBe('Delivered update');
  expect(result.edges).toEqual(parseGraph(saved.graph).edges);
  expect(poolFilterTargets(saved, { nodeId: node.id, table: { ...table, outputs: [] } })).toEqual(
    [],
  );
});
