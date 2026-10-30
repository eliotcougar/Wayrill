import { jsonRecord, parseJsonObject, parseJson } from './xrayJson';
import { omitCoreDefaults, valueAt } from './coreDefaults';
import {
  fragmentFields,
  happyEyeballsFields,
  transportTuningFields,
  tunedFinalMask,
  fragmentMask,
  tuningProblems,
} from './trafficTuning';
import type {
  Diagnostic,
  NodeDefinition,
  NodeKind,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from './types';
import { isProtocolOutbound, protocolConfig, protocolProblems } from './protocols';

const field = (
  section: string,
  key: string,
  label: string,
  type: SettingDefinition['type'],
  defaultValue: SettingValue,
  extra: Partial<SettingDefinition> = {},
): SettingDefinition => ({ section, key, label, type, defaultValue, required: false, ...extra });
const text = (
  section: string,
  key: string,
  label: string,
  extra: Partial<SettingDefinition> = {},
) => field(section, key, label, 'text', '', extra);
const json = (
  section: string,
  key: string,
  label: string,
  extra: Partial<SettingDefinition> = {},
) =>
  field(section, key, label, 'json', '', {
    jsonShape: 'object',
    maxLength: 65536,
    placeholder: '{}',
    ...extra,
  });
const strategies = [
  'AsIs',
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
const fingerprints = [
  '',
  'chrome',
  'firefox',
  'safari',
  'ios',
  'android',
  'edge',
  '360',
  'qq',
  'random',
  'randomized',
  'randomizednoalpn',
];
const httpWhen = { network: ['xhttp', 'ws', 'httpupgrade'] };
const tlsWhen = { security: 'tls' };
const realityWhen = { security: 'reality' };
const securityWhen = { security: ['tls', 'reality'] };

const identity = (tag: string) =>
  field('server', 'tag', 'Outbound tag', 'text', tag, {
    required: true,
    help: 'A unique name used by routing rules and other outbounds.',
  });
const socketFields = [
  text('socket', 'sendThrough', 'Source IP / CIDR', {
    help: 'Optional local source address; Xray also accepts origin or srcip. Leave blank for automatic selection.',
  }),
  text('socket', 'interface', 'Network interface', {
    help: 'Select an adapter to bind outgoing connections to it.',
  }),
  field('socket', 'domainStrategy', 'DNS address strategy', 'select', 'AsIs', {
    options: strategies,
    help: 'AsIs uses the system resolver. Other modes use Xray DNS and select an address family.',
  }),
  text('socket', 'dialerProxy', 'Dial through outbound tag', {
    help: 'Optional outbound used to reach this destination. This is separate from the graph’s traffic paths.',
  }),
  field('socket', 'tcpFastOpen', 'TCP Fast Open', 'select', 'default', {
    options: ['default', 'enabled', 'disabled'],
    optionLabels: { default: 'System default', enabled: 'Enabled', disabled: 'Disabled' },
  }),
  field('socket', 'tcpKeepAliveIdle', 'TCP keepalive idle (seconds)', 'number', 0, {
    min: -1,
    max: 2147483647,
    help: '0 leaves Xray’s default; -1 disables keepalive.',
  }),
  field('socket', 'tcpKeepAliveInterval', 'TCP keepalive interval (seconds)', 'number', 0, {
    min: -1,
    max: 2147483647,
  }),
  field('socket', 'tcpUserTimeout', 'TCP user timeout (milliseconds)', 'number', 0, {
    min: 0,
    max: 2147483647,
  }),
  ...happyEyeballsFields,
  json('socket', 'sockoptExtra', 'Additional socket options (JSON)', {
    help: 'Additional sockopt keys, such as happyEyeballs or customSockopt. Named fields above take precedence.',
  }),
];
const vlessFields: SettingDefinition[] = [
  identity('vless'),
  text('server', 'address', 'Server address', {
    required: true,
    placeholder: 'edge.example.net',
    help: 'Hostname, IPv4 or IPv6 address. Enter the port separately.',
  }),
  field('server', 'port', 'Server port', 'number', 443, { min: 1, max: 65535 }),
  text('account', 'id', 'User ID / UUID', {
    type: 'password',
    required: true,
    help: 'Must match the server. Xray accepts a UUID or a custom ID of up to 30 UTF-8 bytes.',
  }),
  field('account', 'flow', 'Flow control', 'select', '', {
    options: ['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'],
    optionLabels: {
      '': 'None',
      'xtls-rprx-vision': 'XTLS Vision',
      'xtls-rprx-vision-udp443': 'XTLS Vision · allow UDP 443',
    },
  }),
  field('account', 'encryption', 'VLESS encryption', 'textarea', 'none', {
    required: true,
    maxLength: 65536,
    help: 'none, or the complete mlkem768x25519plus… encryption string supplied by your server. This is separate from TLS/REALITY.',
  }),
  field('transport', 'network', 'Transport', 'select', 'raw', {
    options: ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp', 'hysteria', 'xdrive'],
    optionLabels: {
      raw: 'RAW (TCP)',
      xhttp: 'XHTTP',
      ws: 'WebSocket',
      grpc: 'gRPC',
      httpupgrade: 'HTTP Upgrade',
      kcp: 'mKCP',
      hysteria: 'Hysteria 2 transport',
      xdrive: 'XDrive',
    },
  }),
  field('transport', 'rawHeaderType', 'RAW header', 'select', 'none', {
    options: ['none', 'http'],
    optionLabels: { none: 'None', http: 'HTTP camouflage' },
    visibleWhen: { network: 'raw' },
  }),
  text('transport', 'rawHost', 'HTTP host names', {
    visibleWhen: { network: 'raw', rawHeaderType: 'http' },
    help: 'Comma-separated Host header values.',
  }),
  field('transport', 'rawPath', 'HTTP request path', 'text', '/', {
    visibleWhen: { network: 'raw', rawHeaderType: 'http' },
  }),
  json('transport', 'rawHeader', 'Additional RAW header settings (JSON)', {
    visibleWhen: { network: 'raw', rawHeaderType: 'http' },
    help: 'HTTP header object, including request and response. Host/path fields above take precedence when filled.',
  }),
  text('transport', 'host', 'HTTP host', {
    visibleWhen: httpWhen,
    help: 'Optional HTTP Host value; leave blank to use SNI or the server address.',
  }),
  field('transport', 'path', 'HTTP path', 'text', '/', {
    visibleWhen: httpWhen,
    help: 'Must start with /. For WebSocket/HTTP Upgrade, ?ed=2048 enables early data.',
  }),
  json('transport', 'headers', 'HTTP headers (JSON)', {
    visibleWhen: { network: ['ws', 'httpupgrade'] },
    help: 'An object of string values, for example {"User-Agent":"…"}. Use HTTP host above for Host.',
  }),
  field('transport', 'wsHeartbeat', 'WebSocket heartbeat (seconds)', 'number', 0, {
    min: 0,
    max: 4294967295,
    visibleWhen: { network: 'ws' },
    help: '0 disables heartbeat.',
  }),
  field('transport', 'xhttpMode', 'XHTTP mode', 'select', 'auto', {
    options: ['auto', 'packet-up', 'stream-up', 'stream-one'],
    visibleWhen: { network: 'xhttp' },
  }),
  json('transport', 'xhttpExtra', 'XHTTP extra (JSON)', {
    visibleWhen: { network: 'xhttp' },
    help: 'Complete extra object: headers, padding, upload behavior, xmux, downloadSettings, and other XHTTP options. Host/path/mode above remain authoritative.',
  }),
  text('transport', 'grpcServiceName', 'gRPC service name', { visibleWhen: { network: 'grpc' } }),
  text('transport', 'grpcAuthority', 'gRPC authority', { visibleWhen: { network: 'grpc' } }),
  field('transport', 'grpcMultiMode', 'gRPC multi mode', 'boolean', false, {
    visibleWhen: { network: 'grpc' },
  }),
  field('transport', 'grpcIdleTimeout', 'gRPC idle timeout (seconds)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { network: 'grpc' },
  }),
  field('transport', 'grpcHealthTimeout', 'gRPC health timeout (seconds)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { network: 'grpc' },
  }),
  field('transport', 'grpcPermitWithoutStream', 'Keepalive without streams', 'boolean', false, {
    visibleWhen: { network: 'grpc' },
  }),
  field('transport', 'grpcInitialWindow', 'gRPC initial window (bytes)', 'number', 0, {
    min: 0,
    max: 2147483647,
    visibleWhen: { network: 'grpc' },
  }),
  ...transportTuningFields,
  field('transport', 'kcpMtu', 'mKCP MTU (bytes)', 'number', 1350, {
    min: 21,
    max: 65535,
    visibleWhen: { network: 'kcp' },
  }),
  field('transport', 'kcpTti', 'mKCP TTI (milliseconds)', 'number', 50, {
    min: 10,
    max: 1000,
    visibleWhen: { network: 'kcp' },
  }),
  field('transport', 'kcpUp', 'mKCP upload capacity (MB/s)', 'number', 5, {
    min: 0,
    max: 4294967295,
    visibleWhen: { network: 'kcp' },
  }),
  field('transport', 'kcpDown', 'mKCP download capacity (MB/s)', 'number', 20, {
    min: 0,
    max: 4294967295,
    visibleWhen: { network: 'kcp' },
  }),
  field('transport', 'kcpCwnd', 'mKCP congestion window multiplier', 'number', 1, {
    min: 1,
    max: 4294967295,
    visibleWhen: { network: 'kcp' },
  }),
  field('transport', 'kcpWindow', 'mKCP maximum sending window (bytes)', 'number', 20971520, {
    min: 21,
    max: 4294967295,
    visibleWhen: { network: 'kcp' },
  }),
  text('transport', 'hysteriaAuth', 'Hysteria transport authentication', {
    type: 'password',
    visibleWhen: { network: 'hysteria' },
  }),
  field('transport', 'hysteriaUdpTimeout', 'UDP idle timeout (seconds)', 'number', 60, {
    min: 2,
    max: 600,
    visibleWhen: { network: 'hysteria' },
  }),
  json('transport', 'xdriveSettings', 'XDrive settings (JSON)', {
    required: true,
    visibleWhen: { network: 'xdrive' },
    help: 'Full xdriveSettings: service, remoteFolder, secrets, template or s3, and optional transfer tuning.',
  }),
  field('security', 'security', 'Transport security', 'select', 'tls', {
    options: ['tls', 'reality', 'none'],
    optionLabels: { tls: 'TLS', reality: 'REALITY', none: 'None' },
  }),
  text('security', 'serverName', 'Server name (SNI)', {
    visibleWhen: securityWhen,
    help: 'TLS can use the server/HTTP host when blank. For REALITY, match an allowed server name.',
  }),
  field('security', 'fingerprint', 'Client fingerprint', 'select', 'chrome', {
    options: fingerprints,
    optionLabels: { '': 'Core default (Chrome)' },
    visibleWhen: securityWhen,
  }),
  text('security', 'alpn', 'ALPN', {
    visibleWhen: tlsWhen,
    placeholder: 'h2, http/1.1',
    help: 'Comma-separated protocol names. Leave blank for the core default.',
  }),
  text('security', 'realityPassword', 'REALITY public key / password', {
    required: true,
    visibleWhen: realityWhen,
    help: 'Server’s X25519 public key: 32 bytes in unpadded Base64URL. Current Xray calls this password; publicKey remains an alias.',
  }),
  text('security', 'shortId', 'REALITY short ID', {
    visibleWhen: realityWhen,
    help: '0–16 hexadecimal characters, in byte pairs. Empty is valid if allowed by the server.',
  }),
  field('security', 'spiderX', 'REALITY spider path', 'text', '/', {
    visibleWhen: realityWhen,
    help: 'Must start with /.',
  }),
  text('tls', 'pinnedPeerCertSha256', 'Pinned certificate SHA-256', {
    visibleWhen: tlsWhen,
    help: 'Comma-separated hexadecimal certificate hashes; colons are accepted.',
  }),
  text('tls', 'verifyPeerCertByName', 'Verify certificate names', {
    visibleWhen: tlsWhen,
    help: 'Optional comma-separated names for certificate verification.',
  }),
  field('tls', 'certificates', 'Certificates (JSON)', 'json', '', {
    maxLength: 65536,
    jsonShape: 'array',
    placeholder: '[{"certificateFile":"…","usage":"verify"}]',
    visibleWhen: tlsWhen,
    help: 'CA verification or client certificate entries, including certificate/key files or PEM line arrays.',
  }),
  field('tls', 'disableSystemRoot', 'Use only configured certificate roots', 'boolean', false, {
    visibleWhen: tlsWhen,
  }),
  field('tls', 'tlsMinVersion', 'Minimum TLS version', 'select', '', {
    options: ['', '1.0', '1.1', '1.2', '1.3'],
    optionLabels: { '': 'Core default' },
    visibleWhen: tlsWhen,
  }),
  field('tls', 'tlsMaxVersion', 'Maximum TLS version', 'select', '', {
    options: ['', '1.0', '1.1', '1.2', '1.3'],
    optionLabels: { '': 'Core default' },
    visibleWhen: tlsWhen,
  }),
  field('tls', 'sessionResumption', 'TLS session resumption', 'boolean', false, {
    visibleWhen: tlsWhen,
  }),
  text('tls', 'cipherSuites', 'TLS cipher suites', {
    visibleWhen: tlsWhen,
    help: 'Colon-separated cipher names; leave blank for the core default.',
  }),
  text('tls', 'curvePreferences', 'TLS curve preferences', {
    visibleWhen: tlsWhen,
    help: 'Comma-separated curve names.',
  }),
  field('tls', 'echConfigList', 'ECH config list / query', 'textarea', '', {
    maxLength: 65536,
    visibleWhen: tlsWhen,
    help: 'ECH configuration or DNS query form understood by Xray.',
  }),
  json('tls', 'echSockopt', 'ECH DNS socket options (JSON)', { visibleWhen: tlsWhen }),
  json('tls', 'tlsExtra', 'Additional TLS options (JSON)', {
    visibleWhen: tlsWhen,
    help: 'Additional tlsSettings keys. Named fields take precedence. Removed allowInsecure is not supported.',
  }),
  field('reality', 'mldsa65Verify', 'ML-DSA-65 verification key', 'textarea', '', {
    maxLength: 65536,
    visibleWhen: realityWhen,
    help: 'Optional 1,952-byte verification key, in unpadded Base64URL.',
  }),
  field('reality', 'realityShow', 'REALITY debug output', 'boolean', false, {
    visibleWhen: realityWhen,
  }),
  json('reality', 'realityExtra', 'Additional REALITY options (JSON)', {
    visibleWhen: realityWhen,
  }),
  ...fragmentFields,
  field('mux', 'muxEnabled', 'Enable multiplexing', 'boolean', false, {
    visibleWhen: { network: ['raw', 'ws', 'grpc', 'httpupgrade', 'kcp', 'hysteria', 'xdrive'] },
  }),
  field('mux', 'muxConcurrency', 'TCP multiplex concurrency', 'number', 8, {
    min: -1,
    max: 32767,
    visibleWhen: {
      muxEnabled: true,
      network: ['raw', 'ws', 'grpc', 'httpupgrade', 'kcp', 'hysteria', 'xdrive'],
    },
    help: 'Use -1 to disable TCP mux while retaining XUDP. Vision requires TCP mux disabled.',
  }),
  field('mux', 'xudpConcurrency', 'XUDP concurrency', 'number', 16, {
    min: -1,
    max: 32767,
    visibleWhen: {
      muxEnabled: true,
      network: ['raw', 'ws', 'grpc', 'httpupgrade', 'kcp', 'hysteria', 'xdrive'],
    },
  }),
  field('mux', 'xudpProxyUDP443', 'XUDP handling of UDP 443', 'select', 'reject', {
    options: ['reject', 'allow', 'skip'],
    visibleWhen: {
      muxEnabled: true,
      network: ['raw', 'ws', 'grpc', 'httpupgrade', 'kcp', 'hysteria', 'xdrive'],
    },
  }),
  ...socketFields,
  field('advanced', 'userLevel', 'User policy level', 'number', 0, { min: 0, max: 4294967295 }),
  text('advanced', 'email', 'User email / statistics label'),
  field('advanced', 'targetStrategy', 'Target address strategy', 'select', 'AsIs', {
    options: strategies,
  }),
  text('advanced', 'streamAddress', 'Transport address override'),
  field('advanced', 'streamPort', 'Transport port override', 'number', 0, {
    min: 0,
    max: 65535,
    help: '0 uses the VLESS server port.',
  }),
  json('advanced', 'reverse', 'VLESS reverse settings (JSON)', {
    help: 'Optional reverse object with a nonempty tag and optional sniffing settings.',
  }),
  json('advanced', 'finalmask', 'FinalMask (JSON)', {
    help: 'Complete finalmask object: tcp/udp masks and optional quicParams, including mKCP masking or Hysteria congestion/bandwidth options.',
  }),
  json('advanced', 'protocolExtra', 'Additional VLESS settings (JSON)', {
    help: 'Additional protocol settings for advanced/core-specific options. Named account/server fields take precedence.',
  }),
];

