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
import { encodePoolDelivery } from './deliveryCompatibility';
import { validatePublishedGraph } from './validation';
import { resolveGraphLinks } from './graphLinks';
import { formatPoolInvitation, invitePattern, type PoolSource } from './invitation';
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
export type DeliveryTransition =
  | { phase: 'publishing'; before: string | null; digest: string; accounts: string; at: number }
  | { phase: 'withdrawing'; before: string | null };

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
  deliveryTransition?: DeliveryTransition;
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
  subscriberFolder?: string;
  layers?: PoolLayer[];
  configurations: Configuration[];
  members: Member[];
};
const text = (value: unknown): value is string => typeof value === 'string';
const digestText = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
function isDeliveryTransition(value: unknown): value is DeliveryTransition {
  return (
    jsonRecord(value) &&
    (value.before === null || digestText(value.before)) &&
    (value.phase === 'withdrawing' ||
      (value.phase === 'publishing' &&
        digestText(value.digest) &&
        text(value.accounts) &&
        typeof value.at === 'number' &&
        Number.isSafeInteger(value.at) &&
        value.at > 0))
  );
}
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
    (value.subscriberFolder === undefined || text(value.subscriberFolder)) &&
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
        (item.deliveryTransition === undefined || isDeliveryTransition(item.deliveryTransition)) &&
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
    for (const { bundle } of pool.configurations) parsePoolBundle(bundle);
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
    const base = resolveGraphLinks(parsePoolBundle(graph.bundle), pool.layers ?? []);
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
    if (layer.data.kind !== 'traffic' && layer.data.kind !== 'dns') return [];
    return target ? [{ id, target }] : [];
  });
  for (const { bundle } of graphs) validatePublishedGraph(bundle);
  const base = graphs.find(({ id }) => id === member.configurationId)!.bundle;
  const { bundle: defaults } = composePoolLayers(base, layers, defaultLayers);
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

async function encryptDelivery(member: Member, prepared: PoolDelivery) {
  const match = invitePattern.exec(member.invite);
  if (!match) throw new Error('Invalid private Pool access key.');
  const [, recipient, secret] = match;
  const encode = new TextEncoder();
  const bundle = encodePoolDelivery(prepared);
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
    return JSON.stringify({
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

function deliveryLocation(pool: Publisher, member: Member) {
  const match = invitePattern.exec(member.invite);
  if (!match) throw new Error('Invalid private Pool access key.');
  return { folder: pool.folder, recipient: match[1] };
}

export function readDeliveryDigest(pool: Publisher, member: Member) {
  return invoke<string | null>('pool_delivery_digest', deliveryLocation(pool, member));
}

export async function preparePublication(
  pool: Publisher,
  member: Member,
  prepared: PoolDelivery,
  accounts: string,
) {
  const text = await encryptDelivery(member, prepared);
  const before = await readDeliveryDigest(pool, member);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const digest = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const transition: DeliveryTransition = {
    phase: 'publishing',
    before,
    digest,
    accounts,
    at: Date.now(),
  };
  return { text, transition };
}

export function writeDelivery(
  pool: Publisher,
  member: Member,
  text: string | null,
  expected: string | null,
) {
  return invoke<void>('pool_publish', { ...deliveryLocation(pool, member), text, expected });
}

export function completeDelivery(member: Member, transition: DeliveryTransition): Member {
  if (transition.phase === 'withdrawing') {
    return { ...member, withdrawn: true, deliveryTransition: undefined };
  }
  return {
    ...member,
    publishedAt: transition.at,
    publishedAccounts: transition.accounts,
    withdrawn: false,
    deliveryTransition: undefined,
  };
}

export function reconcileDelivery(member: Member, observed: string | null): Member {
  const transition = member.deliveryTransition;
  if (!transition) return member;
  const after = transition.phase === 'publishing' ? transition.digest : null;
  if (observed === after) return completeDelivery(member, transition);
  if (observed === transition.before || observed === null) {
    return {
      ...member,
      publishedAt: observed === null ? undefined : member.publishedAt,
      deliveryChanged: true,
      deliveryTransition: undefined,
    };
  }
  throw new Error(
    'The access file differs from both recorded versions. Check the publishing folder before retrying.',
  );
}

export async function recoverDelivery(pool: Publisher, member: Member): Promise<Member> {
  const transition = member.deliveryTransition;
  if (!transition) return member;
  const observed = await readDeliveryDigest(pool, member);
  if (transition.phase === 'withdrawing' && observed !== null && observed === transition.before) {
    await writeDelivery(pool, member, null, observed);
    return completeDelivery(member, transition);
  }
  return reconcileDelivery(member, observed);
}

export function invitationDestination(pool: Publisher): Omit<PoolSource, 'invite'> {
  return {
    kind: pool.url ? 'url' : 'folder',
    address: pool.url || pool.subscriberFolder || pool.folder,
  };
}

export function copyPoolInvitation(pool: Publisher, member: Member) {
  return navigator.clipboard.writeText(
    formatPoolInvitation({
      ...invitationDestination(pool),
      invite: member.invite,
    }),
  );
}

export function simulatePoolInvitation(pool: Publisher, member: Member) {
  return invoke<void>('pool_simulation_open', {
    setup: {
      user: member.name,
      source: { ...invitationDestination(pool), invite: member.invite },
    },
  });
}
