import { cloneJson, jsonRecord, parseXrayJson } from '../graph/xrayJson';

export const USER_LIMITS = { bytes: 8 * 1024 * 1024, sets: 512, users: 10000 } as const;
export const userProtocols = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  password: 'SOCKS / HTTP / Mixed',
  shadowsocks: 'Shadowsocks',
  'ss2022-128': 'Shadowsocks 2022 · AES-128',
  'ss2022-256': 'Shadowsocks 2022 · AES-256',
  hysteria: 'Hysteria 2',
  masque: 'MASQUE',
} as const;
export type UserProtocol = keyof typeof userProtocols;
export interface CredentialUser {
  id: string;
  name: string;
  enabled: boolean;
  account: Record<string, unknown>;
}
export interface UserSet {
  id: string;
  name: string;
  protocol: UserProtocol;
  users: CredentialUser[];
}
export interface UserLibrary {
  format: 'wayrill-user-sets';
  version: 1;
  sets: UserSet[];
}
export interface UserBinding {
  inbound: number;
  set: string;
}
export interface UserWorkspace {
  sets: UserSet[];
  bindings: UserBinding[];
}
export const emptyLibrary = (): UserLibrary => ({
  format: 'wayrill-user-sets',
  version: 1,
  sets: [],
});
export const newId = () => crypto.randomUUID();
export const scalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
export const record = (value: unknown): Record<string, unknown> => (jsonRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const key = (value: Record<string, unknown>, name: string) =>
  Object.keys(value).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
const get = (value: Record<string, unknown>, name: string) => value[key(value, name)];
export const inboundObjects = (config: Record<string, unknown>) =>
  list(get(config, 'inbounds')).map(record);
export const settingsOf = (inbound: Record<string, unknown>) => record(get(inbound, 'settings'));

export function inboundUserProtocol(inbound: Record<string, unknown>): UserProtocol | null {
  const protocol = scalarText(get(inbound, 'protocol')).toLowerCase();
  if (protocol === 'socks' || protocol === 'http' || protocol === 'mixed') return 'password';
  if (['vless', 'vmess', 'trojan', 'masque'].includes(protocol)) return protocol as UserProtocol;
  const settings = settingsOf(inbound);
  if (protocol === 'hysteria' && get(settings, 'version') === 2) return 'hysteria';
  if (protocol !== 'shadowsocks') return null;
  // A fixed server key is not a user list. Do not silently change SS operating mode.
  if (!Array.isArray(get(settings, 'clients') ?? get(settings, 'users'))) return null;
  const method = scalarText(get(settings, 'method') ?? '').toLowerCase();
  if (method === '2022-blake3-aes-128-gcm') return 'ss2022-128';
  if (method === '2022-blake3-aes-256-gcm') return 'ss2022-256';
  return method.startsWith('2022-') ? null : 'shadowsocks';
}
export function inboundUsers(inbound: Record<string, unknown>): Record<string, unknown>[] {
  const protocol = inboundUserProtocol(inbound);
  const settings = settingsOf(inbound);
  // Xray's legacy clients/accounts aliases take precedence even when empty.
  const preferred = protocol === 'password' ? 'accounts' : 'clients';
  const raw = get(settings, preferred) ?? get(settings, 'users');
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.some((v) => !jsonRecord(v)))
      throw new Error('Inbound users must be an array of account objects.');
    return raw.map((account) =>
      Object.fromEntries(
        Object.entries(record(account)).map(([name, value]) => [
          [
            'id',
            'email',
            'level',
            'flow',
            'user',
            'pass',
            'password',
            'method',
            'auth',
            'encryption',
          ].includes(name.toLowerCase())
            ? name.toLowerCase()
            : name,
          cloneJson(value),
        ]),
      ),
    );
  }
  return [];
}