// SOCKS uses the same Xray stream/socket layer, with its own account fields.
// Do not expose VLESS flow, encryption, reverse or the VLESS fragment wrapper.
const socksFields: SettingDefinition[] = [
  identity('socks'),
  text('server', 'address', 'Server address', {
    required: true,
    placeholder: '127.0.0.1',
    help: 'SOCKS5 server hostname or IP address. Enter the port separately.',
  }),
  field('server', 'port', 'Server port', 'number', 1080, { min: 1, max: 65535 }),
  field('account', 'auth', 'Authentication', 'select', 'none', {
    options: ['none', 'password'],
    optionLabels: { none: 'No authentication', password: 'Username and password' },
  }),
  text('account', 'username', 'Username', {
    required: true,
    visibleWhen: { auth: 'password' },
    help: '1–255 UTF-8 bytes. Credentials must match the SOCKS server.',
  }),
  text('account', 'password', 'Password', {
    type: 'password',
    visibleWhen: { auth: 'password' },
    help: 'Up to 255 UTF-8 bytes. Credentials are sent inside the selected transport; ordinary SOCKS has no encryption.',
  }),
  ...vlessFields
    .filter(
      (f) =>
        ['transport', 'security', 'tls', 'reality', 'mux', 'socket', 'advanced'].includes(
          f.section!,
        ) && !['reverse', 'protocolExtra'].includes(f.key),
    )
    .map((f) =>
      f.key === 'security'
        ? { ...f, defaultValue: 'none' }
        : f.key === 'streamPort'
          ? { ...f, help: '0 uses the SOCKS server port.' }
          : f,
    ),
  json('advanced', 'protocolExtra', 'Additional SOCKS settings (JSON)', {
    help: 'Named server/account fields take precedence. Use separate outbound nodes and a policy group for multiple servers.',
  }),
];

