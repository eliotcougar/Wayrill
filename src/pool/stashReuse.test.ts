// @vitest-environment node
import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { emptyPolicySources, policyProfile, readPolicySources } from '../graph/policySources';
import { readProxyChain } from '../graph/proxyChains';
import { factoryDefaults } from '../graph/defaults';
import { entryCredentials, applyStashCredentials } from '../profiles/stashCredentials';
import { replaceStashServer, transferStashEntries } from '../profiles/stashTransfer';
import { snapshotGraphEntry, stashEditorNode } from '../profiles/workspace';
import { parseGraph } from '../graph/model';
import { cachedAccountStash } from './accounts';
import { parseStash, serializeStash, type Stash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { serverEntry } from './exports';
import { copyLayer, withPrivateStashes } from './copy';
import { openGraphLayer } from './graphLayer';
import { capturePoolGraph } from './model';
import { prepareMember, type Member, type Publisher } from './publisher';

function fixture() {
  const server = {
    ...serverEntry('Server', {
      protocol: 'vless',
      settings: {
        address: 'relay.example.test',
        port: 443,
        id: 'original-account',
        encryption: 'none',
      },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: { serverName: 'front.example.test' },
        xhttpSettings: { path: '/relay' },
      },
    }),
    id: 'server',
  };
  const policy = makeNode('policy-group', { x: 0, y: 0 }, 'policy');
  policy.data.settings.sources = JSON.stringify({
    ...emptyPolicySources(),
    manual: [policyProfile(server, { groupId: 'servers', entryId: server.id })],
  });
  const graph = { name: 'Fixture', nodes: [policy], edges: [], defaults: factoryDefaults() };
  const group = snapshotGraphEntry(graph, policy, 'policy');
  expect(group.problem).toBe('');
  const chain = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
  chain.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'first', outbound: policyProfile(group, { groupId: 'prepared', entryId: group.id }) },
      {
        id: 'second',
        outbound: policyProfile(
          serverEntry('Hop', {
            protocol: 'socks',
            settings: { address: 'hop.example.test', port: 1080 },
          }),
        ),
      },
    ],
  });
  const chained = snapshotGraphEntry({ ...graph, nodes: [...graph.nodes, chain] }, chain, 'chain');
  expect(chained.problem).toBe('');
  const source: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: [
      {
        ...defaultGroup(),
        id: 'servers',
        entries: [
          server,
          {
            ...server,
            id: 'unrelated',
            name: 'Other user',
            profile: {
              ...server.profile!,
              settings: { ...server.profile!.settings, id: 'other-account' },
            },
          },
        ],
      },
      { ...defaultGroup(), id: 'prepared', entries: [group, chained] },
    ],
  };
  return { source, server, group, chained };
}

it('copies a chain with its dependencies, remaps collisions and propagates credential changes through every hop', () => {
  const { source, server } = fixture();
  source.groups[1].entries = source.groups[1].entries.map((entry) => ({ ...entry, locked: true }));
  const target = {
    ...source,
    groups: [{ ...source.groups[0], entries: [{ ...server, id: 'existing' }] }],
  };
  const { stash } = transferStashEntries(
    target,
    source,
    [{ groupId: 'prepared', entryId: 'chain' }],
    false,
  );
  const imported = stash.groups.find(
    (group) => group.id !== 'servers' && group.entries.some((entry) => entry.id === 'server'),
  )!;
  expect(imported).toBeDefined();
  expect(imported.entries.map((entry) => entry.id)).toEqual(['server']);
  expect(
    stash.groups.flatMap((group) => group.entries).some((entry) => entry.id === 'unrelated'),
  ).toBe(false);
  const original = imported.entries[0];
  const fields = entryCredentials(original).fields.map((field) => ({
    ...field,
    value: 'new-account',
  }));
  const edited = applyStashCredentials(stash, [
    { entry: original, link: { groupId: imported.id, entryId: original.id }, fields },
  ]);
  const chain = edited.groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.id === 'chain')!;
  expect(chain.locked).toBe(true);
  const hop = readProxyChain({ ...chain.profile!, label: '', description: '' }).steps[0].outbound;
  expect(hop.type).toBe('profile');
  if (hop.type !== 'profile') throw new Error('Expected a copied profile');
  const manual = readPolicySources({ ...hop.profile, label: '', description: '' }).manual[0];
  expect(manual.type).toBe('profile');
  if (manual.type !== 'profile') throw new Error('Expected a copied member');
  expect(manual.source?.groupId).toBe(imported.id);
  expect(manual.profile.settings.id).toBe('new-account');
  const outbound = entryCredentials(
    edited.groups.find((group) => group.id === imported.id)!.entries[0],
  ).outbound;
  expect(outbound.streamSettings).toEqual(entryCredentials(original).outbound.streamSettings);
  expect(parseStash(serializeStash(edited)).groups).toHaveLength(3);
  expect(source.groups[0].entries[0].profile!.settings.id).toBe('original-account');
});

