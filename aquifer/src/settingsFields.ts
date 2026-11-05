import { jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { fieldKey, type InboundIssue, type ServerField, type ServerObject } from './inboundFields';
import { get, objectAt } from './nativeProperties';

const text = (key: string, label: string, extra: Partial<ServerField> = {}): ServerField => ({
  key,
  label,
  ...extra,
});
const number = (
  key: string,
  label: string,
  placeholder = 'Xray default',
  min = 0,
  max = 4294967295,
): ServerField => ({ key, label, type: 'number', placeholder, min, max });
const flag = (key: string, label: string, placeholder = 'Default (off)'): ServerField => ({
  key,
  label,
  type: 'boolean',
  placeholder,
});
const lines = (key: string, label: string, extra: Partial<ServerField> = {}): ServerField => ({
  key,
  label,
  type: 'lines',
  placeholder: 'One entry per line',
  ...extra,
});
const select = (
  key: string,
  label: string,
  choices: string[],
  placeholder: string,
): ServerField => ({
  key,
  label,
  type: 'select',
  choices,
  placeholder,
  optionLabels: {
    AsIs: 'Keep domains (AsIs)',
    IPIfNonMatch: 'Resolve if no rule matches',
    IPOnDemand: 'Resolve when an IP rule needs it',
    UseIP: 'IPv4 and IPv6',
    UseIPv4: 'IPv4 only',
    UseIPv6: 'IPv6 only',
    UseIPv4v6: 'Prefer IPv4, then IPv6',
    UseIPv6v4: 'Prefer IPv6, then IPv4',
    ForceIP: 'Require an IP address',
    ForceIPv4: 'Require IPv4',
    ForceIPv6: 'Require IPv6',
    ForceIPv4v6: 'Require IP, prefer IPv4',
    ForceIPv6v4: 'Require IP, prefer IPv6',
  },
});
const collection = (key: string, label: string, schema: string, itemName: string): ServerField => ({
  key,
  label,
  schema,
  type: 'collection',
  itemName,
});
const advanced = (fields: ServerField[]) => fields.map((field) => ({ ...field, advanced: true }));
const endpoint: ServerField[] = [
  text('address', 'Server address', { required: true }),
  number('port', 'Server port', 'Required', 1, 65535),
];
endpoint[1].required = true;
const user = [number('level', 'User policy level', '0'), text('email', 'User label')];
const id = text('id', 'User ID (UUID)', { type: 'secret', required: true });
const password = text('password', 'Password', { type: 'secret', required: true });
const flow = select('flow', 'Flow', ['xtls-rprx-vision'], 'None');
const dnsStrategy = [
  'UseIP',
  'UseIPv4',
  'UseIPv6',
  'UseIPv4v6',
  'UseIPv6v4',
  'ForceIP',
  'ForceIPv4',
  'ForceIPv6',
  'ForceIPv4v6',
  'ForceIPv6v4',
];
const queryStrategy = ['UseIP', 'UseIPv4', 'UseIPv6'];

/** Ordered forms for the server configuration, rather than an editor for its JSON tree. */
export const settingsStructures: Record<string, ServerField[]> = {
  RoutingOptions: [
    select(
      'domainStrategy',
      'Resolve domains for routing',
      ['AsIs', 'IPIfNonMatch', 'IPOnDemand'],
      'AsIs (keep domains)',
    ),
  ],
  ConnectionPolicy: [
    number('handshake', 'Handshake timeout (seconds)', '60'),
    number('connIdle', 'Idle timeout (seconds)', '300'),
    number('uplinkOnly', 'Upload-only timeout (seconds)', '1'),
    number('downlinkOnly', 'Download-only timeout (seconds)', '1'),
    number(
      'bufferSize',
      'Buffer per connection (KiB)',
      'Xray server default',
      -2147483648,
      2147483647,
    ),
  ],
  APIConfig: [
    text('tag', 'API routing tag', { required: true }),
    text('listen', 'API listen address', {
      placeholder: 'No listener — use routing to reach the API',
      hint: 'An address on the server, for example 127.0.0.1:10085.',
    }),
  ],
  MetricsConfig: [
    text('listen', 'Metrics listen address', { placeholder: 'No HTTP listener' }),
    text('tag', 'Metrics routing tag', { placeholder: 'Metrics (when a listen address is set)' }),
  ],
  VersionConfig: [
    text('min', 'Minimum Xray version', { placeholder: 'No minimum' }),
    text('max', 'Maximum Xray version', { placeholder: 'No maximum' }),
  ],
  ReverseEndpoint: [
    text('tag', 'Routing tag', { required: true }),
    text('domain', 'Reverse tunnel domain', { required: true }),
  ],
  ReverseConfig: [
    collection('bridges', 'Bridges', 'ReverseEndpoint', 'bridge'),
    collection('portals', 'Portals', 'ReverseEndpoint', 'portal'),
  ],
  ResourceFile: [
    text('file', 'File on server', { required: true, placeholder: 'geosite.dat' }),
    text('url', 'HTTPS download URL', { required: true, placeholder: 'https://…/geosite.dat' }),
  ],
  FakeDNSPool: [
    text('ipPool', 'Address range (CIDR)', { required: true, placeholder: '198.18.0.0/15' }),
    number('poolSize', 'Pool size', '32768', 1, Number.MAX_SAFE_INTEGER),
  ],
  DNSConfig: [
    text('tag', 'DNS routing tag'),
    select('queryStrategy', 'Query strategy', queryStrategy, 'UseIP (IPv4 and IPv6)'),
    flag('useSystemHosts', 'Use server hosts file'),
    text('clientIp', 'EDNS client IP', { placeholder: 'Not sent' }),
    flag('disableCache', 'Disable DNS cache'),
    flag('enableParallelQuery', 'Query servers in parallel'),
    ...advanced([
      flag('serveStale', 'Serve expired cache entries'),
      number('serveExpiredTTL', 'Expired answer TTL (seconds)'),
      flag('disableFallback', 'Disable fallback queries'),
      flag('disableFallbackIfMatch', 'Disable fallback when a domain matches'),
    ]),
  ],
  DNSHosts: [
    {
      key: 'hosts',
      label: 'Static DNS hosts',
      type: 'map',
      schema: 'lines',
      hint: 'Host name or domain rule → IP addresses or a domain alias, one per line.',
    },
  ],
  NameServerConfig: [
    text('address', 'DNS server address', {
      required: true,
      placeholder: '1.1.1.1 or https://dns.example/dns-query',
    }),
    number('port', 'DNS server port', '53', 1, 65535),
    lines('domains', 'Preferred domains'),
    lines('expectedIPs', 'Expected IP ranges', { aliases: ['expectIPs'] }),
    select('queryStrategy', 'Query strategy', queryStrategy, 'Inherit DNS handler'),
    flag('skipFallback', 'Exclude from fallback queries'),
    ...advanced([
      text('tag', 'DNS server routing tag'),
      text('clientIp', 'EDNS client IP', { placeholder: 'Inherit DNS handler' }),
      number('timeoutMs', 'Query timeout (ms)'),
      flag('disableCache', 'Disable DNS cache', 'Inherit DNS handler'),
      flag('serveStale', 'Serve expired cache entries', 'Inherit DNS handler'),
      number('serveExpiredTTL', 'Expired answer TTL (seconds)', 'Inherit DNS handler'),
      flag('finalQuery', 'Stop after this server responds'),
      lines('unexpectedIPs', 'Rejected IP ranges'),
    ]),
  ],
  ObservatoryConfig: [
    text('probeURL', 'Probe URL', { placeholder: 'https://www.google.com/generate_204' }),
    text('probeInterval', 'Probe interval', {
      placeholder: '10s',
      hint: 'Duration, for example 30s or 2m.',
    }),
    flag('enableConcurrency', 'Probe outbounds concurrently'),
  ],
  HealthCheckSettings: [
    text('destination', 'Probe URL', {
      placeholder: 'https://connectivitycheck.gstatic.com/generate_204',
    }),
    text('interval', 'Probe interval', { placeholder: '1m' }),
    number('sampling', 'Samples per interval', '10', 1),
    text('timeout', 'Probe timeout', { placeholder: '5s' }),
    ...advanced([
      text('connectivity', 'Connectivity check URL'),
      select('httpMethod', 'HTTP method', ['GET', 'HEAD'], 'HEAD'),
    ]),
  ],
  strategyLeastLoadConfig: [
    number('expected', 'Preferred candidate count', '0'),
    text('maxRTT', 'Maximum round-trip time', {
      placeholder: 'No limit',
      hint: 'Duration, for example 500ms or 2s.',
    }),
    { ...number('tolerance', 'Allowed failure rate', '0'), max: 1, integer: false },
    lines('baselines', 'Baseline delays', {
      placeholder: 'One duration per line, for example 50ms',
    }),
    collection('costs', 'Candidate weights', 'StrategyWeight', 'weight'),
  ],
  StrategyWeight: [
    text('match', 'Outbound tag match', { required: true }),
    { ...number('value', 'Weight', '1'), integer: false },
    flag('regexp', 'Use regular expression'),
  ],
  OutboundGeneral: [
    text('tag', 'Outbound tag'),
    text('sendThrough', 'Source IP address', { placeholder: 'Automatic' }),
    select('targetStrategy', 'Resolve outbound server address', dnsStrategy, 'AsIs'),
  ],
  FreedomConfig: [
    {
      ...select(
        'targetStrategy',
        'Destination DNS strategy',
        dnsStrategy,
        'Keep destination as supplied',
      ),
      aliases: ['domainStrategy'],
    },
    text('redirect', 'Redirect destination', {
      placeholder: 'Original destination',
      hint: 'host:port; leave empty for a normal Direct outbound.',
    }),
    ...advanced([
      number('userLevel', 'User policy level', '0'),
      number('proxyProtocol', 'PROXY protocol version', '0', 0, 2),
      lines('ipsBlocked', 'Blocked IP ranges'),
    ]),
  ],
  BlackholeConfig: [
    { key: 'response', label: 'Block response', type: 'object', schema: 'ResponseConfig' },
  ],
  ResponseConfig: [select('type', 'Response', ['none', 'http'], 'None (silently discard)')],
  LoopbackConfig: [text('inboundTag', 'Target inbound tag', { required: true })],
  VLessOutboundConfig: [
    ...endpoint,
    id,
    flow,
    text('encryption', 'Encryption', { placeholder: 'none' }),
    ...advanced(user),
  ],
  VLessOutboundUserConfig: [
    id,
    flow,
    text('encryption', 'Encryption', { placeholder: 'none' }),
    ...advanced(user),
  ],
  VLessOutboundVnext: [
    ...endpoint,
    collection('users', 'Users', 'VLessOutboundUserConfig', 'user'),
  ],
  VMessOutboundConfig: [
    ...endpoint,
    id,
    select(
      'security',
      'Encryption',
      ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'],
      'auto',
    ),
    ...advanced(user),
  ],
  VMessUserConfig: [
    id,
    select(
      'security',
      'Encryption',
      ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'],
      'auto',
    ),
    ...advanced(user),
  ],
  VMessOutboundTarget: [...endpoint, collection('users', 'Users', 'VMessUserConfig', 'user')],
  TrojanClientConfig: [...endpoint, password, ...advanced([...user, flow])],
  TrojanServerTarget: [...endpoint, password, ...advanced([...user, flow])],
  SocksClientConfig: [
    ...endpoint,
    text('user', 'Username'),
    text('pass', 'Password', { type: 'secret' }),
    ...advanced(user),
  ],
  HTTPClientConfig: [
    ...endpoint,
    text('user', 'Username'),
    text('pass', 'Password', { type: 'secret' }),
    ...advanced([...user, { key: 'headers', label: 'HTTP headers', type: 'map' }]),
  ],
  SocksRemoteConfig: [...endpoint, collection('users', 'Accounts', 'SocksUserConfig', 'account')],
  HTTPRemoteConfig: [...endpoint, collection('users', 'Accounts', 'HTTPUserConfig', 'account')],
  SocksUserConfig: [
    text('user', 'Username'),
    text('pass', 'Password', { type: 'secret' }),
    ...advanced(user),
  ],
  HTTPUserConfig: [
    text('user', 'Username'),
    text('pass', 'Password', { type: 'secret' }),
    ...advanced(user),
  ],
  ShadowsocksClientConfig: [
    ...endpoint,
    text('method', 'Encryption method', { required: true }),
    password,
    ...advanced(user),
  ],
  ShadowsocksServerTarget: [
    ...endpoint,
    text('method', 'Encryption method', { required: true }),
    password,
    ...advanced(user),
  ],
  HysteriaClientConfig: [...endpoint, number('version', 'Hysteria version', '2', 2, 2)],
  MasqueClientConfig: [...endpoint, lines('remoteDNS', 'Remote DNS servers')],
  WireGuardConfig: [
    text('secretKey', 'Private key', { type: 'secret', required: true }),
    lines('address', 'Interface addresses'),
    collection('peers', 'Peers', 'WireGuardPeer', 'peer'),
    ...advanced([
      number('mtu', 'MTU', '1420', 1, 65535),
      { key: 'reserved', label: 'Reserved bytes', type: 'numbers' },
      lines('remoteDNS', 'Remote DNS servers'),
      flag('noKernelTun', 'Use userspace WireGuard'),
    ]),
  ],
  WireGuardPeer: [
    text('publicKey', 'Peer public key', { required: true }),
    text('endpoint', 'Peer endpoint', { placeholder: 'host:port' }),
    lines('allowedIPs', 'Allowed destination IPs', {
      placeholder: '0.0.0.0/0 and ::/0 when omitted',
    }),
    text('preSharedKey', 'Preshared key', { type: 'secret' }),
    number('keepAlive', 'Persistent keepalive (seconds)', 'Off'),
  ],
  DNSOutboundConfig: [
    select('nonIPQuery', 'Non-address DNS requests', ['drop', 'skip'], 'drop'),
    text('rewriteAddress', 'Override resolver address', {
      aliases: ['address'],
      placeholder: 'DNS handler',
    }),
    number('rewritePort', 'Override resolver port', 'Original port', 1, 65535),
    select('rewriteNetwork', 'Resolver transport', ['tcp', 'udp'], 'Original transport'),
    ...advanced([
      number('userLevel', 'User policy level', '0'),
      { key: 'blockTypes', label: 'Blocked record type numbers', type: 'numbers' },
    ]),
  ],
  ClientTLS: [
    text('serverName', 'Server name (SNI)', { placeholder: 'Outbound server address' }),
    text('fingerprint', 'TLS fingerprint', { placeholder: 'Xray default' }),
    lines('alpn', 'ALPN', { placeholder: 'Transport default' }),
    flag('allowInsecure', 'Skip certificate verification'),
    ...advanced([
      text('minVersion', 'Minimum TLS version'),
      text('maxVersion', 'Maximum TLS version'),
      text('pinnedPeerCertSha256', 'Pinned certificate SHA-256'),
      text('verifyPeerCertByName', 'Accepted certificate name'),
    ]),
  ],
  ClientREALITY: [
    text('serverName', 'Server name (SNI)'),
    text('fingerprint', 'TLS fingerprint', { placeholder: 'chrome' }),
    text('password', 'Server public key', {
      aliases: ['publicKey'],
      type: 'secret',
      required: true,
    }),
    text('shortId', 'Short ID'),
    ...advanced([
      text('spiderX', 'Spider path'),
      text('mldsa65Verify', 'ML-DSA-65 verification key'),
    ]),
  ],
  MuxConfig: [
    flag('enabled', 'Enable multiplexing'),
    number('concurrency', 'TCP concurrency', '8', -1, 32767),
    number('xudpConcurrency', 'UDP concurrency', '16', -1, 32767),
    select('xudpProxyUDP443', 'UDP port 443', ['reject', 'allow', 'skip'], 'reject'),
  ],
  ProxyChain: [
    text('tag', 'Next outbound tag'),
    flag('transportLayer', 'Chain the transport layer'),
  ],
};

export function outboundFields(value: ServerObject) {
  const protocol = String(get(value, 'protocol')).toLowerCase();
  const schemas: Record<string, string> = {
    direct: 'FreedomConfig',
    freedom: 'FreedomConfig',
    block: 'BlackholeConfig',
    blackhole: 'BlackholeConfig',
    loopback: 'LoopbackConfig',
    dns: 'DNSOutboundConfig',
    vless: 'VLessOutboundConfig',
    vmess: 'VMessOutboundConfig',
    socks: 'SocksClientConfig',
    http: 'HTTPClientConfig',
    trojan: 'TrojanClientConfig',
    shadowsocks: 'ShadowsocksClientConfig',
    hysteria: 'HysteriaClientConfig',
    masque: 'MasqueClientConfig',
    wireguard: 'WireGuardConfig',
  };
  const schema = schemas[protocol] ?? '';
  const settings = objectAt(value, 'settings');
  const oldKey = ['vless', 'vmess'].includes(protocol) ? 'vnext' : 'servers';
  const itemSchema: Record<string, string> = {
    vless: 'VLessOutboundVnext',
    vmess: 'VMessOutboundTarget',
    socks: 'SocksRemoteConfig',
    http: 'HTTPRemoteConfig',
    trojan: 'TrojanServerTarget',
    shadowsocks: 'ShadowsocksServerTarget',
  };
  return {
    schema,
    fieldSets:
      get(settings, oldKey) !== undefined && itemSchema[protocol]
        ? {
            ...settingsStructures,
            [schema]: [collection(oldKey, 'Servers', itemSchema[protocol], 'server')],
          }
        : settingsStructures,
  };
}

export function fieldsIssues(
  object: ServerObject,
  fields: ServerField[],
  tab: string,
  path = '',
  fieldSets = settingsStructures,
): InboundIssue[] {
  const issues: InboundIssue[] = [];
  for (const field of fields) {
    const key = fieldKey(object, field),
      value = object[key],
      at = path + key;
    const add = (message: string) => issues.push({ path: at, message, tab });
    if (value === undefined || value === '') {
      if (field.required) add(`${field.label} is required.`);
      continue;
    }
    if (
      field.type === 'number' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.integer !== false && !Number.isInteger(value)) ||
        value < (field.min ?? 0) ||
        value > (field.max ?? Number.MAX_SAFE_INTEGER))
    )
      add(
        `${field.label}: enter ${field.integer === false ? 'a number' : 'a whole number'} from ${field.min ?? 0} to ${field.max ?? Number.MAX_SAFE_INTEGER}.`,
      );
    if (field.type === 'boolean' && typeof value !== 'boolean')
      add(`${field.label}: choose on or off.`);
    if (
      (!field.type || field.type === 'secret' || field.type === 'select') &&
      typeof value !== 'string'
    )
      add(`${field.label} must be text.`);
    if (field.type === 'object' && jsonRecord(value))
      issues.push(...fieldsIssues(value, fieldSets[field.schema!] ?? [], tab, at + '.', fieldSets));
    if (field.type === 'collection') {
      if (!jsonArray(value) || !value.every(jsonRecord))
        add(`${field.label} must be a list of objects.`);
      else
        value.forEach((entry, index) =>
          issues.push(
            ...fieldsIssues(
              entry,
              fieldSets[field.schema!] ?? [],
              tab,
              `${at}.${index}.`,
              fieldSets,
            ),
          ),
        );
    }
    if (
      field.type === 'lines' &&
      typeof value !== 'string' &&
      !(jsonArray(value) && value.every((item) => typeof item === 'string'))
    )
      add(`${field.label} must contain text entries.`);
  }
  return issues;
}

