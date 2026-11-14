import { invoke } from '@tauri-apps/api/core';
import type { ConfigSnapshot, SavedSession } from '../remoteClient';
import { jsonRecord, parseXrayJson } from '../graph/xrayJson';
import {
  accountIdentity,
  accountProblem,
  inboundObjects,
  inboundUserProtocol,
  inboundUsers,
  scalarText,
  type UserSet,
} from './model';
import { generatePoolConnections } from './poolConnections';

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function observedPoolAccounts(session: SavedSession, config: ConfigSnapshot) {
  const id = await digest([session.host.toLowerCase(), session.port, session.user, config.path]);
  const source = parseXrayJson(config.text);
  if (!jsonRecord(source)) throw new Error('Expected an Xray configuration object.');
  const inbounds = inboundObjects(source);
  const accounts = [];
  const skipped = [];
  for (const [index, inbound] of inbounds.entries()) {
    const protocol = inboundUserProtocol(inbound);
    if (!protocol) continue;
    const accountsInInbound = inboundUsers(inbound);
    if (!accountsInInbound.length) continue;
    const label = scalarText(inbound.tag) || `Inbound ${index + 1}`;
    // Untagged listeners are identified by the endpoint rather than array order.
    const listener = scalarText(inbound.tag) || [inbound.listen, inbound.port];
    const users: UserSet['users'] = [];
    const seen = new Set<string>();
    for (const [position, account] of accountsInInbound.entries()) {
      const identity = accountIdentity(protocol, account);
      if (accountProblem(protocol, account) || !identity || seen.has(identity)) continue;
      seen.add(identity);
      users.push({
        id: await digest([listener, protocol, identity]),
        name: scalarText(account.email || account.user) || `User ${position + 1}`,
        enabled: true,
        account,
      });
    }
    if (!users.length) continue;
    try {
      const result = await generatePoolConnections(
        { id, name: label, protocol, users },
        inbound,
        session.host,
        typeof inbound.port === 'number' ? inbound.port : Number(scalarText(inbound.port)),
        '',
      );
      for (const user of result.users) {
        accounts.push({ ...user, inbound: label, revision: await digest(user.outbound) });
      }
    } catch {
      skipped.push(label);
    }
  }
  return {
    version: 1,
    id,
    name: session.name,
    host: session.host,
    path: config.path,
    accounts,
    skipped,
  };
}

let writes = Promise.resolve();
export function cacheObservedPoolAccounts(session: SavedSession, config: ConfigSnapshot) {
  const next = writes.then(async () => {
    const snapshot = await observedPoolAccounts(session, config);
    await invoke('pool_accounts_cache', { id: snapshot.id, text: JSON.stringify(snapshot) });
  });
  writes = next.catch(() => {});
  return next;
}