function definition(
  kind: NodeKind,
  title: string,
  summary: string,
  fields: SettingDefinition[],
  sections: NodeDefinition['sections'],
): NodeDefinition {
  return {
    kind,
    title,
    summary,
    group: 'Outbounds',
    category: 'outbound',
    fields,
    sections,
    defaults: Object.fromEntries(fields.map((item) => [item.key, item.defaultValue!])),
  };
}
export const outboundDefinitions: NodeDefinition[] = [
  definition('vless-outbound', 'VLESS', 'A configured VLESS server destination', vlessFields, [
    { id: 'server', title: 'Server' },
    { id: 'account', title: 'Account' },
    { id: 'transport', title: 'Transport' },
    { id: 'security', title: 'Security' },
    { id: 'tls', title: 'TLS verification & tuning', advanced: true },
    { id: 'reality', title: 'REALITY advanced', advanced: true },
    { id: 'fragment', title: 'Fragmentation', advanced: true },
    { id: 'mux', title: 'Multiplexing', advanced: true },
    { id: 'socket', title: 'Socket & local connection', advanced: true },
    { id: 'advanced', title: 'Advanced', advanced: true },
  ]),
  definition(
    'socks-outbound',
    'SOCKS outbound',
    'Send traffic through a SOCKS5 server',
    socksFields,
    [
      {
        id: 'server',
        title: 'Server',
        description:
          'SOCKS5 destination. UDP uses the server’s UDP ASSOCIATE support; it has no separate outbound toggle.',
      },
      { id: 'account', title: 'Authentication' },
      {
        id: 'transport',
        title: 'Transport',
        description:
          'RAW/TCP is usual. Other transports require matching server-side configuration.',
      },
      { id: 'security', title: 'Security' },
      { id: 'tls', title: 'TLS verification & tuning', advanced: true },
      { id: 'reality', title: 'REALITY advanced', advanced: true },
      {
        id: 'mux',
        title: 'Multiplexing',
        advanced: true,
        description:
          'Enable only with a compatible Xray server. Ordinary SOCKS servers do not understand Xray mux.',
      },
      { id: 'socket', title: 'Socket & local connection', advanced: true },
      { id: 'advanced', title: 'Advanced', advanced: true },
    ],
  ),
  definition(
    'direct-outbound',
    'Direct',
    'Connect to the destination without a remote server',
    [
      identity('direct'),
      field('socket', 'icsUpstream', 'Use ICS upstream', 'boolean', false, { optional: true }),
      ...socketFields,
      text('direct', 'redirect', 'Destination override', {
        placeholder: 'host:port',
        help: 'Optional host:port, [IPv6]:port, or :port. Leave blank to retain the original destination.',
      }),
      field('direct', 'userLevel', 'User policy level', 'number', 0, { min: 0, max: 4294967295 }),
      field('direct', 'proxyProtocol', 'PROXY protocol', 'select', '0', {
        options: ['0', '1', '2'],
        optionLabels: { '0': 'Off', '1': 'Version 1', '2': 'Version 2' },
      }),
      json('direct', 'freedomExtra', 'Additional Direct settings (JSON)', {
        help: 'Optional freedom settings: fragment, noises, finalRules. Basic Direct needs no extra settings.',
      }),
    ],
    [
      { id: 'server', title: 'Route' },
      {
        id: 'socket',
        title: 'Connection',
        description: 'DNS strategy and optional local connection settings.',
      },
      { id: 'direct', title: 'Advanced', advanced: true },
    ],
  ),
  definition(
    'block-outbound',
    'Block',
    'End the path with Xray’s blackhole outbound',
    [
      identity('block'),
      text('server', 'reason', 'Reason', {
        help: 'Optional note for this graph; it is not sent to the destination.',
      }),
      field('response', 'response', 'Response', 'select', 'none', {
        options: ['none', 'http', 'custom'],
        optionLabels: { none: 'No response', http: 'HTTP 403', custom: 'Custom response' },
      }),
      field('response', 'customResponseData', 'Response bytes (Base64)', 'textarea', '', {
        required: true,
        maxLength: 65536,
        visibleWhen: { response: 'custom' },
        help: 'Standard Base64, including padding when required.',
      }),
    ],
    [
      { id: 'server', title: 'Route' },
      {
        id: 'response',
        title: 'Block response',
        description: 'Choose whether the blocked connection receives a response.',
      },
    ],
  ),
];

