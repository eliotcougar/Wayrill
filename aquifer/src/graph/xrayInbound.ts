import { getDefinition } from './catalog';
import { inboundPreview, inboundProblems } from './inbounds';
import { fieldProblem } from './settingValidation';
import { jsonRecord, jsonText, jsonArray } from './xrayJson';
import type { RuleNodeData, SettingValue } from './types';

export function importProxyInbound(raw: Record<string, unknown>): Record<string, SettingValue> {
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
    ...getDefinition('proxy-inbound').defaults,
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
  for (const f of getDefinition('proxy-inbound').fields)
    if (fieldProblem(f, s))
      throw new Error('A native listener field cannot yet use the proxy controls.');
  if (
    inboundProblems({ kind: 'proxy-inbound', settings: s, label: '', description: '' }).some(
      (p) => p.severity === 'error',
    )
  )
    throw new Error('Native listener needs the JSON editor.');
  return s;
}
export function projectProxyInbound(data: RuleNodeData): Record<string, unknown> {
  const config = inboundPreview(data);
  const original =
    data.native?.original.protocol === data.settings.mode
      ? data.native.original.settings
      : undefined;
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