it('refuses a move that breaks the source and removes only explicitly moved entries after a valid move', () => {
  const { source } = fixture();
  const target = { ...source, groups: [] };
  expect(() =>
    transferStashEntries(target, source, [{ groupId: 'servers', entryId: 'server' }], true),
  ).toThrow('still used');
  const result = transferStashEntries(
    target,
    source,
    [{ groupId: 'prepared', entryId: 'chain' }],
    true,
  );
  expect(result.source.groups[1].entries.map((entry) => entry.id)).toEqual(['policy']);
  expect(result.source.groups[0].entries).toHaveLength(2);
  expect(source.groups[1].entries).toHaveLength(2);
});

it('rejects invalid credential batches without modifying the original Stash', () => {
  const { source } = fixture();
  const before = serializeStash(source);
  expect(() =>
    applyStashCredentials(
      source,
      source.groups[0].entries.map((entry, index) => ({
        entry,
        link: { groupId: 'servers', entryId: entry.id },
        fields: entryCredentials(entry).fields.map((field) => ({
          ...field,
          value: index ? '' : 'valid-account',
        })),
      })),
    ),
  ).toThrow();
  expect(serializeStash(source)).toBe(before);
});

it('creates independent per-user Stashes while preserving optional defaults and source assignments', () => {
  const { source, server } = fixture();
  const editor = openGraphLayer();
  const direct = editor.graph.nodes.find((node) => node.data.kind === 'direct-outbound')!;
  const routed = stashEditorNode(server, editor.graph, direct.id);
  routed.data.stashLink = { groupId: 'servers', entryId: server.id };
  editor.graph.nodes = editor.graph.nodes.map((node) => (node.id === direct.id ? routed : node));
  const bundle = capturePoolGraph('Base', editor.graph, source, []);
  const alice: Member = {
    id: 'alice',
    name: 'Alice',
    invite: '',
    configurationId: 'base',
    layerIds: ['shared', 'optional'],
    assignments: [{ id: 'shared' }],
  };
  const pool: Publisher = {
    id: 'pool',
    name: 'Pool',
    folder: 'C:/Pool',
    configurations: [{ id: 'base', bundle }],
    members: [alice],
    layers: ['shared', 'optional'].map((id) => ({
      id,
      name: id,
      data: { kind: 'stash', stash: serializeStash(source) },
    })),
  };
  const bob = { ...alice, id: 'bob', name: 'Bob' };
  const copied = withPrivateStashes(pool, bob);
  expect(copied.member.deliveryChanged).toBe(true);
  expect(copied.pool.members[0]).toEqual(alice);
  expect(copied.member.layerIds).toHaveLength(2);
  expect(copied.member.layerIds).not.toContain('shared');
  expect(copied.member.assignments).toHaveLength(1);
  const bobStash = copied.pool.layers!.find(
    (layer) => layer.id === copied.member.assignments![0].id,
  )!;
  expect(bobStash.name).toBe('Bob · shared');
  if (bobStash.data.kind !== 'stash') throw new Error('Expected a Stash');
  const servers = parseStash(bobStash.data.stash);
  const entry = servers.groups[0].entries[0];
  const changed = applyStashCredentials(servers, [
    {
      entry,
      link: { groupId: 'servers', entryId: 'server' },
      fields: entryCredentials(entry).fields.map((field) => ({ ...field, value: 'bob-account' })),
    },
  ]);
  bobStash.data.stash = serializeStash(changed);
  const bobDelivery = prepareMember(copied.pool, copied.member);
  expect(bobDelivery.stash).toContain('bob-account');
  expect(
    parseGraph(bobDelivery.graph).nodes.find((node) => node.id === direct.id)!.data.settings.id,
  ).toBe('bob-account');
  expect(prepareMember(pool, alice).stash).not.toContain('bob-account');
  expect(copyLayer(pool, 'shared', 'Another').pool.layers).toHaveLength(3);
  const linked = withPrivateStashes(
    {
      ...pool,
      configurations: [
        { id: 'base', bundle: { ...bundle, version: 3, linkedLayers: [{ id: 'shared' }] } },
      ],
    },
    { ...bob, layerIds: [], assignments: [] },
  );
  expect(linked.member.assignments).toHaveLength(1);
  expect(linked.member.assignments![0].id).not.toBe('shared');
  expect(prepareMember(linked.pool, linked.member).stash).toContain('original-account');
});

