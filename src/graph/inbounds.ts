import {
  jsonText,
  jsonArray,
  jsonRecord,
  parseJson,
  parseJsonObject,
  parseJsonArray,
} from './xrayJson';
import { listenerNetworks } from './listenerNetworks';
import { portRangeProblem, portRangesOverlap } from './portRanges';
import { isIpLiteral } from './addressValidation';
export { isIpLiteral } from './addressValidation';
import { omitCoreDefaults } from './coreDefaults';
import type {
  Diagnostic,
  NodeDefinition,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from './types';
import { isProtocolInbound, protocolConfig, protocolProblems } from './protocols';

const field = (
  section: string,
  key: string,
  label: string,
  type: SettingDefinition['type'],
  defaultValue: SettingValue,
  extra: Partial<SettingDefinition> = {},
): SettingDefinition => ({ section, key, label, type, defaultValue, required: false, ...extra });
const sniffWhen = { sniffing: true };
const json = (
  section: string,
  key: string,
  label: string,
  extra: Partial<SettingDefinition> = {},
) => field(section, key, label, 'json', '', { maxLength: 65536, jsonShape: 'object', ...extra });
const listenerFields: SettingDefinition[] = [
  field('listener', 'tag', 'Inbound tag', 'text', 'local-socks', {
    required: true,
    help: 'Used by routing rules to identify this listener.',
  }),
  field('listener', 'listen', 'Listen address', 'text', '127.0.0.1', {
    required: true,
    help: 'An IP address or localhost. Use 127.0.0.1 for local apps; 0.0.0.0 / :: listens on all interfaces. Enter IPv6 without brackets.',
  }),
  field('listener', 'port', 'Listen port', 'number', 10808, { min: 1, max: 65535 }),
  field('access', 'auth', 'Authentication', 'select', 'noauth', {
    options: ['noauth', 'password'],
    optionLabels: { noauth: 'No authentication', password: 'Username and password' },
  }),
  field('access', 'username', 'Username', 'text', '', {
    required: true,
    visibleWhen: { auth: 'password' },
    help: 'SOCKS5 credentials. Xray also applies these accounts to HTTP requests on this listener.',
  }),
  field('access', 'password', 'Password', 'password', '', {
    required: true,
    visibleWhen: { auth: 'password' },
  }),
  json('access', 'extraAccounts', 'Additional accounts (JSON)', {
    jsonShape: 'array',
    visibleWhen: { auth: 'password' },
    help: 'Optional additional accounts: [{"user":"name","pass":"secret"}]. Usernames must be unique.',
  }),
  field('udp', 'udp', 'Enable SOCKS5 UDP', 'boolean', true, {
    help: 'The client must support SOCKS5 UDP ASSOCIATE. This does not capture Windows UDP or DNS automatically.',
  }),
  field('udp', 'udpAddress', 'Advertised UDP relay IP', 'text', '', {
    visibleWhen: { udp: true },
    help: 'Leave empty to let Xray choose the local connection address. For LAN clients, an explicit IP must be reachable by those clients.',
  }),
  field('sniffing', 'sniffing', 'Inspect traffic for routing names', 'boolean', true, {
    help: 'Recovers supported HTTP Host, TLS SNI and QUIC names when available. This is separate from DNS resolution.',
  }),
  field('sniffing', 'sniffHttp', 'HTTP Host', 'boolean', true, { visibleWhen: sniffWhen }),
  field('sniffing', 'sniffTls', 'TLS server name (SNI)', 'boolean', true, {
    visibleWhen: sniffWhen,
  }),
  field('sniffing', 'sniffQuic', 'QUIC server name', 'boolean', true, { visibleWhen: sniffWhen }),
  field('sniffing', 'routeOnly', 'Use detected names only for routing', 'boolean', true, {
    visibleWhen: sniffWhen,
    help: 'Keeps the original destination for the actual connection. Turn off to allow supported destination overrides.',
  }),
  field('sniffingAdvanced', 'sniffFakeDns', 'Recover FakeDNS names', 'boolean', false, {
    visibleWhen: sniffWhen,
    help: 'Requires a corresponding FakeDNS configuration; enabling this field does not create one.',
  }),
  field('sniffingAdvanced', 'metadataOnly', 'Inspect metadata only', 'boolean', false, {
    visibleWhen: sniffWhen,
    help: 'Skips payload inspection. HTTP/TLS/QUIC payload names will not be recovered in this mode.',
  }),
  json('sniffingAdvanced', 'domainsExcluded', 'Excluded domain rules (JSON)', {
    jsonShape: 'array',
    jsonItems: 'nonemptyStrings',
    visibleWhen: sniffWhen,
    help: 'Array of Xray domain rules, for example ["full:example.net"].',
  }),
  json('sniffingAdvanced', 'ipsExcluded', 'Excluded IP rules (JSON)', {
    jsonShape: 'array',
    jsonItems: 'nonemptyStrings',
    visibleWhen: sniffWhen,
    help: 'Array of Xray IP/CIDR/geoip rules, for example ["192.168.0.0/16"].',
  }),
  field('dnsClassification', 'dnsPorts', 'Plain DNS ports', 'text', '53', {
    help: 'Plain DNS requests reaching this listener. Match destination ports or ranges.',
  }),
  field('dnsClassification', 'encryptedDnsPorts', 'Encrypted DNS ports', 'text', '', {
    help: 'Optional separate transport path. Usually 853 for TLS/QUIC. Forward to an outbound; the DNS handler cannot decrypt it. DoH shares HTTPS port 443.',
  }),
  field('advanced', 'userLevel', 'Policy level', 'number', 0, {
    min: 0,
    max: 4294967295,
    help: 'Selects a level in the global Xray policy configuration.',
  }),
  json('advanced', 'streamSettings', 'Listener stream settings (JSON)', {
    help: 'SOCKS UDP uses the listener buffers in Global defaults. These stream settings configure its TCP listener.',
  }),
];

export type ProxyMode = 'socks' | 'http' | 'mixed';
export const proxyModeLabels: Record<ProxyMode, string> = {
  socks: 'SOCKS',
  http: 'HTTP',
  mixed: 'Mixed (SOCKS + HTTP)',
};
const listenerSections = [
  { id: 'listener', title: 'Listener' },
  { id: 'dnsClassification', title: 'DNS connections' },
  { id: 'access', title: 'Access & accounts' },
  { id: 'udp', title: 'UDP relay' },
  { id: 'sniffing', title: 'Name detection' },
  { id: 'sniffingAdvanced', title: 'Name detection tuning', advanced: true },
  { id: 'advanced', title: 'Policy & stream settings', advanced: true },
];
const proxyFields: SettingDefinition[] = [
  field('listener', 'mode', 'Mode', 'select', 'mixed', {
    options: Object.keys(proxyModeLabels),
    optionLabels: proxyModeLabels,
    help: 'SOCKS uses Xray’s HTTP-compatible SOCKS listener. HTTP mode is TCP only.',
  }),
  ...listenerFields.map((f) => ({
    ...f,
    ...(f.key === 'tag' ? { defaultValue: 'local-proxy' } : {}),
    ...(['udp', 'udpAddress'].includes(f.key)
      ? { visibleWhen: { ...f.visibleWhen, mode: ['socks', 'mixed'] } }
      : {}),
    ...(f.key === 'username' ? { help: 'Listener authentication account.' } : {}),
  })),
  field('advanced', 'allowTransparent', 'Allow transparent HTTP', 'boolean', false, {
    visibleWhen: { mode: 'http' },
  }),
  json('advanced', 'settingsExtra', 'Additional listener settings (JSON)', {
    help: 'Additional settings for the selected mode. Named accounts, UDP and policy controls take precedence.',
  }),
  json('sniffingAdvanced', 'sniffingExtra', 'Additional name detection settings (JSON)', {
    help: 'Additional native sniffing options; named controls take precedence.',
  }),
];
export const proxyDefinition: NodeDefinition = {
  kind: 'proxy-inbound',
  title: 'Proxy inbound',
  group: 'Inbounds',
  category: 'inbound',
  summary: 'Local SOCKS, HTTP or mixed listener with Data and DNS paths',
  fields: proxyFields,
  defaults: Object.fromEntries(proxyFields.map((f) => [f.key, f.defaultValue!])),
  sections: listenerSections,
};
export const isHttpInbound = (data: RuleNodeData) =>
  data.kind === 'proxy-inbound' && data.settings.mode === 'http';
export const captureDefinition: NodeDefinition = {
  kind: 'windivert-inbound',
  title: 'WinDivert',
  group: 'Local capture',
  category: 'inbound',
  summary: 'Capture selected Windows traffic into Data and DNS paths',
  fields: [
    ...listenerFields
      .filter(
        (f) =>
          ['tag', 'port'].includes(f.key) ||
          f.section?.startsWith('sniffing') ||
          f.section === 'dnsClassification',
      )
      .map((f) => ({
        ...f,
        ...(f.key === 'tag'
          ? {
              label: 'Capture tag',
              defaultValue: 'captured-traffic',
              help: 'Used by routing rules to identify this capture source.',
            }
          : {}),
        ...(f.key === 'port'
          ? {
              defaultValue: 22080,
              min: 1024,
              help: 'Private local relay port. The service adds temporary authentication when running.',
            }
          : {}),
      })),
    {
      key: 'capturePriority',
      label: 'Capture priority',
      section: 'capture',
      type: 'number',
      defaultValue: 100,
      min: 0,
      max: 65535,
      help: 'Lower priorities win when capture inputs overlap. Equal priorities follow graph node order.',
    },
  ],
  defaults: {
    ...Object.fromEntries(listenerFields.map((f) => [f.key, f.defaultValue!])),
    tag: 'captured-traffic',
    port: 22080,
    listen: '127.0.0.1',
    auth: 'noauth',
    udp: true,
    capturePriority: 100,
  },
  sections: [
    { id: 'capture', title: 'Windows capture' },
    { id: 'dnsClassification', title: 'DNS connections' },
    { id: 'listener', title: 'Private relay' },
    ...listenerSections.filter((s) => s.id.startsWith('sniffing')),
  ],
};
export const isInboundKind = (kind: string) =>
  isProtocolInbound(kind) || kind === 'windivert-inbound' || kind === 'proxy-inbound';

// Match the actual socket networks, rather than treating TCP and UDP on one
// numeric port as a collision. Invalid drafts are diagnosed separately.
export function listenerEndpointKeys(input: Record<string, unknown>): string[] {
  let address = jsonText(input.listen ?? '');
  if (address === 'localhost') address = '127.0.0.1';
  else if (address.includes(':'))
    try {
      address = new URL(`http://[${address}]/`).hostname;
    } catch {
      /* Invalid literals have separate field diagnostics. */
    }
  const endpoint = `${address}:${jsonText(input.port)}`;
  return listenerNetworks(input).map((network) => `${network}:${endpoint}`);
}
// SOCKS/Mixed UDP ASSOCIATE uses per-request ephemeral sockets, not this port.
export function inboundEndpoints(data: RuleNodeData): string[] {
  try {
    return listenerEndpointKeys(inboundPreview(data));
  } catch {
    return [];
  }
}

const loopback = (address: string) =>
  address === 'localhost' ||
  address === '::1' ||
  (isIpLiteral(address) && address.startsWith('127.'));
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function inboundProblems(data: RuleNodeData): Diagnostic[] {
  if (isProtocolInbound(data.kind)) return protocolProblems(data);
  if (!isInboundKind(data.kind)) return [];
  const s = data.settings;
  const issues: Diagnostic[] = [];
  const add = (fieldKey: string, message: string, severity: Diagnostic['severity'] = 'error') =>
    issues.push({ fieldKey, message, severity });
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
  if (!isHttpInbound(data) && s.udp && s.udpAddress && !isIpLiteral(String(s.udpAddress)))
    add('udpAddress', 'Enter an IP address, without a port or URL.');
  if (s.auth === 'password') {
    for (const key of ['username', 'password'])
      if (!isHttpInbound(data) && bytes(String(s[key])) > 255)
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
            (!isHttpInbound(data) && bytes(item.user) > 255) ||
            bytes(item.pass) < 1 ||
            (!isHttpInbound(data) && bytes(item.pass) > 255)
          ) {
            add(
              'extraAccounts',
              isHttpInbound(data)
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

function configuredInboundPreview(data: RuleNodeData): Record<string, unknown> {
  if (isProtocolInbound(data.kind)) return protocolConfig(data);
  if (!isInboundKind(data.kind)) throw new Error('No core preview for this input type.');
  const s =
    data.kind === 'windivert-inbound'
      ? {
          ...data.settings,
          mode: 'socks',
          listen: '127.0.0.1',
          auth: 'noauth',
          udp: true,
          extraAccounts: '',
          streamSettings: '',
          settingsExtra: '',
          userLevel: 0,
        }
      : data.settings;
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

// Ordered branch predicates for the runtime graph compiler. These are not SOCKS protocol output channels.
// Plain and encrypted DNS classify configured destination ports, without parsing or decrypting packets.
export function inboundPreFilters(data: RuleNodeData) {
  if (!isInboundKind(data.kind)) throw new Error('No routing branches for this inbound type.');
  return [
    {
      branch: 'dns' as const,
      match: {
        inboundTag: [String(data.settings.tag)],
        network: isHttpInbound(data) ? 'tcp' : 'tcp,udp',
        port: String(data.settings.dnsPorts || '53'),
      },
    },
    ...(data.settings.encryptedDnsPorts
      ? [
          {
            branch: 'encrypted-dns' as const,
            match: {
              inboundTag: [String(data.settings.tag)],
              network: isHttpInbound(data) ? 'tcp' : 'tcp,udp',
              port: String(data.settings.encryptedDnsPorts),
            },
          },
        ]
      : []),
    { branch: 'data' as const, match: { inboundTag: [String(data.settings.tag)] } },
  ];
}

export function inboundPreview(data: RuleNodeData): Record<string, unknown> {
  return omitCoreDefaults(data, configuredInboundPreview(data));
}
