import { invoke } from '@tauri-apps/api/core';
import { parsePoolSettings, type PoolSettings } from '../graph/poolSettings';
import {
  composePoolLayers,
  isBundle,
  isLayer,
  type LayerAssignment,
  type PoolLayer,
} from './layers';
import { LIMITS } from '../limits';
import { jsonArray, jsonRecord, parseJson } from '../graph/xrayJson';
import { parsePoolBundle, type PoolBundle } from './model';
import { resolvePoolDelivery, type PoolDelivery } from './delivery';
import { validatePublishedGraph } from './validation';
import type { PoolSource } from './PoolConnection';
import { parseGraph, toDocument } from '../graph/model';
import { parseStash } from '../profiles/import';
import { withPoolUser, type PoolUser } from './exports';
import {
  isAccountRef,
  accountKey,
  withObservedAccounts,
  type AccountRef,
  type ObservedServer,
} from './accounts';

type Configuration = { id: string; bundle: PoolBundle };
export type Member = {
  id: string;
  name: string;
  invite: string;
  configurationId: string;
  graphIds?: string[];
  layerIds?: string[];
  publication?: number;
  publishedAt?: number;
  deliveryChanged?: boolean;
  withdrawn?: boolean;
  assignments?: LayerAssignment[];
  aquifer?: PoolUser;
  accounts?: AccountRef[];
  mainAccount?: string;
  publishedAccounts?: string;
  settings?: PoolSettings;
};
export type Publisher = {
  id: string;
  name: string;
  folder: string;
  url?: string;
  layers?: PoolLayer[];
  configurations: Configuration[];
  members: Member[];
};
const text = (value: unknown): value is string => typeof value === 'string';
const invitePattern = /^wp1\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
export const memberGraphs = (member: Member) => [
  ...new Set([member.configurationId, ...(member.graphIds ?? [])].filter(Boolean)),
];
export const memberLayers = (member: Member) => [
  ...new Set([...(member.layerIds ?? []), ...(member.assignments ?? []).map(({ id }) => id)]),
];

function isPublisher(value: unknown): value is Publisher {
  return (
    jsonRecord(value) &&
    [value.id, value.name, value.folder].every(text) &&
    (value.url === undefined || text(value.url)) &&
    (value.layers === undefined ||
      (jsonArray(value.layers) &&
        value.layers.every(
          (layer) => jsonRecord(layer) && text(layer.id) && text(layer.name) && isLayer(layer.data),
        ))) &&
    jsonArray(value.configurations) &&
    value.configurations.every(
      (item) => jsonRecord(item) && text(item.id) && isBundle(item.bundle),
    ) &&
    jsonArray(value.members) &&
    value.members.every(
      (item) =>
        jsonRecord(item) &&
        [item.id, item.name, item.configurationId].every(text) &&
        [item.graphIds, item.layerIds].every(
          (value) => value === undefined || (Array.isArray(value) && value.every(text)),
        ) &&
        text(item.invite) &&
        invitePattern.test(item.invite) &&
        (item.publishedAt === undefined ||
          (typeof item.publishedAt === 'number' && item.publishedAt > 0)) &&
        (item.deliveryChanged === undefined || typeof item.deliveryChanged === 'boolean') &&
        (item.withdrawn === undefined || typeof item.withdrawn === 'boolean') &&
        (item.assignments === undefined ||
          (jsonArray(item.assignments) &&
            item.assignments.every(
              (entry) =>
                jsonRecord(entry) &&
                text(entry.id) &&
                (entry.target === undefined || text(entry.target)),
            ))) &&
        (item.publication === undefined ||
          (Number.isSafeInteger(item.publication) && Number(item.publication) > 0)) &&
        (item.accounts === undefined ||
          (Array.isArray(item.accounts) && item.accounts.every(isAccountRef))) &&
        (item.mainAccount === undefined || text(item.mainAccount)) &&
        (item.publishedAccounts === undefined || text(item.publishedAccounts)) &&
        (item.aquifer === undefined ||
          (jsonRecord(item.aquifer) &&
            text(item.aquifer.id) &&
            text(item.aquifer.name) &&
            jsonRecord(item.aquifer.outbound))),
    )
  );
}

export async function readPublishers(): Promise<Publisher[]> {
  const data = await invoke<string | null>('pool_read');
  if (!data) return [];
  const value = parseJson(data);
  if (
    !jsonRecord(value) ||
    value.version !== 1 ||
    !jsonArray(value.pools) ||
    !value.pools.every(isPublisher)
  )
    throw new Error('The protected Pool settings could not be read.');
  for (const pool of value.pools) {
    for (const { bundle } of pool.configurations) parsePoolSettings(bundle.settings);
    for (const member of pool.members) parsePoolSettings(member.settings);
  }
  return value.pools;
}
export function writePublishers(pools: Publisher[]) {
  return invoke<void>('pool_write', { text: JSON.stringify({ version: 1, pools }) });
}

const hex = (size: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(size)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
export const createPoolInvite = () => `wp1.${hex(16)}.${hex(32)}`;

function base64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(chunks.join(''));
}

export function prepareMember(
  pool: Publisher,
  member: Member,
  servers: readonly ObservedServer[] = [],
): PoolBundle {
  return resolvePoolDelivery(prepareDelivery(pool, member, servers)).bundle;
}