export const isOutboundKind = (kind: string) =>
  kind === 'policy-group' ||
  kind === 'proxy-chain' ||
  kind === 'xray-outbound' ||
  isExecutableOutboundKind(kind);
export const isExecutableOutboundKind = (kind: string) =>
  isProtocolOutbound(kind) ||
  kind === 'vless-outbound' ||
  kind === 'socks-outbound' ||
  kind === 'direct-outbound' ||
  kind === 'block-outbound';
const stringList = (value: SettingValue | undefined) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
function base64Bytes(value: string, url: boolean): number | null {
  if (
    url
      ? !/^[A-Za-z0-9_-]+$/.test(value)
      : !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  if (url && value.length % 4 === 1) return null;
  try {
    return atob(url ? value.replace(/-/g, '+').replace(/_/g, '/') : value).length;
  } catch {
    return null;
  }
}
export function validVlessId(value: string): boolean {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes >= 1 && bytes <= 30) return true;
  // Xray allows hyphens between any UUID byte groups, not only the canonical layout.
  if (bytes < 32 || bytes > 36) return false;
  let rest = value;
  for (const size of [8, 4, 4, 4, 12]) {
    if (rest.startsWith('-')) rest = rest.slice(1);
    if (!new RegExp(`^[0-9a-fA-F]{${size}}`).test(rest)) return false;
    rest = rest.slice(size);
  }
  return true;
}
export function validVlessEncryption(value: string): boolean {
  if (value === 'none') return true;
  const parts = value.split('.');
  return (
    parts.length >= 4 &&
    parts[0] === 'mlkem768x25519plus' &&
    ['native', 'xorpub', 'random'].includes(parts[1]) &&
    ['0rtt', '1rtt'].includes(parts[2]) &&
    parts
      .slice(3)
      .every((part) => part.length < 20 || [32, 1184].includes(base64Bytes(part, true) ?? -1))
  );
}