/** Stable equality for credentials; object property order is immaterial. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (jsonRecord(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const setContent = (set: UserSet) =>
  stable({
    protocol: set.protocol,
    users: set.users.map((u) => ({ account: u.account, enabled: u.enabled })),
  });
export function sameSet(a: UserSet, b: UserSet) {
  return stable(a) === stable(b);
}

export function createUserWorkspace(
  config: Record<string, unknown>,
  library: UserLibrary,
): UserWorkspace {
  const workspace: UserWorkspace = { sets: [], bindings: [] };
  const existingByContent = new Map(library.sets.map((set) => [setContent(set), set]));
  for (const [index, inbound] of inboundObjects(config).entries()) {
    const protocol = inboundUserProtocol(inbound);
    if (!protocol) continue;
    const accounts = inboundUsers(inbound);
    if (!accounts.length) continue;
    const set: UserSet = {
      id: newId(),
      name: `${scalarText(get(inbound, 'tag') || `Inbound ${index + 1}`)} users`,
      protocol,
      users: accounts.map((account, i) => ({
        id: newId(),
        name: scalarText(account.email || account.user || `User ${i + 1}`),
        enabled: true,
        account,
      })),
    };
    const signature = setContent(set);
    const existing = existingByContent.get(signature);
    const chosen = existing ?? set;
    existingByContent.set(signature, chosen);
    if (!workspace.sets.some((s) => s.id === chosen.id)) workspace.sets.push(cloneJson(chosen));
    workspace.bindings.push({ inbound: index, set: chosen.id });
  }
  return workspace;
}

export function accountIdentity(protocol: UserProtocol, account: Record<string, unknown>): string {
  if (protocol === 'masque') return scalarText(account.email).toLowerCase();
  const value = scalarText(
    account[
      protocol === 'password'
        ? 'user'
        : protocol === 'vless' || protocol === 'vmess'
          ? 'id'
          : protocol === 'hysteria'
            ? 'auth'
            : 'password'
    ] ?? '',
  );
  return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value.toLowerCase() : value;
}
export function accountProblem(
  protocol: UserProtocol,
  account: Record<string, unknown>,
): string | null {
  const required =
    protocol === 'masque'
      ? ['email', 'pass']
      : protocol === 'password'
        ? ['user', 'pass']
        : protocol === 'vless' || protocol === 'vmess'
          ? ['id']
          : protocol === 'hysteria'
            ? ['auth']
            : ['password'];
  for (const field of required)
    if (typeof account[field] !== 'string' || !account[field])
      return `Enter ${field === 'id' ? 'a UUID or Xray user ID' : field === 'auth' ? 'an authentication token' : field === 'user' ? 'a username' : field === 'email' ? 'an email / user label' : 'a password'}.`;
  for (const field of ['email', 'flow', 'method'])
    if (account[field] !== undefined && typeof account[field] !== 'string')
      return `${field} must be text.`;
  if (
    account.level !== undefined &&
    (!Number.isInteger(account.level) ||
      Number(account.level) < 0 ||
      Number(account.level) >
        (protocol === 'shadowsocks' || protocol.startsWith('ss2022') || protocol === 'trojan'
          ? 255
          : 4294967295))
  )
    return 'Enter a valid nonnegative user level.';
  if (protocol === 'vless' || protocol === 'vmess') {
    const id = scalarText(account.id);
    if (
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id) &&
      new TextEncoder().encode(id).length > 30
    )
      return 'Use a UUID or an Xray user ID of at most 30 bytes.';
  }
  if (protocol === 'vless' && account.flow && account.flow !== 'xtls-rprx-vision')
    return 'VLESS flow must be empty or xtls-rprx-vision.';
  if (protocol === 'vless' && account.encryption)
    return 'Encryption belongs to VLESS outbound settings, not an inbound user.';
  if (protocol === 'trojan' && account.flow) return 'Trojan inbound users do not support flow.';
  if (protocol === 'masque' && scalarText(account.email).includes(':'))
    return 'MASQUE email must not contain a colon.';
  if (protocol.startsWith('ss2022')) {
    if (account.method)
      return 'Shadowsocks 2022 users inherit the inbound cipher; leave method empty.';
    try {
      if (atob(scalarText(account.password)).length !== (protocol === 'ss2022-128' ? 16 : 32))
        return 'Use a base64 key of the matching cipher length.';
    } catch {
      return 'Use a valid base64 key.';
    }
  }
  if (
    protocol === 'shadowsocks' &&
    ![
      'aes-128-gcm',
      'aes-256-gcm',
      'chacha20-poly1305',
      'chacha20-ietf-poly1305',
      'xchacha20-poly1305',
      'xchacha20-ietf-poly1305',
      'aead_aes_128_gcm',
      'aead_aes_256_gcm',
      'aead_chacha20_poly1305',
      'aead_xchacha20_poly1305',
    ].includes(scalarText(account.method).toLowerCase())
  )
    return 'Select a supported Shadowsocks cipher.';
  return null;
}
export function setProblem(set: UserSet): string | null {
  if (!set.name.trim()) return 'Enter a set name.';
  if (set.name.length > 128) return 'Set names must be at most 128 characters.';
  const identities = new Set<string>(),
    emails = new Set<string>();
  for (const user of set.users) {
    if (!user.name.trim()) return 'Enter a display name for each user.';
    const problem = accountProblem(set.protocol, user.account);
    if (problem) return `${user.name || 'User'}: ${problem}`;
    if (!user.enabled) continue;
    const identity = accountIdentity(set.protocol, user.account),
      email = scalarText(user.account.email ?? '').toLowerCase();
    if (identities.has(identity)) return 'Two enabled users have the same credential.';
    if (email && emails.has(email)) return 'Two enabled users have the same email.';
    identities.add(identity);
    if (email) emails.add(email);
  }
  return null;
}

export function parseUserLibrary(text: string): UserLibrary {
  if (new TextEncoder().encode(text).length > USER_LIMITS.bytes)
    throw new Error('User-set files must be at most 8 MiB.');
  const value = parseXrayJson(text);
  if (
    !jsonRecord(value) ||
    value.format !== 'wayrill-user-sets' ||
    value.version !== 1 ||
    !Array.isArray(value.sets) ||
    value.sets.length > USER_LIMITS.sets
  )
    throw new Error('Choose a Wayrill user-set file (version 1, at most 512 sets).');
  const setIds = new Set<string>();
  let users = 0;
  const validText = (v: unknown, max: number) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    !Array.from(v).some((c) => c.charCodeAt(0) < 32);
  const sets = value.sets.map((entry): UserSet => {
    if (
      !jsonRecord(entry) ||
      !validText(entry.id, 128) ||
      setIds.has(scalarText(entry.id)) ||
      !validText(entry.name, 128) ||
      typeof entry.protocol !== 'string' ||
      !Object.hasOwn(userProtocols, entry.protocol) ||
      !Array.isArray(entry.users)
    )
      throw new Error('A user set has invalid or duplicate metadata.');
    setIds.add(scalarText(entry.id));
    const userIds = new Set<string>();
    users += entry.users.length;
    if (users > USER_LIMITS.users) throw new Error('Use at most 10,000 users per library.');
    const set: UserSet = {
      id: scalarText(entry.id),
      name: scalarText(entry.name),
      protocol: entry.protocol as UserProtocol,
      users: entry.users.map((user): CredentialUser => {
        if (
          !jsonRecord(user) ||
          !validText(user.id, 128) ||
          userIds.has(scalarText(user.id)) ||
          !validText(user.name, 128) ||
          typeof user.enabled !== 'boolean' ||
          !jsonRecord(user.account)
        )
          throw new Error('A user has invalid or duplicate metadata.');
        userIds.add(scalarText(user.id));
        return {
          id: scalarText(user.id),
          name: scalarText(user.name),
          enabled: user.enabled,
          account: cloneJson(user.account),
        };
      }),
    };
    const problem = setProblem(set);
    if (problem) throw new Error(`${set.name}: ${problem}`);
    return set;
  });
  return { format: 'wayrill-user-sets', version: 1, sets };
}
export function mergeUserLibraries(current: UserLibrary, incoming: UserLibrary) {
  const sets = cloneJson(current.sets);
  let added = 0,
    skipped = 0;
  for (const set of incoming.sets) {
    if (sets.some((s) => sameSet({ ...s, id: set.id }, set))) {
      skipped++;
      continue;
    }
    sets.push({ ...cloneJson(set), id: sets.some((s) => s.id === set.id) ? newId() : set.id });
    added++;
  }
  const library = parseUserLibrary(JSON.stringify({ ...emptyLibrary(), sets }));
  return { library, added, skipped };
}
export function saveUserSet(library: UserLibrary, set: UserSet): UserLibrary {
  const exists = library.sets.some((s) => s.id === set.id);
  return parseUserLibrary(
    JSON.stringify({
      ...library,
      sets: exists ? library.sets.map((s) => (s.id === set.id ? set : s)) : [...library.sets, set],
    }),
  );
}
export function addSetToWorkspace(workspace: UserWorkspace, set: UserSet): UserWorkspace {
  return {
    ...workspace,
    sets: workspace.sets.some((s) => s.id === set.id)
      ? workspace.sets.map((s) => (s.id === set.id ? cloneJson(set) : s))
      : [...workspace.sets, cloneJson(set)],
  };
}

export interface UsersCompilation {
  config: Record<string, unknown>;
  errors: string[];
  changed: boolean;
}
/** Only account lists/authentication are edited. All other source settings survive. */
export function compileUsers(
  config: Record<string, unknown>,
  workspace: UserWorkspace,
): UsersCompilation {
  const result = cloneJson(config),
    errors: string[] = [];
  const inbounds = inboundObjects(result);
  const byId = new Map(workspace.sets.map((s) => [s.id, s]));
  for (const binding of workspace.bindings) {
    if (!byId.has(binding.set) || !inbounds[binding.inbound])
      errors.push('A user-set connection refers to a missing node.');
  }
  for (const [index, inbound] of inbounds.entries()) {
    const protocol = inboundUserProtocol(inbound);
    if (!protocol) continue;
    const selected = workspace.bindings
      .filter((b) => b.inbound === index)
      .map((b) => byId.get(b.set))
      .filter((s): s is UserSet => !!s);
    const accounts: Record<string, unknown>[] = [],
      identities = new Map<string, string>(),
      emails = new Map<string, string>();
    const label = scalarText(get(inbound, 'tag') || `Inbound ${index + 1}`);
    for (const set of selected) {
      if (set.protocol !== protocol) {
        errors.push(`${label}: ${set.name} uses an incompatible credential type.`);
        continue;
      }
      const problem = setProblem(set);
      if (problem) {
        errors.push(`${label}: ${set.name}: ${problem}`);
        continue;
      }
      for (const user of set.users.filter((u) => u.enabled)) {
        const identity = accountIdentity(protocol, user.account),
          serialized = stable(user.account),
          email = scalarText(user.account.email ?? '').toLowerCase();
        if (identities.has(identity)) {
          if (identities.get(identity) !== serialized)
            errors.push(
              `${label}: connected sets define conflicting options for the same credential.`,
            );
          continue;
        }
        if (email && emails.has(email) && emails.get(email) !== identity)
          errors.push(`${label}: connected sets use the same email for different users.`);
        identities.set(identity, serialized);
        if (email) emails.set(email, identity);
        accounts.push(cloneJson(user.account));
      }
    }
    const original = inboundUsers(inbound);
    // Empty lists deny access for identity-based protocols. HTTP empty accounts
    // disable authentication; Shadowsocks may fall back to its fixed server key.
    if (
      !accounts.length &&
      (original.length || selected.length) &&
      (protocol === 'password' || protocol === 'shadowsocks' || protocol.startsWith('ss2022'))
    ) {
      errors.push(`${label}: keep at least one enabled user before exporting.`);
      continue;
    }
    if (stable(original) === stable(accounts)) continue;
    const settings = settingsOf(inbound);
    const preferred = protocol === 'password' ? 'accounts' : 'clients';
    const activeKey =
      get(settings, preferred) !== undefined
        ? key(settings, preferred)
        : get(settings, 'users') !== undefined
          ? key(settings, 'users')
          : preferred;
    for (const name of [preferred, 'users'])
      if (key(settings, name) !== activeKey) delete settings[key(settings, name)];
    settings[activeKey] = accounts;
    if (protocol === 'password' && scalarText(get(inbound, 'protocol')).toLowerCase() !== 'http')
      settings[key(settings, 'auth')] = 'password';
    inbound[key(inbound, 'settings')] = settings;
  }
  return {
    config: result,
    errors: [...new Set(errors)],
    changed: stable(config) !== stable(result),
  };
}

