import { propertyKey, get, objectAt } from './nativeProperties';
export { propertyKey, get, objectAt, setProperty } from './nativeProperties';
import { isIpLiteral } from './graph/addressValidation';
import { jsonRecord, jsonText } from './graph/xrayJson';

export type ServerObject = Record<string, unknown>;
export interface ServerField {
  key: string;
  label: string;
  type?:
    | 'number'
    | 'boolean'
    | 'lines'
    | 'secret'
    | 'select'
    | 'object'
    | 'collection'
    | 'map'
    | 'port'
    | 'target'
    | 'numbers'
    | 'fastopen';
  schema?: string;
  aliases?: string[];
  choices?: readonly string[];
  optionLabels?: Record<string, string>;
  itemName?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  advanced?: boolean;
  min?: number;
  max?: number;
  allowZero?: boolean;
  integer?: boolean;
  wide?: boolean;
}
const number = (key: string, label: string, extra: Partial<ServerField> = {}): ServerField => ({
  key,
  label,
  type: 'number',
  min: 0,
  max: 4294967295,
  ...extra,
});
const flag = (key: string, label: string, defaultOn = false): ServerField => ({
  key,
  label,
  type: 'boolean',
  placeholder: `Default (${defaultOn ? 'on' : 'off'})`,
});
const lines = (key: string, label: string, extra: Partial<ServerField> = {}): ServerField => ({
  key,
  label,
  type: 'lines',
  ...extra,
});
const nested = (key: string, label: string, schema: string, collection = false): ServerField => ({
  key,
  label,
  schema,
  type: collection ? 'collection' : 'object',
});
const level = number('userLevel', 'User policy level', { advanced: true, placeholder: '0' });
const advanced = (fields: ServerField[]): ServerField[] =>
  fields.map((field) => ({ ...field, advanced: true }));
const fallback: ServerField[] = [
  {
    key: 'dest',
    label: 'Destination',
    type: 'target',
    required: true,
    placeholder: '8080, 127.0.0.1:8080, or /run/backend.sock',
  },
  { key: 'name', label: 'Server name (SNI)' },
  { key: 'alpn', label: 'ALPN', placeholder: 'Any ALPN' },
  { key: 'path', label: 'Path', placeholder: 'Any path' },
  {
    key: 'type',
    label: 'Destination type',
    type: 'select',
    choices: ['tcp', 'unix', 'serve'],
    placeholder: 'Detect from destination',
  },
  {
    key: 'xver',
    label: 'PROXY protocol',
    type: 'select',
    choices: ['0', '1', '2'],
    placeholder: '0 (off)',
  },
];