export function outboundProblems(data: RuleNodeData): Diagnostic[] {
  if (isProtocolOutbound(data.kind)) return protocolProblems(data);
  if (!isExecutableOutboundKind(data.kind)) return [];
  const s = data.settings;
  const issues: Diagnostic[] = [];
  const add = (fieldKey: string, message: string, severity: Diagnostic['severity'] = 'error') =>
    issues.push({ fieldKey, message, severity });
  if (data.kind === 'vless-outbound' || data.kind === 'socks-outbound') {
    if (String(s.address).trim() && /\s|\/|\?|#|@/.test(String(s.address)))
      add('address', 'Enter only a server hostname or IP address, without a URL or path.');
    if (data.kind === 'socks-outbound' && s.auth === 'password') {
      if (new TextEncoder().encode(String(s.username)).length > 255)
        add('username', 'Username must fit in 255 UTF-8 bytes.');
      if (new TextEncoder().encode(String(s.password)).length > 255)
        add('password', 'Password must fit in 255 UTF-8 bytes.');
    }
    if (data.kind === 'socks-outbound' && s.muxEnabled)
      add(
        'muxEnabled',
        'Xray mux requires a compatible server, not a standard SOCKS service.',
        'warning',
      );
    if (s.id && !validVlessId(String(s.id)))
      add('id', 'Enter a UUID or a custom ID of 1–30 UTF-8 bytes.');
    if (s.encryption && !validVlessEncryption(String(s.encryption)))
      add('encryption', 'Use none or a valid mlkem768x25519plus encryption string.');
    if (s.security === 'reality') {
      if (!['raw', 'xhttp', 'grpc'].includes(String(s.network)))
        add('security', 'REALITY supports RAW, XHTTP and gRPC only.');
      if (s.realityPassword && base64Bytes(String(s.realityPassword), true) !== 32)
        add('realityPassword', 'Use a 32-byte unpadded Base64URL public key.');
      if (!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(String(s.shortId)))
        add('shortId', 'Use up to 16 hexadecimal characters in byte pairs.');
      if (s.spiderX && !String(s.spiderX).startsWith('/'))
        add('spiderX', 'Start the spider path with /.');
      if (s.mldsa65Verify && base64Bytes(String(s.mldsa65Verify), true) !== 1952)
        add('mldsa65Verify', 'Use a 1,952-byte unpadded Base64URL verification key.');
      if (!String(s.serverName).trim())
        add('serverName', 'Set a server name allowed by the REALITY server.', 'warning');
    }
    if (
      s.flow &&
      s.encryption === 'none' &&
      (s.network !== 'raw' || !['tls', 'reality'].includes(String(s.security)))
    )
      add('flow', 'Vision without VLESS encryption needs RAW with TLS or REALITY.');
    if (
      s.flow &&
      s.security === 'tls' &&
      s.encryption === 'none' &&
      s.tlsMaxVersion &&
      s.tlsMaxVersion !== '1.3'
    )
      add('tlsMaxVersion', 'Vision requires TLS 1.3.');
    if (s.flow && s.muxEnabled && Number(s.muxConcurrency) >= 0)
      add('muxConcurrency', 'Disable TCP mux with -1 when using Vision; XUDP can remain enabled.');
    if (data.kind === 'vless-outbound' && s.security === 'none' && s.encryption === 'none')
      add(
        'security',
        'Current Xray permits unencrypted VLESS only to private addresses/domains. Verify that this endpoint is private.',
        'warning',
      );
    if (
      ['xhttp', 'ws', 'httpupgrade'].includes(String(s.network)) &&
      s.path &&
      !String(s.path).startsWith('/')
    )
      add('path', 'Start the HTTP path with /.');
    if (s.network === 'kcp' && Number(s.kcpWindow) < Number(s.kcpMtu))
      add('kcpWindow', 'The sending window must be at least the MTU.');
    if (s.network === 'hysteria' && s.security !== 'tls')
      add('security', 'Hysteria transport requires TLS.');
    if (s.security === 'tls') {
      if (s.tlsMinVersion && s.tlsMaxVersion && Number(s.tlsMinVersion) > Number(s.tlsMaxVersion))
        add('tlsMaxVersion', 'Maximum TLS version must be at least the minimum.');
      if (
        stringList(s.pinnedPeerCertSha256).some(
          (hash) => !/^[a-fA-F0-9]{64}$/.test(hash.replace(/:/g, '')),
        )
      )
        add('pinnedPeerCertSha256', 'Each certificate hash must contain 32 bytes of hexadecimal.');
    }
    if (s.network === 'ws' || s.network === 'httpupgrade') {
      try {
        const value: unknown = parseJson(String(s.headers || '{}'));
        const headers = jsonRecord(value) ? value : {};
        if (Object.values(headers).some((value) => typeof value !== 'string'))
          add('headers', 'Every HTTP header value must be a string.');
        if (Object.keys(headers).some((key) => key.toLowerCase() === 'host'))
          add('headers', 'Use the HTTP host field instead of a Host header.');
      } catch {
        /* Syntax diagnostics are provided by fieldProblem. */
      }
    }
    try {
      const reverse = s.reverse ? parseJsonObject(String(s.reverse)) : {};
      if (s.reverse && (typeof reverse.tag !== 'string' || !reverse.tag.trim()))
        add('reverse', 'Reverse settings need a nonempty tag.');
    } catch {
      /* Handled by fieldProblem. */
    }
    try {
      if (s.security === 'tls' && s.tlsExtra && parseJsonObject(String(s.tlsExtra)).allowInsecure)
        add(
          'tlsExtra',
          'allowInsecure was removed from current Xray. Use certificate pinning or verification names.',
        );
    } catch {
      /* Handled by fieldProblem. */
    }
  }
  if (
    data.kind === 'direct-outbound' &&
    s.redirect &&
    !/^(?:\[[0-9a-fA-F:.]+\]|[^\s:/]*):(?:[0-9]{1,5})$/.test(String(s.redirect))
  )
    add('redirect', 'Use host:port, [IPv6]:port, or :port.');
  if (data.kind === 'direct-outbound' && s.redirect) {
    const port = Number(String(s.redirect).split(':').at(-1));
    if (port < 1 || port > 65535) add('redirect', 'Destination override port must be 1–65535.');
  }
  if (
    data.kind === 'block-outbound' &&
    s.response === 'custom' &&
    s.customResponseData &&
    base64Bytes(String(s.customResponseData), false) === null
  )
    add('customResponseData', 'Enter standard Base64 response bytes.');
  issues.push(...tuningProblems(data));
  return issues;
}

// Node preview omits graph routing; the complete compiler adds connected paths.
function configuredOutboundPreview(data: RuleNodeData): Record<string, unknown> {
  if (isProtocolOutbound(data.kind)) return protocolConfig(data);
  const s = data.settings;
  const obj = (key: string): Record<string, unknown> =>
    s[key] ? (parseJson(String(s[key])) as Record<string, unknown>) : {};
  const explicitSocketNumber = (key: string) =>
    typeof s[key] === 'number' &&
    (!data.native ||
      valueAt(data.native.projection, ['streamSettings', 'sockopt', key]) !== undefined);
  const socket = {
    ...obj('sockoptExtra'),
    domainStrategy: s.domainStrategy,
    ...(s.interface ? { interface: s.interface } : {}),
    ...(s.dialerProxy ? { dialerProxy: s.dialerProxy } : {}),
    ...(s.tcpFastOpen === 'default' ? {} : { tcpFastOpen: s.tcpFastOpen === 'enabled' }),
    ...(s.tcpKeepAliveIdle || explicitSocketNumber('tcpKeepAliveIdle')
      ? { tcpKeepAliveIdle: s.tcpKeepAliveIdle }
      : {}),
    ...(s.tcpKeepAliveInterval || explicitSocketNumber('tcpKeepAliveInterval')
      ? { tcpKeepAliveInterval: s.tcpKeepAliveInterval }
      : {}),
    ...(s.tcpUserTimeout || explicitSocketNumber('tcpUserTimeout')
      ? { tcpUserTimeout: s.tcpUserTimeout }
      : {}),
    ...(s.happyEyeballsEnabled
      ? {
          happyEyeballs: {
            tryDelayMs: s.happyEyeballsDelay,
            prioritizeIPv6: s.happyEyeballsIPv6,
            interleave: s.happyEyeballsInterleave,
            maxConcurrentTry: s.happyEyeballsMax,
          },
        }
      : {}),
  };
  const common = { tag: s.tag, ...(s.sendThrough ? { sendThrough: s.sendThrough } : {}) };
  if (data.kind === 'block-outbound')
    return {
      tag: s.tag,
      protocol: 'blackhole',
      settings: {
        response: {
          type: s.response,
          ...(s.response === 'custom' ? { customResponseData: s.customResponseData } : {}),
        },
      },
    };
  if (data.kind === 'direct-outbound')
    return {
      ...common,
      protocol: 'freedom',
      settings: {
        ...obj('freedomExtra'),
        userLevel: s.userLevel,
        ...(s.redirect ? { redirect: s.redirect } : {}),
        proxyProtocol: Number(s.proxyProtocol),
      },
      streamSettings: { sockopt: socket },
    };
  const transport: Record<string, unknown> = {};
  const userHeaders = (headers: Record<string, unknown>) => {
    if (!s.userAgent) return headers;
    return {
      ...Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'user-agent'),
      ),
      'User-Agent': s.userAgent,
    };
  };
  const finalmask = tunedFinalMask(data);
  if (s.network === 'raw' && s.rawHeaderType === 'http') {
    const header = obj('rawHeader');
    const request = (header.request ?? {}) as Record<string, unknown>;
    transport.rawSettings = {
      header: {
        ...header,
        type: 'http',
        request: {
          ...request,
          ...(s.rawPath ? { path: [s.rawPath] } : {}),
          ...(s.rawHost || s.userAgent
            ? {
                headers: {
                  ...Object.fromEntries(
                    Object.entries((request.headers as Record<string, unknown>) ?? {}).filter(
                      ([key]) => !s.userAgent || key.toLowerCase() !== 'user-agent',
                    ),
                  ),
                  ...(s.rawHost ? { Host: stringList(s.rawHost) } : {}),
                  ...(s.userAgent ? { 'User-Agent': [s.userAgent] } : {}),
                },
              }
            : {}),
        },
      },
    };
  }
  if (s.network === 'xhttp') {
    const extra = obj('xhttpExtra');
    transport.xhttpSettings = {
      host: s.host,
      path: s.path,
      mode: s.xhttpMode,
      ...(s.xhttpExtra || s.userAgent
        ? {
            extra: {
              ...extra,
              ...(s.userAgent
                ? { headers: userHeaders((extra.headers as Record<string, unknown>) ?? {}) }
                : {}),
            },
          }
        : {}),
    };
  }
  if (s.network === 'ws')
    transport.wsSettings = {
      host: s.host,
      path: s.path,
      headers: userHeaders(obj('headers')),
      heartbeatPeriod: s.wsHeartbeat,
    };
  if (s.network === 'httpupgrade')
    transport.httpupgradeSettings = {
      host: s.host,
      path: s.path,
      headers: userHeaders(obj('headers')),
    };
  if (s.network === 'grpc')
    transport.grpcSettings = {
      serviceName: s.grpcServiceName,
      authority: s.grpcAuthority,
      multiMode: s.grpcMultiMode,
      idle_timeout: s.grpcIdleTimeout,
      health_check_timeout: s.grpcHealthTimeout,
      permit_without_stream: s.grpcPermitWithoutStream,
      initial_windows_size: s.grpcInitialWindow,
      user_agent: s.userAgent,
    };
  if (s.network === 'kcp')
    transport.kcpSettings = {
      mtu: s.kcpMtu,
      tti: s.kcpTti,
      uplinkCapacity: s.kcpUp,
      downlinkCapacity: s.kcpDown,
      cwndMultiplier: s.kcpCwnd,
      maxSendingWindow: s.kcpWindow,
    };
  if (s.network === 'hysteria')
    transport.hysteriaSettings = {
      version: 2,
      auth: s.hysteriaAuth,
      udpIdleTimeout: s.hysteriaUdpTimeout,
    };
  if (s.network === 'xdrive') transport.xdriveSettings = obj('xdriveSettings');
  if (s.security === 'tls')
    transport.tlsSettings = {
      ...obj('tlsExtra'),
      serverName: s.serverName,
      fingerprint: s.fingerprint,
      ...(s.alpn ? { alpn: stringList(s.alpn) } : {}),
      ...(s.pinnedPeerCertSha256 ? { pinnedPeerCertSha256: s.pinnedPeerCertSha256 } : {}),
      ...(s.verifyPeerCertByName ? { verifyPeerCertByName: s.verifyPeerCertByName } : {}),
      ...(s.certificates ? { certificates: parseJson(String(s.certificates)) } : {}),
      disableSystemRoot: s.disableSystemRoot,
      minVersion: s.tlsMinVersion,
      maxVersion: s.tlsMaxVersion,
      enableSessionResumption: s.sessionResumption,
      ...(s.cipherSuites ? { cipherSuites: s.cipherSuites } : {}),
      ...(s.curvePreferences ? { curvePreferences: stringList(s.curvePreferences) } : {}),
      ...(s.echConfigList ? { echConfigList: s.echConfigList } : {}),
      ...(s.echSockopt ? { echSockopt: obj('echSockopt') } : {}),
    };
  if (s.security === 'reality')
    transport.realitySettings = {
      ...obj('realityExtra'),
      serverName: s.serverName,
      fingerprint: s.fingerprint,
      password: s.realityPassword,
      shortId: s.shortId,
      spiderX: s.spiderX,
      show: s.realityShow,
      ...(s.mldsa65Verify ? { mldsa65Verify: s.mldsa65Verify } : {}),
    };
  const protocolSettings = {
    ...obj('protocolExtra'),
    address: s.address,
    port: s.port,
    level: s.userLevel,
    email: s.email,
  };
  // Never let advanced JSON supply a second endpoint or bypass the auth switch.
  if (data.kind === 'socks-outbound')
    for (const key of ['servers', 'user', 'pass'])
      delete (protocolSettings as Record<string, unknown>)[key];
  return {
    ...common,
    protocol: data.kind === 'socks-outbound' ? 'socks' : 'vless',
    settings:
      data.kind === 'socks-outbound'
        ? {
            ...protocolSettings,
            ...(s.auth === 'password' ? { user: s.username, pass: s.password } : {}),
          }
        : {
            ...protocolSettings,
            id: s.id,
            flow: s.flow,
            encryption: s.encryption,
            ...(s.reverse ? { reverse: obj('reverse') } : {}),
          },
    targetStrategy: s.targetStrategy,
    streamSettings: {
      network: s.network,
      security: s.security,
      ...transport,
      sockopt: socket,
      ...(s.streamAddress ? { address: s.streamAddress } : {}),
      ...(s.streamPort ? { port: s.streamPort } : {}),
      ...(Object.keys(finalmask).length ? { finalmask } : {}),
    },
    ...(s.muxEnabled && s.network !== 'xhttp'
      ? {
          mux: {
            enabled: true,
            concurrency: s.muxConcurrency,
            xudpConcurrency: s.xudpConcurrency,
            xudpProxyUDP443: s.xudpProxyUDP443,
          },
        }
      : {}),
  };
}

// A post-proxy fragment stage needs two real outbounds while retaining the
// graph's public tag for routing and dial-through dependencies.
export function outboundBundle(data: RuleNodeData): Record<string, unknown>[] {
  const outbound = outboundPreview(data);
  if (data.kind !== 'vless-outbound' || !data.settings.finalFragmentEnabled) return [outbound];
  const innerTag = 'wayrill-runtime-inner-' + String(data.settings.tag);
  return [
    {
      tag: data.settings.tag,
      protocol: 'freedom',
      settings: { userLevel: data.settings.userLevel },
      streamSettings: {
        finalmask: { tcp: [fragmentMask(data.settings)] },
        sockopt: { dialerProxy: innerTag, domainStrategy: 'AsIs' },
      },
    },
    { ...outbound, tag: innerTag },
  ];
}

export function outboundPreview(data: RuleNodeData): Record<string, unknown> {
  return omitCoreDefaults(data, configuredOutboundPreview(data));
}
