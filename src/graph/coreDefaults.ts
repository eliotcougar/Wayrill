import { jsonRecord as object, valueAt, jsonText, jsonArray, parseJson } from './xrayJson';
export { valueAt } from './xrayJson';
import store from './xrayCoreDefaults.json';
import type { GlobalDefaults, RuleNodeData, SettingValue } from './types';

export interface DefaultHint {
  text: string;
  source: 'core' | 'global' | 'native';
  detail?: string;
}
export const defaultSourceLabel = (hint: DefaultHint) =>
  hint.source === 'global'
    ? 'App default'
    : hint.source === 'native'
      ? 'Native value'
      : 'Xray default';
export function configuredDefaultHint(
  key: string,
  value: unknown,
  context: Parameters<typeof coreDefaultHint>[1] = {},
): string {
  if (
    value === 0 &&
    [
      'udpListenerReceiveKiB',
      'udpListenerSendKiB',
      'udpReceiveBufferKiB',
      'udpSendBufferKiB',
    ].includes(key)
  )
    return '0 → Windows default';
  const zeroSentinels = [
    'tcpKeepAliveIdle',
    'tcpKeepAliveInterval',
    'grpcIdleTimeout',
    'grpcHealthTimeout',
    'grpcInitialWindow',
    'hysteriaUdpTimeout',
  ];
  return value === 0 && zeroSentinels.includes(key)
    ? `0 → ${coreDefaultHint(coreDefaultField(key), context).text}`
    : formatDefault(value);
}
interface Entry {
  hint: string;
  value?: unknown;
  required?: boolean;
  sources: string[];
  contexts?: Record<string, string>;
}
const entries: Record<string, Entry> = store.fields;
const globals: Record<string, { field: string; encoded?: SettingValue }> = store.globals;
export const embeddedCoreDefaults = store.core;
export const coreDefaultField = (key: string) =>
  globals[key]?.field ??
  ([
    'udpListenerReceiveKiB',
    'udpListenerSendKiB',
    'udpReceiveBufferKiB',
    'udpSendBufferKiB',
  ].includes(key)
    ? 'Windows.socketBuffer'
    : undefined);