// Server-side fields only. This is an intentionally ordered presentation layer over
// Xray's JSON model, not a second config format. Unlisted properties are preserved.
// Source: infra/conf and transport/internet in Xray 26.9.30; see graph/xrayConfigNames.json.
export const serverStructures: Record<string, ServerField[]> = {
  Interface: [{ key: 'tag', label: 'Tag', placeholder: 'Untagged', wide: true }],
  Listener: [
    {
      key: 'tag',
      label: 'Tag',
      placeholder: 'Untagged',
      wide: true,
    },
    {
      key: 'listen',
      label: 'Listen address',
      placeholder: 'All local addresses',
      hint: 'IP address, localhost, or a server-side Unix socket path.',
    },
    {
      key: 'port',
      label: 'Listen port',
      type: 'port',
      required: true,
      placeholder: '443',
      hint: 'A port, range, or comma-separated list.',
    },
  ],
  VLessInboundConfig: [
    {
      key: 'decryption',
      label: 'Decryption',
      required: true,
      placeholder: 'none',
      hint: 'Use none for ordinary VLESS, or the server VLESS Encryption key string.',
    },
    {
      key: 'flow',
      label: 'Default flow',
      type: 'select',
      choices: ['xtls-rprx-vision'],
      placeholder: 'No flow',
      hint: 'Users may override this in their User set.',
    },
    { ...nested('fallbacks', 'Fallbacks', 'Fallback', true), advanced: true },
    { key: 'testseed', label: 'Test seed', type: 'numbers', advanced: true },
  ],
  VMessInboundConfig: [
    { ...nested('default', 'Dynamic user defaults', 'VMessDefault'), advanced: true },
  ],
  VMessDefault: [number('level', 'User policy level', { max: 255, placeholder: '0' })],
  TrojanServerConfig: [{ ...nested('fallbacks', 'Fallbacks', 'Fallback', true), advanced: true }],
  Fallback: fallback,
  SocksServerConfig: [
    {
      key: 'auth',
      label: 'Authentication',
      type: 'select',
      choices: ['noauth', 'password'],
      placeholder: 'No authentication',
      hint: 'Username/password accounts come from connected User sets.',
    },
    flag('udp', 'Allow UDP'),
    {
      key: 'ip',
      label: 'UDP relay address',
      advanced: true,
      hint: 'Address returned to SOCKS clients for UDP association.',
    },
    level,
  ],
  HTTPServerConfig: [
    { ...flag('allowTransparent', 'Accept transparent HTTP requests'), advanced: true },
    level,
  ],
  ShadowsocksServerConfig: [
    {
      key: 'method',
      label: 'Cipher',
      type: 'select',
      required: true,
      choices: [
        'aes-128-gcm',
        'aes-256-gcm',
        'chacha20-poly1305',
        'xchacha20-poly1305',
        '2022-blake3-aes-128-gcm',
        '2022-blake3-aes-256-gcm',
        '2022-blake3-chacha20-poly1305',
      ],
    },
    {
      key: 'password',
      label: 'Server password / key',
      type: 'secret',
      required: true,
      hint: 'Shadowsocks 2022 uses a base64 server key.',
    },
    {
      key: 'network',
      label: 'Accepted traffic',
      type: 'select',
      choices: ['tcp', 'udp', 'tcp,udp'],
      placeholder: 'TCP',
    },
    number('level', 'User policy level', { advanced: true, max: 255, placeholder: '0' }),
    { key: 'email', label: 'User label', advanced: true },
  ],
  DokodemoConfig: [
    {
      key: 'allowedNetwork',
      aliases: ['network'],
      label: 'Accepted traffic',
      type: 'select',
      choices: ['tcp', 'udp', 'tcp,udp'],
      placeholder: 'TCP',
    },
    {
      key: 'rewriteAddress',
      aliases: ['address'],
      label: 'Forward to address',
      placeholder: 'Original destination address',
    },
    number('rewritePort', 'Forward to port', { max: 65535, aliases: ['port'] }),
    {
      ...flag('followRedirect', 'Use original destination'),
      hint: 'Requires existing Linux REDIRECT/TPROXY rules. Wayrill Aquifer does not install them.',
    },
    {
      key: 'portMap',
      label: 'Port mappings',
      type: 'map',
      advanced: true,
      hint: 'Incoming port → destination host:port.',
    },
    level,
  ],
  WireGuardConfig: [
    { key: 'secretKey', label: 'Private key', type: 'secret', required: true },
    lines('address', 'Interface addresses'),
    nested('peers', 'Peers', 'WireGuardPeerConfig', true),
    number('mtu', 'MTU', { advanced: true, placeholder: '1420', max: 65535 }),
  ],
  WireGuardPeerConfig: [
    { key: 'publicKey', label: 'Peer public key', required: true },
    lines('allowedIPs', 'Allowed client IPs', { placeholder: '0.0.0.0/0 and ::/0 when omitted' }),
    { key: 'preSharedKey', label: 'Preshared key', type: 'secret' },
    {
      key: 'endpoint',
      label: 'Peer endpoint',
      placeholder: 'Optional for roaming clients',
      advanced: true,
    },
    number('keepAlive', 'Persistent keepalive (seconds)', { placeholder: 'Off', advanced: true }),
    number('level', 'User policy level', { advanced: true, placeholder: '0' }),
    { key: 'email', label: 'User label', advanced: true },
  ],
  HysteriaServerConfig: [
    number('version', 'Protocol version', {
      required: true,
      min: 2,
      max: 2,
      placeholder: '2',
      advanced: true,
    }),
  ],
  MasqueServerConfig: [
    lines('address', 'Client address prefixes', {
      required: true,
      placeholder: '10.90.0.1/24\nfd90::1/64',
      hint: 'At most one IPv4 and one IPv6 prefix.',
    }),
    number('mtu', 'MTU', { advanced: true, min: 1280, max: 65535, allowZero: true }),
  ],
  TunConfig: [
    { key: 'name', label: 'Interface name', placeholder: 'Xray chooses an available utun name' },
    lines('gateway', 'Interface addresses', { hint: 'IPv4 / IPv6 addresses with prefix lengths.' }),
    lines('dns', 'DNS addresses', {
      hint: 'Addresses served by the TUN stack; route DNS traffic to a resolver.',
    }),
    lines('autoSystemRoutingTable', 'System routes', {
      hint: 'CIDR prefixes to route through this interface.',
    }),
    {
      key: 'autoOutboundsInterface',
      label: 'Outbound interface',
    },
    {
      ...flag('autoSystemDnsToGateway', 'Point system DNS to the TUN gateway'),
      hint: 'Requires gateway addresses on the Linux server.',
    },
    number('mtu', 'MTU', { advanced: true, placeholder: '1500', max: 65535 }),
    level,
  ],
  TLSConfig: [
    nested('certificates', 'Certificates', 'TLSCertConfig', true),
    lines('alpn', 'ALPN', { placeholder: 'Transport default' }),
    flag('rejectUnknownSni', 'Reject unknown SNI'),
    ...advanced([
      flag('enableSessionResumption', 'Allow session resumption'),
      {
        key: 'minVersion',
        label: 'Minimum TLS version',
        type: 'select',
        choices: ['1.0', '1.1', '1.2', '1.3'],
      },
      {
        key: 'maxVersion',
        label: 'Maximum TLS version',
        type: 'select',
        choices: ['1.0', '1.1', '1.2', '1.3'],
      },
      {
        key: 'cipherSuites',
        label: 'Cipher suites',
        hint: 'Colon-separated TLS 1.2 cipher names.',
      },
      lines('curvePreferences', 'Curve preferences'),
      { key: 'echServerKeys', label: 'ECH server keys', type: 'secret' },
      {
        key: 'masterKeyLog',
        label: 'TLS key log file',
        hint: 'Server-side path. Contains session secrets.',
      },
    ]),
  ],
  TLSCertConfig: [
    {
      key: 'certificateFile',
      label: 'Certificate file',
      hint: 'Path on the remote server.',
    },
    { key: 'keyFile', label: 'Private key file', hint: 'Path on the remote server.' },
    ...advanced([
      lines('certificate', 'Inline certificate (PEM)'),
      lines('key', 'Inline private key (PEM)'),
      {
        key: 'usage',
        label: 'Certificate usage',
        type: 'select',
        choices: ['encipherment', 'issue', 'verify'],
        placeholder: 'encipherment',
      },
      number('ocspStapling', 'OCSP refresh (seconds)'),
      flag('oneTimeLoading', 'Load certificate only once'),
      flag('buildChain', 'Build certificate chain'),
    ]),
  ],
  REALITYConfig: [
    {
      key: 'target',
      aliases: ['dest'],
      label: 'Camouflage target',
      type: 'target',
      required: true,
      placeholder: 'www.example.com:443',
    },
    lines('serverNames', 'Accepted server names', {
      required: true,
      placeholder: 'www.example.com',
    }),
    { key: 'privateKey', label: 'Private key', type: 'secret', required: true },
    {
      ...nested('shortIds', 'Short IDs', 'ShortId', true),
      required: true,
      hint: 'Even-length hexadecimal, up to 16 characters. An empty ID is allowed.',
    },
    ...advanced([
      { key: 'mldsa65Seed', label: 'ML-DSA-65 seed', type: 'secret' },
      { key: 'minClientVer', label: 'Minimum client version' },
      { key: 'maxClientVer', label: 'Maximum client version' },
      number('maxTimeDiff', 'Maximum clock difference (ms)'),
      {
        key: 'type',
        label: 'Target type',
        type: 'select',
        choices: ['tcp', 'unix'],
        placeholder: 'Detect from target',
      },
      {
        key: 'xver',
        label: 'PROXY protocol',
        type: 'select',
        choices: ['0', '1', '2'],
        placeholder: '0 (off)',
      },
      nested('limitFallbackUpload', 'Fallback upload limit', 'LimitFallback'),
      nested('limitFallbackDownload', 'Fallback download limit', 'LimitFallback'),
      flag('show', 'Debug output'),
      { key: 'masterKeyLog', label: 'TLS key log file' },
    ]),
  ],
  LimitFallback: [
    number('afterBytes', 'Start after (bytes)'),
    number('bytesPerSec', 'Bytes per second'),
    number('burstBytesPerSec', 'Burst bytes per second'),
  ],
  TCPConfig: [
    flag('acceptProxyProtocol', 'Accept PROXY protocol'),
    { ...nested('header', 'HTTP camouflage', 'HTTPHeader'), advanced: true },
  ],
  HTTPHeader: [
    {
      key: 'type',
      label: 'Header type',
      type: 'select',
      choices: ['none', 'http'],
      placeholder: 'none',
    },
    nested('request', 'Expected request', 'AuthenticatorRequest'),
    nested('response', 'Response', 'AuthenticatorResponse'),
  ],
  AuthenticatorRequest: [
    { key: 'version', label: 'HTTP version' },
    { key: 'method', label: 'Method' },
    lines('path', 'Paths'),
    { key: 'headers', label: 'Headers', type: 'map', schema: 'lines' },
  ],
  AuthenticatorResponse: [
    { key: 'version', label: 'HTTP version' },
    { key: 'status', label: 'Status code' },
    { key: 'reason', label: 'Status text' },
    { key: 'headers', label: 'Headers', type: 'map', schema: 'lines' },
  ],
  WebSocketConfig: [
    { key: 'path', label: 'Path', placeholder: '/' },
    { key: 'host', label: 'Host', placeholder: 'Any host' },
    ...advanced([
      flag('acceptProxyProtocol', 'Accept PROXY protocol'),
      number('heartbeatPeriod', 'Heartbeat (seconds)'),
    ]),
  ],
  HttpUpgradeConfig: [
    { key: 'path', label: 'Path', placeholder: '/' },
    { key: 'host', label: 'Host', placeholder: 'Any host' },
    { ...flag('acceptProxyProtocol', 'Accept PROXY protocol'), advanced: true },
  ],
  GRPCConfig: [
    { key: 'serviceName', label: 'Service name' },
    number('idle_timeout', 'Keepalive interval (seconds)', { advanced: true }),
    number('health_check_timeout', 'Keepalive timeout (seconds)', { advanced: true }),
  ],
  SplitHTTPConfig: [
    { key: 'path', label: 'Path', placeholder: '/' },
    { key: 'host', label: 'Host', placeholder: 'Any host' },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      choices: ['auto', 'packet-up', 'stream-up', 'stream-one'],
      placeholder: 'auto',
    },
    ...advanced([
      { key: 'headers', label: 'Response headers', type: 'map' },
      { key: 'xPaddingBytes', label: 'Padding bytes', placeholder: '100-1000' },
      flag('xPaddingObfsMode', 'Obfuscate padding'),
      { key: 'xPaddingKey', label: 'Padding key' },
      { key: 'xPaddingHeader', label: 'Padding header' },
      { key: 'xPaddingPlacement', label: 'Padding placement' },
      { key: 'xPaddingMethod', label: 'Padding method' },
      { key: 'uplinkHTTPMethod', label: 'Uplink HTTP method' },
      { key: 'sessionIDPlacement', label: 'Session ID placement' },
      { key: 'sessionIDKey', label: 'Session ID key' },
      { key: 'sessionIDTable', label: 'Session ID table' },
      { key: 'sessionIDLength', label: 'Session ID length' },
      { key: 'seqPlacement', label: 'Sequence placement' },
      { key: 'seqKey', label: 'Sequence key' },
      { key: 'uplinkDataPlacement', label: 'Uplink data placement' },
      { key: 'uplinkDataKey', label: 'Uplink data key' },
      { key: 'uplinkChunkSize', label: 'Uplink chunk size' },
      flag('noSSEHeader', 'Omit SSE header'),
      { key: 'scMaxEachPostBytes', label: 'Maximum POST bytes', placeholder: '1000000' },
      number('scMaxBufferedPosts', 'Maximum buffered POSTs', { placeholder: '30' }),
      { key: 'scStreamUpServerSecs', label: 'Stream-up duration (seconds)', placeholder: '20-80' },
      number('serverMaxHeaderBytes', 'Maximum header bytes'),
    ]),
  ],
  KCPConfig: [
    { key: 'seed', label: 'Seed', type: 'secret' },
    ...advanced([
      number('mtu', 'MTU', { min: 576, max: 1460, placeholder: '1350' }),
      number('tti', 'Transmission interval (ms)', { min: 10, max: 100, placeholder: '50' }),
      number('uplinkCapacity', 'Uplink capacity (MB/s)', { placeholder: '5' }),
      number('downlinkCapacity', 'Downlink capacity (MB/s)', { placeholder: '20' }),
      number('cwndMultiplier', 'Congestion window multiplier'),
      number('maxSendingWindow', 'Maximum sending window'),
      nested('header', 'Packet header', 'KCPHeader'),
    ]),
  ],
  KCPHeader: [
    {
      key: 'type',
      label: 'Header type',
      type: 'select',
      choices: ['none', 'srtp', 'utp', 'wechat-video', 'dtls', 'wireguard'],
      placeholder: 'none',
    },
  ],
  HysteriaConfig: [
    number('version', 'Transport version', { required: true, min: 2, max: 2, placeholder: '2' }),
    number('udpIdleTimeout', 'UDP idle timeout (seconds)', {
      advanced: true,
      min: 2,
      max: 600,
      allowZero: true,
      placeholder: '60',
    }),
    { ...nested('masquerade', 'Masquerade', 'Masquerade'), advanced: true },
  ],
  Masquerade: [
    {
      key: 'type',
      label: 'Response type',
      type: 'select',
      choices: ['404', 'file', 'proxy', 'string'],
    },
    { key: 'dir', label: 'Directory on server' },
    { key: 'url', label: 'Proxy URL' },
    { key: 'content', label: 'Response body' },
    flag('rewriteHost', 'Rewrite Host header'),
    flag('xForwarded', 'Add forwarded headers'),
    flag('insecure', 'Skip masquerade upstream certificate verification'),
    { key: 'headers', label: 'Response headers', type: 'map' },
    number('statusCode', 'HTTP status', { min: 100, max: 599 }),
  ],
  MasqueConfig: [
    { key: 'host', label: 'Host', placeholder: 'Any host' },
    { key: 'path', label: 'Path', placeholder: '/.well-known/masque/ip/*/*/' },
  ],
  XDriveConfig: [
    { key: 'service', label: 'Storage service', required: true },
    { key: 'remoteFolder', label: 'Remote folder', required: true },
    lines('secrets', 'Shared secrets', { required: true }),
    ...advanced([
      number('segmentBytes', 'Segment bytes'),
      number('flushIntervalMs', 'Flush interval (ms)'),
      number('pollIntervalMs', 'Poll interval (ms)'),
      number('maxPollIntervalMs', 'Maximum poll interval (ms)'),
      number('sessionTtlSeconds', 'Session lifetime (seconds)'),
      number('concurrency', 'Concurrency'),
      number('eagerWindowMs', 'Eager window (ms)'),
      number('holeTimeoutMs', 'Hole timeout (ms)'),
    ]),
  ],
  SocketConfig: advanced([
    {
      key: 'tproxy',
      label: 'Transparent proxy mode',
      type: 'select',
      choices: ['off', 'redirect', 'tproxy'],
      placeholder: 'off',
    },
    flag('acceptProxyProtocol', 'Accept PROXY protocol'),
    {
      key: 'tcpFastOpen',
      label: 'TCP Fast Open',
      type: 'fastopen',
      placeholder: 'System default',
      hint: 'true, false, or a numeric queue length.',
    },
    flag('v6only', 'IPv6-only listener'),
    number('mark', 'Socket mark', { min: -2147483648, max: 2147483647 }),
    { key: 'interface', label: 'Bind to network interface', placeholder: 'Server interface name' },
    number('tcpKeepAliveIdle', 'TCP keepalive idle (seconds)', { min: -2147483648 }),
    number('tcpKeepAliveInterval', 'TCP keepalive interval (seconds)', { min: -2147483648 }),
    number('tcpUserTimeout', 'TCP user timeout (ms)'),
    { key: 'tcpCongestion', label: 'TCP congestion control' },
    number('tcpWindowClamp', 'TCP window clamp'),
    number('tcpMaxSeg', 'TCP maximum segment size'),
    flag('tcpMptcp', 'Multipath TCP'),
    lines('trustedXForwardedFor', 'Trusted forwarded-address proxies'),
    nested('customSockopt', 'Custom socket options', 'CustomSockoptConfig', true),
  ]),
  CustomSockoptConfig: [
    { key: 'system', label: 'Operating system', placeholder: 'linux' },
    { key: 'network', label: 'Network' },
    { key: 'level', label: 'Level' },
    { key: 'opt', label: 'Option' },
    { key: 'value', label: 'Value' },
    { key: 'type', label: 'Value type' },
  ],
  SniffingToggle: [flag('enabled', 'Enable sniffing')],
  SniffingConfig: [
    {
      ...flag('routeOnly', 'Use detected domain for routing only'),
      hint: 'Keep the original destination when connecting.',
    },
    ...advanced([
      lines('domainsExcluded', 'Excluded domains'),
      lines('ipsExcluded', 'Excluded IPs'),
      flag('metadataOnly', 'Inspect metadata only'),
    ]),
  ],
};
export const inboundSchemas: Record<string, string> = {
  vless: 'VLessInboundConfig',
  vmess: 'VMessInboundConfig',
  trojan: 'TrojanServerConfig',
  socks: 'SocksServerConfig',
  mixed: 'SocksServerConfig',
  http: 'HTTPServerConfig',
  shadowsocks: 'ShadowsocksServerConfig',
  tunnel: 'DokodemoConfig',
  'dokodemo-door': 'DokodemoConfig',
  wireguard: 'WireGuardConfig',
  hysteria: 'HysteriaServerConfig',
  masque: 'MasqueServerConfig',
  tun: 'TunConfig',
};
export function fieldKey(object: ServerObject, field: ServerField) {
  // REALITY's password replaces publicKey only when nonempty. Edit the value
  // the core actually consumes when an imported config contains both names.
  const canonical = propertyKey(object, field.key);
  if (field.key === 'password' && field.aliases?.includes('publicKey') && object[canonical])
    return canonical;
  // Match Xray precedence for its legacy aliases (network/address/port take precedence;
  // REALITY target and rawSettings take precedence). Only the effective key is edited.
  const names =
    field.key === 'target'
      ? [field.key, ...(field.aliases ?? [])]
      : [...(field.aliases ?? []), field.key];
  return (
    names.map((name) => propertyKey(object, name)).find((key) => Object.hasOwn(object, key)) ??
    field.key
  );
}
export function fieldsForServer(
  schema: string,
  object: ServerObject,
  root: ServerObject,
): ServerField[] {
  let fields = serverStructures[schema] ?? [];
  if (schema === 'Listener' && /^[/@]/.test(jsonText(get(root, 'listen') ?? '')))
    fields = fields.filter((field) => field.key !== 'port');
  if (schema === 'ShadowsocksServerConfig') {
    const multi = Array.isArray(get(object, 'clients') ?? get(object, 'users'));
    const modern = String(get(object, 'method')).startsWith('2022-');
    fields = fields.filter(
      (field) => !multi || modern || !['method', 'password', 'email', 'level'].includes(field.key),
    );
  }
  if (schema === 'SocksServerConfig' && get(object, 'udp') !== true)
    fields = fields.filter((field) => field.key !== 'ip');
  if (schema === 'HTTPHeader' && get(object, 'type') !== 'http')
    fields = fields.filter((field) => field.key === 'type');
  if (schema === 'SocketConfig') {
    const protocol = String(get(root, 'protocol')).toLowerCase();
    const network = transportOf(objectAt(root, 'streamSettings'));
    const settings = objectAt(root, 'settings');
    const udpOnly =
      protocol === 'wireguard' ||
      ['kcp', 'hysteria', 'masque'].includes(network) ||
      (['shadowsocks', 'tunnel', 'dokodemo-door'].includes(protocol) &&
        (get(settings, 'network') ?? get(settings, 'allowedNetwork')) === 'udp');
    fields = fields.filter(
      (field) =>
        (!udpOnly ||
          ![
            'acceptProxyProtocol',
            'tcpFastOpen',
            'tcpKeepAliveIdle',
            'tcpKeepAliveInterval',
            'tcpUserTimeout',
            'tcpCongestion',
            'tcpWindowClamp',
            'tcpMaxSeg',
            'tcpMptcp',
          ].includes(field.key)) &&
        (field.key !== 'trustedXForwardedFor' ||
          ['ws', 'httpupgrade', 'xhttp', 'grpc'].includes(network)),
    );
  }
  if (schema === 'Masquerade') {
    const type = get(object, 'type');
    fields = fields.filter(
      (field) =>
        field.key === 'type' ||
        (type === 'file'
          ? field.key === 'dir'
          : type === 'proxy'
            ? ['url', 'rewriteHost', 'xForwarded', 'insecure'].includes(field.key)
            : type === 'string' && ['content', 'headers', 'statusCode'].includes(field.key)),
    );
  }
  return fields;
}
export const transportNames = [
  'raw',
  'xhttp',
  'ws',
  'httpupgrade',
  'grpc',
  'kcp',
  'hysteria',
  'xdrive',
] as const;
export function transportOf(stream: ServerObject) {
  const name = jsonText(get(stream, 'method') ?? get(stream, 'network') ?? 'raw').toLowerCase();
  return (
    ({ tcp: 'raw', splithttp: 'xhttp', websocket: 'ws', mkcp: 'kcp' } as Record<string, string>)[
      name
    ] ?? name
  );
}
export function transportFields(stream: ServerObject): { key: string; schema: string } | undefined {
  const name = transportOf(stream);
  const keys: Record<string, [string, string]> = {
    raw: [get(stream, 'rawSettings') !== undefined ? 'rawSettings' : 'tcpSettings', 'TCPConfig'],
    xhttp: [
      get(stream, 'xhttpSettings') !== undefined || get(stream, 'splithttpSettings') === undefined
        ? 'xhttpSettings'
        : 'splithttpSettings',
      'SplitHTTPConfig',
    ],
    ws: ['wsSettings', 'WebSocketConfig'],
    httpupgrade: ['httpupgradeSettings', 'HttpUpgradeConfig'],
    grpc: ['grpcSettings', 'GRPCConfig'],
    kcp: ['kcpSettings', 'KCPConfig'],
    hysteria: ['hysteriaSettings', 'HysteriaConfig'],
    masque: ['masqueSettings', 'MasqueConfig'],
    xdrive: ['xdriveSettings', 'XDriveConfig'],
  };
  const entry = keys[name];
  return entry ? { key: entry[0], schema: entry[1] } : undefined;
}
export const inboundTabs = (root: ServerObject) => [
  String(get(root, 'protocol')).toLowerCase() === 'tun' ? 'Interface' : 'Listener',
  ...(['tun', 'wireguard'].includes(String(get(root, 'protocol')).toLowerCase())
    ? []
    : ['Transport & security']),
  'Sniffing',
  'Advanced',
];

