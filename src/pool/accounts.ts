import { invoke } from '@tauri-apps/api/core';
import { jsonRecord, parseJson } from '../graph/xrayJson';
import { parseStash, serializeStash, type Stash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import { serverEntry, withPoolUser, type PoolUser } from './exports';
import type { PoolBundle } from './model';
import { generatedTag } from '../graph/tags';

export type AccountRef = {
  server: string;
  account: string;
  host?: string;
  port?: number;
  stashName?: string;
};
type ObservedAccount = PoolUser & { inbound: string; revision: string; viaNginx?: boolean };
export type ObservedServer = {
  id: string;
  name: string;
  host: string;
  path: string;
  accounts: ObservedAccount[];
  skipped: string[];
};
export const accountKey = (ref: AccountRef) => `${ref.server}/${ref.account}`;
export const isAccountRef = (value: unknown): value is AccountRef =>
  jsonRecord(value) &&
  typeof value.server === 'string' &&
  typeof value.account === 'string' &&
  (value.host === undefined || typeof value.host === 'string') &&
  (value.stashName === undefined ||
    (typeof value.stashName === 'string' &&
      !!value.stashName.trim() &&
      value.stashName.length <= 128)) &&
  (value.port === undefined ||
    (Number.isSafeInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65535));

function parseServer(text: string): ObservedServer {
  const value = parseJson(text);
  if (
    !jsonRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.path !== 'string' ||
    !Array.isArray(value.skipped) ||
    !value.skipped.every((name: unknown) => typeof name === 'string') ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(
      (account: unknown) =>
        jsonRecord(account) &&
        typeof account.id === 'string' &&
        typeof account.name === 'string' &&
        typeof account.inbound === 'string' &&
        typeof account.revision === 'string' &&
        (account.viaNginx === undefined || typeof account.viaNginx === 'boolean') &&
        jsonRecord(account.outbound),
    )
  )
    throw new Error(
      'Aquifer saved an unreadable account snapshot. Read the server again in Aquifer.',
    );
  return value as ObservedServer;
}

export async function readObservedServers() {
  const records = await invoke<string[]>('pool_accounts_read');
  return records
    .map(parseServer)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

const observations = new WeakMap<
  readonly ObservedServer[],
  Map<string, { server: ObservedServer; account: ObservedAccount }>
>();
export function observedAccount(servers: readonly ObservedServer[], ref: AccountRef) {
  let indexed = observations.get(servers);
  if (!indexed) {
    indexed = new Map();
    for (const server of servers)
      for (const account of server.accounts)
        indexed.set(accountKey({ server: server.id, account: account.id }), { server, account });
    observations.set(servers, indexed);
  }
  return indexed.get(accountKey(ref));
}

export function accountRevision(servers: readonly ObservedServer[], refs?: AccountRef[]) {
  return (
    refs?.map((ref) => observedAccount(servers, ref)?.account.revision ?? 'missing').join('.') || ''
  );
}

export function normalizePublicHost(value: string) {
  const address = value.trim().replace(/^\[|\]$/g, '');
  if (!address || /[\s/?#@\\%]/.test(address))
    throw new Error('Enter a public hostname or IP address. Put the port in the port field.');
  const parsed = URL.parse(`https://${address.includes(':') ? `[${address}]` : address}`);
  if (!parsed || parsed.port) throw new Error('Enter a valid public hostname or IP address.');
  return parsed.hostname.replace(/^\[|\]$/g, '');
}

function clientOutbound(account: ObservedAccount, ref: AccountRef) {
  const outbound = account.outbound;
  if (!ref.host && ref.port === undefined) return outbound;
  const settings = jsonRecord(outbound.settings) ? outbound.settings : {};
  const stream = jsonRecord(outbound.streamSettings) ? outbound.streamSettings : {};
  const tls = jsonRecord(stream.tlsSettings) ? stream.tlsSettings : undefined;
  const host = ref.host ? normalizePublicHost(ref.host) : settings.address;
  return {
    ...outbound,
    settings: { ...settings, address: host, port: ref.port ?? settings.port },
    ...(!account.viaNginx && tls && tls.serverName === settings.address
      ? { streamSettings: { ...stream, tlsSettings: { ...tls, serverName: host } } }
      : {}),
  };
}

export function cachedAccountStash(servers: readonly ObservedServer[], current: Stash): Stash {
  const existing = new Set(current.groups.flatMap((group) => group.entries.map(({ id }) => id)));
  return {
    format: 'wayrill.stash',
    version: 3,
    groups: servers.map((server) => ({
      ...defaultGroup(),
      id: 'aquifer-' + server.id,
      name: server.name,
      entries: server.accounts.flatMap((account) => {
        const id = generatedTag('account', accountKey({ server: server.id, account: account.id }));
        return existing.has(id)
          ? []
          : [
              {
                ...serverEntry(
                  (account.name + ' · ' + account.inbound).slice(0, 128),
                  clientOutbound(account, { server: server.id, account: account.id }),
                ),
                id,
              },
            ];
      }),
    })),
  };
}

export function withObservedAccounts(
  bundle: PoolBundle,
  memberId: string,
  servers: readonly ObservedServer[],
  refs: AccountRef[],
  main?: string,
) {
  const accounts = refs.map((ref) => {
    const match = observedAccount(servers, ref);
    if (!match)
      throw new Error(
        'An assigned Aquifer account is missing. Read its server again or edit this user’s delivery.',
      );
    return {
      ...match,
      account: { ...match.account, outbound: clientOutbound(match.account, ref) },
      stashName: ref.stashName,
      key: accountKey(ref),
    };
  });
  const primary = accounts.find((item) => item.key === main);
  if (main && !primary) throw new Error('Choose an assigned account for Main.');
  const result = primary
    ? withPoolUser(bundle, memberId, {
        ...primary.account,
        name: primary.stashName ?? primary.account.name,
      })
    : bundle;
  if (!accounts.length) return result;
  const stash = parseStash(result.stash);
  const groupId = `aquifer-${memberId}`;
  const previous = stash.groups.find((group) => group.id === groupId);
  const extras = accounts
    .filter((item) => item !== primary)
    .map(({ server, account, key, stashName }) => ({
      ...serverEntry(
        stashName ?? `${server.name} · ${account.inbound}`.slice(0, 128),
        account.outbound,
      ),
      id: generatedTag('account', key),
    }));
  const group = {
    ...(previous ?? defaultGroup()),
    id: groupId,
    name: 'Your Aquifer servers',
    entries: [...(previous?.entries ?? []), ...extras],
  };
  return {
    ...result,
    stash: serializeStash({
      ...stash,
      groups: [...stash.groups.filter((item) => item !== previous), group],
    }),
  };
}