export function connectUserSet(
  config: Record<string, unknown>,
  workspace: UserWorkspace,
  setId: string,
  inboundIndex: number,
): UserWorkspace {
  if (workspace.bindings.some((b) => b.set === setId && b.inbound === inboundIndex))
    return workspace;
  const inbound = inboundObjects(config)[inboundIndex],
    set = workspace.sets.find((s) => s.id === setId);
  if (!inbound || !set || inboundUserProtocol(inbound) !== set.protocol)
    throw new Error('Connect a user set to a compatible inbound Users input.');
  return { ...workspace, bindings: [...workspace.bindings, { inbound: inboundIndex, set: setId }] };
}
export function newUser(protocol: UserProtocol, index: number): CredentialUser {
  const bytes = crypto.getRandomValues(new Uint8Array(protocol === 'ss2022-128' ? 16 : 32));
  const password = btoa(String.fromCharCode(...bytes));
  const account: Record<string, unknown> =
    protocol === 'vless' || protocol === 'vmess'
      ? { id: newId() }
      : protocol === 'masque'
        ? { email: `user${index}`, pass: password }
        : protocol === 'password'
          ? { user: `user${index}`, pass: password }
          : protocol === 'hysteria'
            ? { auth: password }
            : { password, ...(protocol === 'shadowsocks' ? { method: 'aes-256-gcm' } : {}) };
  return { id: newId(), name: `User ${index}`, enabled: true, account };
}
export const newUserSet = (protocol: UserProtocol = 'vless'): UserSet => ({
  id: newId(),
  name: 'New user set',
  protocol,
  users: [newUser(protocol, 1)],
});
