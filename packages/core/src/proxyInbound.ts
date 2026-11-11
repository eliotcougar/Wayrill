import {
  jsonRecord,
  jsonText,
  jsonArray,
  parseJson,
  parseJsonObject,
  parseJsonArray,
} from './xrayJson';
import { portRangeProblem, portRangesOverlap } from './portRanges';
import { isIpLiteral } from './addressValidation';
import type { SettingValue } from './settings';

export function proxyInboundSettings(
  raw: Record<string, unknown>,
  defaults: Record<string, SettingValue>,
): Record<string, SettingValue> {
  if (!['mixed', 'socks', 'http'].includes(String(raw.protocol)))
    throw new Error('This protocol uses native listener options.');
  if (
    typeof raw.listen !== 'string' ||
    typeof raw.port !== 'number' ||
    typeof raw.tag !== 'string' ||
    !raw.tag
  )
    throw new Error('Use native options for implicit listener values.');
  const settings = jsonRecord(raw.settings) ? raw.settings : {},
    sniff = jsonRecord(raw.sniffing) ? raw.sniffing : {};
  if (settings.users !== undefined && settings.accounts !== undefined)
    throw new Error('Resolve competing account aliases in native options.');
  const methods = sniff.destOverride ?? [];
  if (
    !jsonArray(methods) ||
    methods.some((m) => !['http', 'tls', 'quic', 'fakedns'].includes(String(m)))
  )
    throw new Error('Use native options for extended name-detection methods.');
  const s: Record<string, SettingValue> = {
    ...defaults,
    mode: String(raw.protocol),
    tag: raw.tag,
    listen: raw.listen,
    port: raw.port,
  };
  for (const key of ['auth', 'udp', 'userLevel', 'allowTransparent'])
    if (settings[key] !== undefined) s[key] = settings[key] as SettingValue;
  if (settings.ip !== undefined) s.udpAddress = jsonText(settings.ip);
  const accounts = settings.accounts ?? settings.users;
  if (accounts !== undefined) {
    if (
      !jsonArray(accounts) ||
      accounts.some(
        (a) =>
          !jsonRecord(a) ||
          typeof a.user !== 'string' ||
          typeof a.pass !== 'string' ||
          Object.keys(a).some((k) => !['user', 'pass'].includes(k)),
      )
    )
      throw new Error('Use native options for extended account objects.');
    if (accounts.length) {
      if (raw.protocol === 'http') s.auth = 'password';
      const first = accounts[0] as { user: string; pass: string };
      s.username = first.user;
      s.password = first.pass;
      s.extraAccounts = accounts.length > 1 ? JSON.stringify(accounts.slice(1)) : '';
    }
  }
  s.sniffing = sniff.enabled === true;
  s.sniffHttp = methods.includes('http');
  s.sniffTls = methods.includes('tls');
  s.sniffQuic = methods.includes('quic');
  s.sniffFakeDns = methods.includes('fakedns');
  for (const key of ['routeOnly', 'metadataOnly'])
    if (sniff[key] !== undefined) s[key] = sniff[key] as SettingValue;
  for (const key of ['domainsExcluded', 'ipsExcluded'])
    if (sniff[key] !== undefined) s[key] = JSON.stringify(sniff[key]);
  if (raw.streamSettings !== undefined) s.streamSettings = JSON.stringify(raw.streamSettings);
  const remaining = (o: Record<string, unknown>, keys: string[]) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))));
  s.settingsExtra = remaining(settings, [
    'auth',
    'udp',
    'userLevel',
    'ip',
    'accounts',
    'users',
    'allowTransparent',
  ]);
  s.sniffingExtra = remaining(sniff, [
    'enabled',
    'destOverride',
    'routeOnly',
    'metadataOnly',
    'domainsExcluded',
    'ipsExcluded',
  ]);
  return s;
}

/** Preserve the imported account alias on the newly generated listener only. */
export function preserveProxyAccountAlias(
  config: Record<string, unknown>,
  original: unknown,
): Record<string, unknown> {
  if (jsonRecord(original) && jsonRecord(config.settings)) {
    const originalKey =
      original.users !== undefined && original.accounts === undefined
        ? 'users'
        : original.accounts !== undefined && original.users === undefined
          ? 'accounts'
          : undefined;
    const currentKey =
      config.settings.users !== undefined
        ? 'users'
        : config.settings.accounts !== undefined
          ? 'accounts'
          : undefined;
    if (originalKey && currentKey && originalKey !== currentKey) {
      config.settings[originalKey] = config.settings[currentKey];
      delete config.settings[currentKey];
    }
  }
  return config;
}

interface ProxyInboundProblem {
  fieldKey: string;
  message: string;
  severity: 'error' | 'warning';
}