it('imports only selected cached Aquifer accounts and omits previously imported accounts', () => {
  const empty: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
  const accounts = ['Alice', 'Bob'].map((name) => ({
    id: name,
    name,
    inbound: 'VLESS',
    revision: '1',
    outbound: {
      protocol: 'vless',
      settings: { address: 'relay.example.test', port: 443, id: name, encryption: 'none' },
    },
  }));
  const servers = [
    {
      id: 'cached',
      name: 'Cached',
      host: 'relay.example.test',
      path: '/etc/xray/config.json',
      accounts,
      skipped: [],
    },
  ];
  const cached = cachedAccountStash(servers, empty);
  const alice = cached.groups[0].entries[0];
  const imported = transferStashEntries(
    empty,
    cached,
    [{ groupId: cached.groups[0].id, entryId: alice.id }],
    false,
  ).stash;
  expect(imported.groups[0].entries).toHaveLength(1);
  expect(imported.groups[0].entries[0].profile!.settings.id).toBe('Alice');
  const remaining = cachedAccountStash(servers, imported);
  expect(remaining.groups[0].entries.map((entry) => entry.profile!.settings.id)).toEqual(['Bob']);
});

it('replaces a server with a cached account in place and rejects an obsolete edit', () => {
  const { source, server, group } = fixture();
  const sources = readPolicySources({ ...group.profile!, label: '', description: '' });
  const frozen = {
    ...group,
    id: 'frozen',
    locked: true,
    profile: {
      ...group.profile!,
      settings: {
        ...group.profile!.settings,
        sources: JSON.stringify({
          ...sources,
          manual: sources.manual.map((ref) =>
            ref.type === 'profile'
              ? { ...ref, source: { groupId: 'untouched', entryId: server.id } }
              : ref,
          ),
        }),
      },
    },
  };
  source.groups.push({
    ...defaultGroup(),
    id: 'untouched',
    entries: [
      {
        ...server,
        profile: {
          ...server.profile!,
          settings: { ...server.profile!.settings, id: 'later-account' },
        },
      },
      frozen,
    ],
  });
  const replacement = serverEntry('Aquifer user', {
    protocol: 'vless',
    settings: { address: 'new.example.test', port: 8443, id: 'new-user', encryption: 'none' },
  });
  const target = { entry: server, link: { groupId: 'servers', entryId: server.id } };
  const result = replaceStashServer(source, target, replacement);
  expect(result.groups[2].entries[1]).toBe(frozen);
  const edited = result.groups[0].entries[0];
  expect([edited.name, edited.id]).toEqual([server.name, server.id]);
  expect(edited.profile!.settings.id).toBe('new-user');
  const policy = result.groups[1].entries.find((entry) => entry.id === 'policy')!;
  expect(JSON.stringify(policy.profile)).toContain('new-user');
  expect(JSON.stringify(policy.profile)).not.toContain('original-account');
  expect(() => replaceStashServer(result, target, replacement)).toThrow('changed while editing');
  expect(source.groups[0].entries[0].profile!.settings.address).toBe('relay.example.test');
});

it('edits native-protocol account fields without losing transport settings or sibling credentials', () => {
  const cases = [
    {
      protocol: 'socks',
      settings: {
        address: 'relay.example.test',
        port: 1080,
        user: 'old-user',
        pass: 'old-password',
      },
    },
    {
      protocol: 'trojan',
      settings: { address: 'relay.example.test', port: 443, password: 'old-password' },
    },
    {
      protocol: 'vmess',
      settings: {
        address: 'relay.example.test',
        port: 443,
        id: '00000000-0000-4000-8000-000000000001',
        security: 'auto',
      },
    },
    {
      protocol: 'shadowsocks',
      settings: {
        address: 'relay.example.test',
        port: 443,
        method: 'aes-128-gcm',
        password: 'old-password',
      },
    },
  ];
  for (const value of cases) {
    let entry = serverEntry(value.protocol, {
      ...value,
      streamSettings: {
        network: 'ws',
        security: 'tls',
        tlsSettings: { serverName: 'front.example.test' },
        wsSettings: { path: '/relay' },
      },
    });
    const context = { name: 'Editor', nodes: [], edges: [], defaults: factoryDefaults() };
    const node = stashEditorNode(entry, context, entry.id);
    node.data.description = 'Keep this server note';
    entry = snapshotGraphEntry({ ...context, nodes: [node] }, node, entry.id, entry);
    const source: Stash = {
      format: 'wayrill.stash',
      version: 3,
      groups: [{ ...defaultGroup(), entries: [entry] }],
    };
    const before = entryCredentials(entry);
    expect(before.fields.length).toBeGreaterThan(0);
    const field = before.fields.at(-1)!;
    const changed =
      value.protocol === 'vmess' ? '00000000-0000-4000-8000-000000000002' : 'new-password';
    const result = applyStashCredentials(source, [
      {
        entry,
        link: { groupId: source.groups[0].id, entryId: entry.id },
        fields: [{ ...field, value: changed }],
      },
    ]);
    const after = entryCredentials(result.groups[0].entries[0]);
    expect(result.groups[0].entries[0].draft?.description).toBe('Keep this server note');
    expect(after.fields.at(-1)!.value).toBe(changed);
    expect(after.outbound.streamSettings).toEqual(before.outbound.streamSettings);
    if (before.fields.length > 1) expect(after.fields[0].value).toBe(before.fields[0].value);
  }
});