export function optionalSettingsIssues(schema: string, value: ServerObject): InboundIssue[] {
  if (schema === 'DNSConfig') {
    const advancedKeys = new Set(
      settingsStructures.DNSConfig.filter((field) => field.advanced).map((field) =>
        field.key.toLowerCase(),
      ),
    );
    const issues = fieldsIssues(value, settingsStructures.DNSConfig, 'General').map((issue) => ({
      ...issue,
      tab: advancedKeys.has(issue.path.split('.')[0].toLowerCase()) ? 'Advanced' : 'General',
    }));
    const servers = get(value, 'servers');
    if (jsonArray(servers))
      servers.forEach((entry, index) =>
        issues.push(
          ...fieldsIssues(
            jsonRecord(entry) ? entry : { address: entry },
            settingsStructures.NameServerConfig,
            'Servers',
            `servers.${index}.`,
          ),
        ),
      );
    return issues;
  }
  if (schema === 'OutboundDetourConfig') {
    const { schema: protocol, fieldSets } = outboundFields(value);
    return fieldsIssues(
      objectAt(value, 'settings'),
      fieldSets[protocol] ?? [],
      'Server',
      'settings.',
      fieldSets,
    );
  }
  if (schema === 'BurstObservatoryConfig') {
    return get(value, 'pingConfig') == null
      ? [{ path: 'pingConfig', message: 'Configure the burst probe settings.', tab: 'Probes' }]
      : fieldsIssues(
          objectAt(value, 'pingConfig'),
          settingsStructures.HealthCheckSettings,
          'Probes',
          'pingConfig.',
        );
  }
  if (schema === 'APIConfig' && !jsonText(get(value, 'tag') ?? '').trim())
    return [{ path: 'tag', message: 'Enter an API routing tag.', tab: 'API' }];
  return fieldsIssues(
    value,
    settingsStructures[schema] ?? [],
    schema === 'NameServerConfig' ? 'Server' : schema === 'DNSConfig' ? 'General' : 'Probes',
  );
}