export const coreDefaultValue = (key: string): SettingValue => {
  const binding = globals[key],
    value = binding?.encoded ?? entries[binding?.field]?.value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : '';
};
export function formatDefault(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (value === '') return 'Empty — no value';
  if (jsonArray(value)) return value.length ? value.map(jsonText).join(', ') : 'None — empty list';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function coreDefaultHint(
  key: string,
  context: {
    object?: Record<string, unknown>;
    root?: Record<string, unknown>;
    direction?: 'inbound' | 'outbound';
    network?: string;
    parent?: Record<string, unknown>;
  } = {},
): DefaultHint {
  const entry = entries[key];
  let text = entry?.hint ?? (key === 'Windows.socketBuffer' ? 'Windows default' : 'Not configured');
  const network =
    context.network ?? jsonText(valueAt(context.root, ['streamSettings', 'network']) ?? 'raw');
  if (entry?.contexts && context.direction) {
    const transport =
      network === 'hysteria'
        ? 'hysteria'
        : network === 'masque' || valueAt(context.root, ['protocol']) === 'masque'
          ? 'masque'
          : 'http3';
    const plain =
      valueAt(context.root, [
        'streamSettings',
        'finalmask',
        'quicParams',
        'disableChromeParrot',
      ]) === true;
    text =
      entry.contexts[
        `${transport}:${context.direction === 'inbound' ? 'input' : 'output'}${plain ? ':plain' : ''}`
      ] ?? text;
    if (
      key === 'QuicParamsConfig.keepAlivePeriod' &&
      transport === 'http3' &&
      context.direction === 'outbound'
    ) {
      const period =
        valueAt(context.root, ['streamSettings', 'xhttpSettings', 'xmux', 'hKeepAlivePeriod']) ??
        valueAt(context.root, [
          'streamSettings',
          'xhttpSettings',
          'extra',
          'xmux',
          'hKeepAlivePeriod',
        ]);
      if (typeof period === 'number' && period !== 0)
        text = period > 0 ? `${period} seconds` : 'Disabled';
    }
  }
  if (key === 'TLSConfig.alpn' && ['ws', 'websocket', 'httpupgrade'].includes(network))
    text = 'http/1.1';
  if (key.startsWith('MasqueConfig.')) {
    const warp = object(context.object?.warp);
    if (key === 'MasqueConfig.path') text = warp ? '/' : '/.well-known/masque/ip/*/*/';
    if (key === 'MasqueConfig.host' && warp) text = 'cloudflareaccess.com';
    if (warp && ['MasqueConfig.user', 'MasqueConfig.pass'].includes(key))
      text = 'Omitted — WARP keys provide authentication';
  }
  if (key === 'TLSConfig.certificates' && context.direction === 'outbound')
    text =
      context.object?.disableSystemRoot === true
        ? 'Configured certificates only'
        : context.object?.useSystemCA === true
          ? 'Windows certificate store'
          : 'Bundled CA trust roots';
  const destination =
    valueAt(context.root, ['settings', 'address']) ??
    valueAt(context.root, ['settings', 'vnext', '0', 'address']) ??
    valueAt(context.root, ['settings', 'servers', '0', 'address']);
  const securityName =
    valueAt(context.root, ['streamSettings', 'tlsSettings', 'serverName']) ??
    valueAt(context.root, ['streamSettings', 'realitySettings', 'serverName']);
  const transportHost = valueAt(context.root, [
    'streamSettings',
    network === 'ws' ? 'wsSettings' : network === 'xhttp' ? 'xhttpSettings' : 'httpupgradeSettings',
    'host',
  ]);
  if (key === 'TLSConfig.serverName' && context.direction === 'outbound')
    text = jsonText(transportHost || destination || text);
  if (
    [
      'WebSocketConfig.host',
      'HttpUpgradeConfig.host',
      'SplitHTTPConfig.host',
      'MasqueConfig.host',
      'GRPCConfig.authority',
    ].includes(key) &&
    context.direction === 'outbound' &&
    (key !== 'MasqueConfig.host' || !object(context.object?.warp))
  )
    text = jsonText(securityName || destination || text);
  if (['SocketConfig.tcpKeepAliveIdle', 'SocketConfig.tcpKeepAliveInterval'].includes(key))
    text =
      context.direction === 'inbound'
        ? 'System timing for listener sockets'
        : '45 seconds for outbound TCP';
  if (key === 'TunConfig.autoOutboundsInterface')
    text =
      jsonArray(context.object?.autoSystemRoutingTable) &&
      context.object.autoSystemRoutingTable.length
        ? 'auto'
        : 'No interface override';
  if (key === 'SplitHTTPConfig.uplinkDataPlacement')
    text = context.object?.uplinkHTTPMethod === 'GET' ? 'header' : 'body (POST)';
  if (key.startsWith('NameServerConfig.') && context.parent) {
    const field = key.split('.')[1],
      v = valueAt(context.parent, [field]);
    if (
      [
        'queryStrategy',
        'clientIp',
        'tag',
        'disableCache',
        'serveStale',
        'serveExpiredTTL',
      ].includes(field)
    )
      text = v === undefined ? coreDefaultHint('DNSConfig.' + field).text : formatDefault(v);
  }
  const detail = entry ? `Xray ${store.core.version} · ${entry.sources.join(', ')}` : undefined;
  return { text, source: 'core', detail };
}
export function globalDefaultHint(
  key: string,
  defaults?: GlobalDefaults,
  context: Parameters<typeof coreDefaultHint>[1] = {},
): DefaultHint {
  const field = globals[key]?.field ?? key,
    base = coreDefaultHint(field, context),
    value = defaults?.settings[key];
  if (value === undefined || value === '') return base;
  // Zero is an explicit app value. Explain the core's zero-sentinel behavior,
  // rather than claiming that an omitted setting literally runs at zero.
  const text = configuredDefaultHint(key, value, context);
  return { text, source: 'global', detail: 'Configured in this workspace’s global defaults.' };
}

// These keys are derived by resolveNodeData, never saved in graph documents.
// Omit native settings instead of baking resolved core values into JSON. This
// preserves contextual defaults, and naturally follows the embedded core.
export function omitCoreDefaults(
  data: RuleNodeData,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!data.coreDefaults?.length) return raw;
  const result = structuredClone(raw),
    s = data.settings,
    network = String(s.network ?? valueAt(raw, ['streamSettings', 'network']) ?? 'raw'),
    security = String(s.security ?? valueAt(raw, ['streamSettings', 'security']) ?? 'none');
  const paths: Record<string, string[]> = {
    udp: ['settings', 'udp'],
    sniffing: ['sniffing', 'enabled'],
    routeOnly: ['sniffing', 'routeOnly'],
    metadataOnly: ['sniffing', 'metadataOnly'],
    domainsExcluded: ['sniffing', 'domainsExcluded'],
    ipsExcluded: ['sniffing', 'ipsExcluded'],
    streamSettings: ['streamSettings'],
    sendThrough: ['sendThrough'],
    targetStrategy: ['targetStrategy'],
    muxEnabled: ['mux', 'enabled'],
    muxConcurrency: ['mux', 'concurrency'],
    xudpConcurrency: ['mux', 'xudpConcurrency'],
    xudpProxyUDP443: ['mux', 'xudpProxyUDP443'],
    fingerprint: [
      'streamSettings',
      security === 'reality' ? 'realitySettings' : 'tlsSettings',
      'fingerprint',
    ],
    alpn: ['streamSettings', 'tlsSettings', 'alpn'],
    tlsMinVersion: ['streamSettings', 'tlsSettings', 'minVersion'],
    tlsMaxVersion: ['streamSettings', 'tlsSettings', 'maxVersion'],
    sessionResumption: ['streamSettings', 'tlsSettings', 'enableSessionResumption'],
    disableSystemRoot: ['streamSettings', 'tlsSettings', 'disableSystemRoot'],
    certificates: ['streamSettings', 'tlsSettings', 'certificates'],
    cipherSuites: ['streamSettings', 'tlsSettings', 'cipherSuites'],
    curvePreferences: ['streamSettings', 'tlsSettings', 'curvePreferences'],
    echSockopt: ['streamSettings', 'tlsSettings', 'echSockopt'],
    realityShow: ['streamSettings', 'realitySettings', 'show'],
    happyEyeballsEnabled: ['streamSettings', 'sockopt', 'happyEyeballs'],
    happyEyeballsDelay: ['streamSettings', 'sockopt', 'happyEyeballs', 'tryDelayMs'],
    happyEyeballsIPv6: ['streamSettings', 'sockopt', 'happyEyeballs', 'prioritizeIPv6'],
    happyEyeballsInterleave: ['streamSettings', 'sockopt', 'happyEyeballs', 'interleave'],
    happyEyeballsMax: ['streamSettings', 'sockopt', 'happyEyeballs', 'maxConcurrentTry'],
    wsHeartbeat: ['streamSettings', 'wsSettings', 'heartbeatPeriod'],
    xhttpMode: ['streamSettings', 'xhttpSettings', 'mode'],
    grpcIdleTimeout: ['streamSettings', 'grpcSettings', 'idle_timeout'],
    grpcHealthTimeout: ['streamSettings', 'grpcSettings', 'health_check_timeout'],
    grpcPermitWithoutStream: ['streamSettings', 'grpcSettings', 'permit_without_stream'],
    grpcInitialWindow: ['streamSettings', 'grpcSettings', 'initial_windows_size'],
    kcpMtu: ['streamSettings', 'kcpSettings', 'mtu'],
    kcpTti: ['streamSettings', 'kcpSettings', 'tti'],
    kcpUp: ['streamSettings', 'kcpSettings', 'uplinkCapacity'],
    kcpDown: ['streamSettings', 'kcpSettings', 'downlinkCapacity'],
    kcpCwnd: ['streamSettings', 'kcpSettings', 'cwndMultiplier'],
    kcpWindow: ['streamSettings', 'kcpSettings', 'maxSendingWindow'],
    hysteriaUdpTimeout: ['streamSettings', 'hysteriaSettings', 'udpIdleTimeout'],
  };
  for (const key of [
    'interface',
    'tcpFastOpen',
    'tcpKeepAliveIdle',
    'tcpKeepAliveInterval',
    'tcpUserTimeout',
  ])
    paths[key] = ['streamSettings', 'sockopt', key];
  paths.domainStrategy = ['streamSettings', 'sockopt', 'domainStrategy'];
  paths.userLevel = [
    'settings',
    data.kind.endsWith('inbound') || data.kind === 'direct-outbound' || data.kind === 'dns-outbound'
      ? 'userLevel'
      : 'level',
  ];
  const drop = (path: string[]) => {
    let target: unknown = result;
    for (const part of path.slice(0, -1)) target = valueAt(target, [part]);
    if (object(target)) {
      const name = Object.keys(target).find((k) => k.toLowerCase() === path.at(-1)!.toLowerCase());
      if (name) delete target[name];
    }
  };
  // Preserve explicit advanced JSON. Clearing the named app default relinquishes
  // its priority to that JSON; it does not erase a manually supplied option.
  const extraObjects: Record<string, string> = {
    sockoptExtra: 'sockopt',
    tlsExtra: 'tlsSettings',
    realityExtra: 'realitySettings',
    xhttpExtra: 'xhttpSettings',
  };
  for (const key of data.coreDefaults) {
    const path = paths[key];
    if (!path) continue;
    let advanced: unknown;
    for (const [extra, section] of Object.entries(extraObjects))
      if (path[1] === section && s[extra]) {
        try {
          advanced = valueAt(
            parseJson(String(s[extra])),
            path.slice(section === 'xhttpSettings' ? 3 : 2),
          );
        } catch {
          /* Normal field diagnostics handle malformed JSON. */
        }
      }
    if (advanced === undefined) drop(path);
    else {
      let target: Record<string, unknown> = result;
      for (const part of path.slice(0, -1)) {
        if (!object(target[part])) target[part] = {};
        target = target[part] as Record<string, unknown>;
      }
      target[path.at(-1)!] = advanced;
    }
  }
  if (data.coreDefaults.includes('muxEnabled') && !s.muxEnabled) delete result.mux;
  if (data.coreDefaults.includes('sniffing') && !s.sniffing) delete result.sniffing;
  if (data.coreDefaults.includes('userAgent')) {
    const transport =
      network === 'raw' || network === 'tcp'
        ? network === 'tcp'
          ? 'tcpSettings'
          : 'rawSettings'
        : network === 'ws'
          ? 'wsSettings'
          : network === 'httpupgrade'
            ? 'httpupgradeSettings'
            : network === 'grpc'
              ? 'grpcSettings'
              : 'xhttpSettings';
    if (network === 'grpc') drop(['streamSettings', transport, 'user_agent']);
    // Other transports already omit empty named headers and retain advanced headers.
  }
  if (data.coreDefaults.some((k) => ['sniffHttp', 'sniffTls', 'sniffQuic'].includes(k))) {
    const sniff = result.sniffing;
    if (object(sniff) && jsonArray(sniff.destOverride) && !sniff.destOverride.length)
      delete sniff.destOverride;
  }
  return result;
}