const loopback = (address: string) =>
  address === 'localhost' ||
  address === '::1' ||
  (isIpLiteral(address) && address.startsWith('127.'));
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function proxyInboundProblems(
  s: Record<string, SettingValue>,
  httpOnly: boolean,
): ProxyInboundProblem[] {
  const issues: ProxyInboundProblem[] = [];
  const add = (
    fieldKey: string,
    message: string,
    severity: ProxyInboundProblem['severity'] = 'error',
  ) => issues.push({ fieldKey, message, severity });
  for (const key of ['dnsPorts', 'encryptedDnsPorts']) {
    const problem = portRangeProblem(String(s[key] ?? ''));
    if (problem) add(key, problem);
  }
  if (portRangesOverlap(String(s.dnsPorts || '53'), String(s.encryptedDnsPorts || '')))
    add('encryptedDnsPorts', 'Plain and encrypted DNS port sets overlap. Choose disjoint ports.');
  if (s.listen && s.listen !== 'localhost' && !isIpLiteral(String(s.listen)))
    add('listen', 'Enter an IP address or localhost, without a port or URL.');
  if (
    s.listen &&
    (s.listen === 'localhost' || isIpLiteral(String(s.listen))) &&
    !loopback(String(s.listen)) &&
    s.auth === 'noauth'
  )
    add(
      'auth',
      'This address accepts clients beyond loopback without authentication. SOCKS/HTTP credentials and traffic are not encrypted by the listener itself.',
      'warning',
    );
  if (!httpOnly && s.udp && s.udpAddress && !isIpLiteral(String(s.udpAddress)))
    add('udpAddress', 'Enter an IP address, without a port or URL.');
  if (s.auth === 'password') {
    for (const key of ['username', 'password'])
      if (!httpOnly && bytes(String(s[key])) > 255)
        add(key, 'SOCKS5 limits each credential to 255 UTF-8 bytes.');
    try {
      const accounts: unknown = s.extraAccounts ? parseJsonArray(String(s.extraAccounts)) : [];
      if (jsonArray(accounts)) {
        const names = new Set([String(s.username)]);
        for (const item of accounts) {
          if (
            !jsonRecord(item) ||
            typeof item.user !== 'string' ||
            typeof item.pass !== 'string' ||
            bytes(item.user) < 1 ||
            (!httpOnly && bytes(item.user) > 255) ||
            bytes(item.pass) < 1 ||
            (!httpOnly && bytes(item.pass) > 255)
          ) {
            add(
              'extraAccounts',
              httpOnly
                ? 'Each account needs nonempty user and pass strings.'
                : 'Each account needs user and pass strings of 1–255 UTF-8 bytes.',
            );
            break;
          }
          if (names.has(item.user)) {
            add('extraAccounts', 'Usernames must be unique, including the first account.');
            break;
          }
          names.add(item.user);
        }
      }
    } catch {
      /* Field-level JSON validation reports invalid drafts. */
    }
  }
  if (s.sniffing) {
    if (!s.sniffHttp && !s.sniffTls && !s.sniffQuic && !s.sniffFakeDns)
      add(
        'sniffing',
        'Choose at least one name-detection method or turn inspection off.',
        'warning',
      );
    if (s.metadataOnly && (s.sniffHttp || s.sniffTls || s.sniffQuic))
      add(
        'metadataOnly',
        'Metadata-only inspection does not read HTTP/TLS/QUIC payloads.',
        'warning',
      );
  }
  return issues;
}

export function proxyInboundConfig(s: Record<string, SettingValue>): Record<string, unknown> {
  const additional = s.settingsExtra ? parseJsonObject(String(s.settingsExtra)) : {};
  for (const key of ['accounts', 'users', 'auth', 'udp', 'userLevel', 'ip', 'allowTransparent'])
    delete additional[key];
  const settings = {
    ...additional,
    ...(s.mode !== 'http'
      ? { auth: s.auth, udp: s.udp }
      : { allowTransparent: s.allowTransparent }),
    userLevel: s.userLevel,
    ...(s.mode !== 'http' && s.udp && s.udpAddress ? { ip: s.udpAddress } : {}),
    ...(s.auth === 'password'
      ? {
          [s.mode === 'socks' ? 'users' : 'accounts']: [
            { user: s.username, pass: s.password },
            ...(s.extraAccounts ? parseJsonArray(String(s.extraAccounts)) : []),
          ],
        }
      : {}),
  };
  const destOverride = [
    s.sniffHttp && 'http',
    s.sniffTls && 'tls',
    s.sniffQuic && 'quic',
    s.sniffFakeDns && 'fakedns',
  ].filter(Boolean);
  return {
    tag: s.tag,
    listen: s.listen,
    port: s.port,
    protocol: s.mode,
    settings,
    sniffing: {
      ...(s.sniffingExtra ? parseJsonObject(String(s.sniffingExtra)) : {}),
      enabled: s.sniffing,
      ...(s.sniffing
        ? {
            destOverride,
            routeOnly: s.routeOnly,
            metadataOnly: s.metadataOnly,
            ...(s.domainsExcluded ? { domainsExcluded: parseJson(String(s.domainsExcluded)) } : {}),
            ...(s.ipsExcluded ? { ipsExcluded: parseJson(String(s.ipsExcluded)) } : {}),
          }
        : {}),
    },
    ...(s.streamSettings ? { streamSettings: parseJson(String(s.streamSettings)) } : {}),
  };
}
