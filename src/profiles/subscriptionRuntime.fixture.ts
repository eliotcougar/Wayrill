import { makeNode, makeProxyInbound } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { importProfiles, type Stash } from './import';
import type { GraphState } from '../graph/types';
export function runtimeFixture() {
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://192.0.2.1:1080#Linked').groups,
  };
  const group = stash.groups[0],
    entry = group.entries[0];
  const input = makeProxyInbound('mixed', { x: 0, y: 0 }, 'input');
  const proxy = makeNode('socks-outbound', { x: 0, y: 0 }, 'proxy');
  Object.assign(proxy.data.settings, entry.profile!.settings, { tag: 'proxy' });
  proxy.data.stashLink = { groupId: group.id, entryId: entry.id };
  const block = makeNode('block-outbound', { x: 0, y: 0 }, 'block');
  const graph: GraphState = {
    name: 'Applied',
    defaults: factoryDefaults(),
    nodes: [input, proxy, block],
    edges: [
      { id: 'data', source: 'input', sourceHandle: 'data', target: 'proxy', targetHandle: 'in' },
      { id: 'dns', source: 'input', sourceHandle: 'dns', target: 'block', targetHandle: 'in' },
    ],
  };
  return { graph, stash };
}
export function changedStash(stash: Stash, port = 2080): Stash {
  return {
    ...stash,
    groups: stash.groups.map((group) => ({
      ...group,
      entries: group.entries.map((entry) => ({
        ...entry,
        profile: { ...entry.profile!, settings: { ...entry.profile!.settings, port } },
      })),
    })),
  };
}