export function prepareDelivery(
  pool: Publisher,
  member: Member,
  servers: readonly ObservedServer[] = [],
): PoolDelivery {
  const chosenGraphs = memberGraphs(member);
  const chosenLayers = memberLayers(member);
  if (!member.configurationId) throw new Error('Choose a default graph for this user.');
  const settings = parsePoolSettings(member.settings);
  const accounts = new Set(member.accounts?.map(accountKey));
  if (
    pool.members.some(
      (other) =>
        other.id !== member.id && other.accounts?.some((ref) => accounts.has(accountKey(ref))),
    )
  )
    throw new Error(
      'An Aquifer account is assigned to another user. Choose an account for this user.',
    );
  const personalize = (bundle: PoolBundle, primary: boolean) => {
    const legacy =
      primary && member.aquifer && !member.mainAccount
        ? withPoolUser(bundle, member.id, member.aquifer)
        : bundle;
    const result = member.accounts?.length
      ? withObservedAccounts(
          legacy,
          member.id,
          servers,
          member.accounts,
          primary ? member.mainAccount : undefined,
        )
      : legacy;
    if (!primary || (!member.mainAccount && !member.aquifer)) return result;
    const graph = parseGraph(result.graph);
    const main = graph.nodes.find((node) => node.id === graph.mainOutboundId);
    if (main) main.data.poolOutbound = true;
    return { ...result, graph: JSON.stringify(toDocument(graph)) };
  };
  const graphs = chosenGraphs.map((id) => {
    const graph = pool.configurations.find((item) => item.id === id);
    if (!graph) throw new Error('An assigned graph was removed.');
    const base = parsePoolBundle(graph.bundle);
    return {
      id,
      bundle: personalize(
        settings ? { ...base, settings: { ...base.settings, ...settings } } : base,
        id === member.configurationId,
      ),
    };
  });
  const layers = chosenLayers.map((id) => {
    const layer = pool.layers?.find((item) => item.id === id);
    if (!layer) throw new Error('An assigned layer was removed.');
    return layer;
  });
  const defaultLayers = (member.assignments ?? []).flatMap<LayerAssignment>(({ id, target }) => {
    const layer = layers.find((item) => item.id === id);
    if (!layer) throw new Error('An assigned layer was removed.');
    if (layer.data.kind === 'stash') return [{ id }];
    return target ? [{ id, target }] : [];
  });
  for (const { bundle } of graphs) validatePublishedGraph(bundle);
  const base = graphs.find(({ id }) => id === member.configurationId)!.bundle;
  const defaults = composePoolLayers(base, layers, defaultLayers, true);
  if (defaults.graph !== base.graph) validatePublishedGraph(defaults);
  const privateGroup = `aquifer-${member.id}`;
  if (
    layers.some(
      ({ data }) =>
        data.kind === 'stash' &&
        parseStash(data.stash).groups.some(({ id }) => id === privateGroup),
    )
  )
    throw new Error('A Stash layer uses this user’s reserved private Stash identity.');
  return {
    format: 'wayrill.pool.catalog',
    version: graphs.some(({ bundle }) => bundle.settings) ? 2 : 1,
    poolName: pool.name,
    defaultGraph: member.configurationId,
    graphs,
    layers,
    defaultLayers,
  };
}

export async function publishMember(
  pool: Publisher,
  member: Member,
  withdraw = false,
  prepared?: PoolDelivery,
) {
  const match = invitePattern.exec(member.invite);
  if (!match) throw new Error('Invalid private Pool access key.');
  const [, recipient, secret] = match;
  let output: string | null = null;
  if (!withdraw) {
    const encode = new TextEncoder();
    const bundle = prepared ?? prepareDelivery(pool, member);
    const clear = encode.encode(JSON.stringify({ ...bundle, publication: member.publication }));
    if (clear.length > (LIMITS.configBytes * 3) / 4 - 1024)
      throw new Error('This Pool configuration is too large. Choose fewer Stash groups.');
    const raw = Uint8Array.from(secret.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    try {
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: encode.encode(`wayrill.pool.access:1:${recipient}`),
        },
        key,
        clear,
      );
      output = JSON.stringify({
        format: 'wayrill.pool.access',
        version: 1,
        recipient,
        nonce: base64(nonce),
        data: base64(new Uint8Array(encrypted)),
      });
    } finally {
      clear.fill(0);
      raw.fill(0);
    }
  }
  await invoke('pool_publish', { folder: pool.folder, recipient, text: output });
}

function invitationSource(pool: Publisher, member: Member): PoolSource {
  return {
    kind: pool.url ? 'url' : 'folder',
    address: pool.url || pool.folder,
    invite: member.invite,
  };
}

export function copyPoolInvitation(pool: Publisher, member: Member) {
  const { address, invite } = invitationSource(pool, member);
  return navigator.clipboard.writeText(['Wayrill Pool invitation', address, invite].join('\n'));
}

export function simulatePoolInvitation(pool: Publisher, member: Member) {
  return invoke<void>('pool_simulation_open', {
    setup: {
      user: member.name,
      source: invitationSource(pool, member),
    },
  });
}