export interface InboundIssue {
  path: string;
  message: string;
  tab: string;
}
export function inboundIssues(root: ServerObject): InboundIssue[] {
  const issues: InboundIssue[] = [];
  const protocol = String(get(root, 'protocol')).toLowerCase(),
    settings = objectAt(root, 'settings'),
    stream = objectAt(root, 'streamSettings');
  const firstTab = protocol === 'tun' ? 'Interface' : 'Listener';
  const add = (path: string, message: string, tab = firstTab) =>
    issues.push({ path, message, tab });
  function validate(object: ServerObject, schema: string, path: string, tab: string) {
    for (const field of fieldsForServer(schema, object, root)) {
      const key = fieldKey(object, field),
        value = object[key],
        at = path + key;
      if (value === undefined || value === '') {
        if (field.required) add(at, `${field.label} is required.`, tab);
        continue;
      }
      if (
        field.type === 'number' &&
        (typeof value !== 'number' ||
          !Number.isInteger(value) ||
          (value < (field.min ?? 0) && !(field.allowZero && value === 0)) ||
          value > (field.max ?? Number.MAX_SAFE_INTEGER))
      )
        add(
          at,
          `${field.label}: enter a whole number from ${field.min ?? 0} to ${field.max ?? Number.MAX_SAFE_INTEGER}.`,
          tab,
        );
      if (
        field.type === 'port' &&
        !jsonText(value)
          .split(',')
          .every((part) => {
            const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
            return (
              match &&
              +match[1] >= 1 &&
              +(match[2] ?? match[1]) <= 65535 &&
              +(match[2] ?? match[1]) >= +match[1]
            );
          })
      )
        add(at, 'Use ports from 1 to 65535, optionally with ranges.', tab);
      if (field.type === 'boolean' && typeof value !== 'boolean')
        add(at, `Choose on or off for ${field.label}.`, tab);
      if (
        field.type === 'lines' &&
        !(
          typeof value === 'string' ||
          (Array.isArray(value) && value.every((item) => typeof item === 'string'))
        )
      )
        add(at, `${field.label} must contain text entries.`, tab);
      if (
        field.type === 'numbers' &&
        (!Array.isArray(value) ||
          value.some(
            (item) =>
              typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 4294967295,
          ))
      )
        add(at, `${field.label} must contain nonnegative whole numbers.`, tab);
      if (!field.type || field.type === 'secret') {
        if (typeof value !== 'string') add(at, `${field.label} must be text.`, tab);
      }
      if (
        field.type === 'fastopen' &&
        !(
          typeof value === 'boolean' ||
          (typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 2147483647)
        )
      )
        add(at, 'TCP Fast Open takes true, false, or a nonnegative queue length.', tab);
      if (field.type === 'object') {
        if (jsonRecord(value)) validate(value, field.schema!, at + '.', tab);
        else add(at, `${field.label} must be an object.`, tab);
      }
      if (
        field.type === 'map' &&
        (!jsonRecord(value) || Object.keys(value).some((key) => !key.trim()))
      )
        add(at, `${field.label}: give every entry a name.`, tab);
      if (
        field.type === 'target' &&
        !(
          (typeof value === 'string' &&
            (/^[/@]/.test(value) || /:\d+$/.test(value) || /^\d+$/.test(value))) ||
          (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535)
        )
      )
        add(at, `${field.label}: use a port, host:port, or Unix socket path.`, tab);
      if (field.key === 'xver' && ![0, 1, 2].includes(Number(value)))
        add(at, 'PROXY protocol must be 0, 1, or 2.', tab);
      if (field.type === 'collection') {
        if (!Array.isArray(value)) add(at, `${field.label} must be a list.`, tab);
        else if (field.required && value.length === 0)
          add(at, `Add at least one ${field.label.toLowerCase()} entry.`, tab);
        else
          value.forEach((item, index) => {
            if (field.schema === 'ShortId') {
              if (typeof item !== 'string' || !/^(?:[\da-f]{2}){0,8}$/i.test(item))
                add(
                  `${at}.${index}`,
                  'Short IDs must contain an even number of hex characters (0–16).',
                  tab,
                );
            } else if (jsonRecord(item)) validate(item, field.schema!, `${at}.${index}.`, tab);
            else add(`${at}.${index}`, `Enter a ${field.label.toLowerCase()} object.`, tab);
          });
      }
    }
  }
  validate(root, protocol === 'tun' ? 'Interface' : 'Listener', '', firstTab);
  if (protocol !== 'tun') {
    const listen = get(root, 'listen');
    if (
      listen &&
      typeof listen === 'string' &&
      !isIpLiteral(listen) &&
      listen !== 'localhost' &&
      !/^[/@]/.test(listen)
    )
      add('listen', 'Use an IP address, localhost, or an absolute Unix socket path.');
  }
  validate(settings, inboundSchemas[protocol], 'settings.', firstTab);
  if (!['tun', 'wireguard'].includes(protocol)) {
    const method = transportFields(stream);
    if (method)
      validate(
        objectAt(stream, method.key),
        method.schema,
        `streamSettings.${method.key}.`,
        'Transport & security',
      );
    const security = jsonText(get(stream, 'security') ?? 'none').toLowerCase();
    if (security === 'reality') {
      if (!['raw', 'grpc', 'xhttp'].includes(transportOf(stream)))
        add(
          'streamSettings.security',
          'REALITY requires RAW, XHTTP, or gRPC.',
          'Transport & security',
        );
      const reality = objectAt(stream, 'realitySettings');
      validate(reality, 'REALITYConfig', 'streamSettings.realitySettings.', 'Transport & security');
      for (const name of ['serverNames', 'shortIds'])
        if (Array.isArray(get(reality, name)) && (get(reality, name) as unknown[]).length === 0)
          add(
            `streamSettings.realitySettings.${name}`,
            `Add at least one ${name === 'serverNames' ? 'server name' : 'short ID'}.`,
            'Transport & security',
          );
    }
    if (security === 'tls') {
      const tls = objectAt(stream, 'tlsSettings');
      validate(tls, 'TLSConfig', 'streamSettings.tlsSettings.', 'Transport & security');
      const certificates = get(tls, 'certificates');
      if (!Array.isArray(certificates) || !certificates.length)
        add(
          'streamSettings.tlsSettings.certificates',
          'Add a server certificate, or use no transport security behind a TLS-terminating reverse proxy.',
          'Transport & security',
        );
      else
        certificates.forEach((cert, index) => {
          if (!jsonRecord(cert) || get(cert, 'usage') === 'verify') return;
          if (!(
            get(cert, 'certificateFile') ||
            (Array.isArray(get(cert, 'certificate')) &&
              (get(cert, 'certificate') as unknown[]).length)
          ))
            add(
              `streamSettings.tlsSettings.certificates.${index}.certificateFile`,
              'Enter a certificate file on the server or inline PEM.',
              'Transport & security',
            );
          if (!(
            get(cert, 'keyFile') ||
            (Array.isArray(get(cert, 'key')) && (get(cert, 'key') as unknown[]).length)
          ))
            add(
              `streamSettings.tlsSettings.certificates.${index}.keyFile`,
              'Enter a private key file on the server or inline PEM.',
              'Transport & security',
            );
        });
    }
    if (
      ['hysteria', 'masque'].includes(protocol) &&
      (transportOf(stream) !== protocol || get(stream, 'security') !== 'tls')
    )
      add(
        'streamSettings.network',
        `${protocol === 'hysteria' ? 'Hysteria 2' : 'MASQUE'} requires its matching transport and TLS.`,
        'Transport & security',
      );
    validate(objectAt(stream, 'sockopt'), 'SocketConfig', 'streamSettings.sockopt.', 'Advanced');
  }
  validate(objectAt(root, 'sniffing'), 'SniffingToggle', 'sniffing.', 'Sniffing');
  validate(objectAt(root, 'sniffing'), 'SniffingConfig', 'sniffing.', 'Sniffing');
  if (
    protocol === 'shadowsocks' &&
    (get(settings, 'method') === '2022-blake3-aes-128-gcm' ||
      get(settings, 'method') === '2022-blake3-aes-256-gcm')
  ) {
    const expected = get(settings, 'method') === '2022-blake3-aes-128-gcm' ? 16 : 32;
    try {
      if (atob(String(get(settings, 'password'))).length !== expected) throw new Error();
    } catch {
      add('settings.password', `Use a base64 server key containing ${expected} bytes.`);
    }
  }
  const prefixValid = (value: unknown) => {
    if (typeof value !== 'string') return false;
    const [address, prefix, extra] = value.split('/');
    return (
      !extra &&
      isIpLiteral(address) &&
      prefix !== undefined &&
      /^\d+$/.test(prefix) &&
      Number(prefix) <= (address.includes(':') ? 128 : 32)
    );
  };
  if (protocol === 'masque') {
    const addresses = get(settings, 'address');
    if (
      !Array.isArray(addresses) ||
      !addresses.length ||
      addresses.some((address) => !prefixValid(address)) ||
      addresses.filter((address) => typeof address === 'string' && address.includes(':')).length >
        1 ||
      addresses.filter((address) => typeof address === 'string' && !address.includes(':')).length >
        1
    )
      add('settings.address', 'Enter at most one IPv4 and one IPv6 client prefix.');
  }
  if (protocol === 'tun') {
    for (const key of ['gateway', 'autoSystemRoutingTable']) {
      const entries = get(settings, key);
      if (Array.isArray(entries) && entries.some((entry) => !prefixValid(entry)))
        add(`settings.${key}`, 'Enter IP addresses with a prefix length.');
    }
    const gateways = get(settings, 'gateway');
    if (
      get(settings, 'autoSystemDnsToGateway') === true &&
      (!Array.isArray(gateways) || !gateways.length)
    )
      add('settings.gateway', 'Add a gateway address before changing system DNS.');
  }
  if (
    protocol === 'vless' &&
    get(settings, 'decryption') !== 'none' &&
    Array.isArray(get(settings, 'fallbacks')) &&
    (get(settings, 'fallbacks') as unknown[]).length
  )
    add('settings.fallbacks', 'VLESS fallbacks require decryption none.');
  return issues;
}
