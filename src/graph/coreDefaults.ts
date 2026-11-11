import { jsonRecord as object, valueAt, jsonText, jsonArray } from './xrayJson';
export { valueAt } from './xrayJson';
import store from './xrayCoreDefaults.json';
import type { GlobalDefaults, SettingValue } from './types';

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

export { omitCoreDefaults } from '@wayrill/core/omitCoreDefaults';
