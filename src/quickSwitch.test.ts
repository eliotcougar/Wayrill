import { expect, it } from 'vitest';
import {
  mainOutbound,
  normalizeMainOutbound,
  setMainOutbound,
  starredChoices,
} from './quickSwitch';
import { enableDefaults } from './graph/defaults';
import { makeNode } from './graph/catalog';
import { parseGraph, serializeGraph } from './graph/model';
import { duplicateSelection } from './graph/editing';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from './graph/workspaceHistory';
import {
  importProfiles,
  mergeImport,
  parseStash,
  serializeStash,
  type Stash,
} from './profiles/import';
import { starStashEntry, putStashEntry, findStashEntry } from './profiles/stashModel';
import { applyStashedProfile } from './profiles/graph';
import { mergeStashDocuments } from './profiles/stashMerge';

const graph = () =>
  enableDefaults({
    name: 'Quick switching',
    nodes: [
      makeNode('direct-outbound', { x: 0, y: 0 }, 'first'),
      makeNode('block-outbound', { x: 300, y: 0 }, 'second'),
    ],
    edges: [],
  });
const library = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: importProfiles(
    'socks://one.example:1080#🇳🇱 First\nsocks://two.example:1080#Second',
    'Servers',
  ).groups,
});

it('persists exactly one Main, keeps it through replacement and duplication, and restores it with Undo', () => {
  const first = setMainOutbound(graph(), 'first');
  expect(parseGraph(serializeGraph(first)).mainOutboundId).toBe('first');
  const second = setMainOutbound(first, 'second');
  const history = commitWorkspaceHistory(initialWorkspaceHistory(first), { graph: second });
  expect(mainOutbound(history.present.graph)?.id).toBe('second');
  expect(undoWorkspaceHistory(history).present.graph.mainOutboundId).toBe('first');
  const stash = library();
  const choice = {
    groupId: stash.groups[0].id,
    entryId: stash.groups[0].entries[0].id,
    label: 'Favorite · Servers',
    available: true,
  };
  const replaced = applyStashedProfile(
    first,
    stash.groups[0].entries[0],
    { x: 0, y: 0 },
    'first',
    choice,
  );
  expect(replaced.nodes.find((node) => node.id === 'first')?.data.stashLink).toEqual({
    groupId: choice.groupId,
    entryId: choice.entryId,
  });
  expect(mainOutbound(replaced)?.data.kind).toBe('socks-outbound');
  const duplicate = duplicateSelection({
    ...replaced,
    nodes: replaced.nodes.map((node) => ({ ...node, selected: node.id === 'first' })),
  });
  expect(mainOutbound(duplicate)?.id).toBe('first');
  expect(duplicate.nodes).toHaveLength(3);
  const removed = normalizeMainOutbound({
    ...first,
    nodes: first.nodes.filter((node) => node.id !== 'first'),
  });
  expect(removed.mainOutboundId).toBeUndefined();
  expect(parseGraph(serializeGraph(removed)).mainOutboundId).toBeUndefined();
});

it('rejects invalid Main selections and never puts the designation into Xray node settings', () => {
  const input = makeNode('proxy-inbound', { x: 0, y: 0 }, 'input');
  const current = { ...graph(), nodes: [...graph().nodes, input] };
  expect(() => setMainOutbound(current, 'input')).toThrow(/Choose an outbound/);
  expect(() =>
    parseGraph(
      JSON.stringify({ ...JSON.parse(serializeGraph(current)), mainOutboundId: 'absent' }),
    ),
  ).toThrow(/Main must refer/);
  const selected = setMainOutbound(current, 'first');
  expect(selected.nodes[0].data.settings).not.toHaveProperty('mainOutboundId');
  expect(setMainOutbound(selected).mainOutboundId).toBeUndefined();
});

it('stars survive storage, an edited profile and provider connection changes without leaking to another entry', () => {
  let stash = library();
  const group = stash.groups[0],
    entry = group.entries[0],
    link = { groupId: group.id, entryId: entry.id };
  stash = starStashEntry(stash, link);
  stash = parseStash(serializeStash(stash));
  expect(starredChoices(stash)).toEqual([
    { ...link, label: '🇳🇱 First · Servers', available: true },
  ]);
  stash = putStashEntry(stash, { ...entry, name: 'Renamed' }, link);
  expect(findStashEntry(stash, link)?.starred).toBe(true);
  stash = mergeImport(
    stash,
    importProfiles('socks://changed.example:1080#🇳🇱 First\nsocks://two.example:1080#Second'),
    group.id,
  );
  expect(findStashEntry(stash, link)?.profile?.settings.address).toBe('changed.example');
  expect(findStashEntry(stash, link)?.starred).toBe(true);
  expect(stash.groups[0].entries[1].starred).toBeUndefined();
  expect(starredChoices(starStashEntry(stash, link))).toEqual([]);
});

it('merges a star click with concurrent provider updates and keeps unavailable favorites visible but disabled', () => {
  const base = library(),
    group = base.groups[0],
    entry = group.entries[0];
  const link = { groupId: group.id, entryId: entry.id };
  const local = starStashEntry(base, link);
  const remote = mergeImport(base, importProfiles('socks://new.example:1080#🇳🇱 First'), group.id);
  const merged = parseStash(
    mergeStashDocuments(serializeStash(base), serializeStash(local), serializeStash(remote)),
  );
  expect(findStashEntry(merged, link)).toMatchObject({
    starred: true,
    profile: { settings: { address: 'new.example' } },
  });
  const unavailable = {
    ...local,
    groups: [{ ...group, entries: [{ ...entry, starred: true, profile: null }] }],
  };
  expect(starredChoices(unavailable)[0].available).toBe(false);
  const malformed = JSON.parse(serializeStash(local));
  malformed.groups[0].entries[0].starred = 'yes';
  expect(() => parseStash(JSON.stringify(malformed))).toThrow(/Invalid Stash protection metadata/);
});
