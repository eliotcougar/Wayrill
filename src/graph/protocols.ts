import { isIpLiteral } from './addressValidation';
import { applyUdpBufferSettings } from './socketBuffers';
import {
  tunCaptureSettings,
  DEFAULT_TUN_ADAPTER_NAME,
  DEFAULT_ICS_ADAPTER_NAME,
  DEFAULT_ICS_GATEWAY,
  tunAdapterNameProblem,
  isTunKind,
} from './tun';
import { omitCoreDefaults } from './coreDefaults';
import { protocolSource } from './protocolSource';
import {
  checkJson,
  cloneJson,
  jsonEqual,
  jsonRecord,
  parseXrayJson,
  patchProjection,
  jsonText,
  jsonArray,
} from './xrayJson';
import { structureProblems } from './protocolFields';
import type {
  Diagnostic,
  NodeDefinition,
  NodeKind,
  ProtocolInboundKind,
  ProtocolOutboundKind,
  RuleNodeData,
  SettingDefinition,
  SettingValue,
} from './types';

export type ProtocolKind = ProtocolInboundKind | ProtocolOutboundKind;
export interface ProtocolSpec {
  kind: NodeKind;
  protocol: string;
  title: string;
  direction: 'inbound' | 'outbound';
  structure: keyof typeof protocolSource;
  aliases?: string[];
  note?: string;
}
export const protocolSpecs: ProtocolSpec[] = [
  {
    kind: 'tunnel-inbound',
    protocol: 'tunnel',
    title: 'Tunnel',
    direction: 'inbound',
    structure: 'DokodemoConfig',
    aliases: ['dokodemo-door'],
    note: 'Forwards TCP/UDP to a configured destination or the original destination. followRedirect needs platform capture support; this node does not install capture rules.',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'mixed',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'SocksServerConfig',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'socks',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'SocksServerConfig',
  },
  {
    kind: 'proxy-inbound',
    protocol: 'http',
    title: 'Proxy',
    direction: 'inbound',
    structure: 'HTTPServerConfig',
  },
  {
    kind: 'vless-inbound',
    protocol: 'vless',
    title: 'VLESS',
    direction: 'inbound',
    structure: 'VLessInboundConfig',
  },
  {
    kind: 'vmess-inbound',
    protocol: 'vmess',
    title: 'VMess',
    direction: 'inbound',
    structure: 'VMessInboundConfig',
  },
  {
    kind: 'trojan-inbound',
    protocol: 'trojan',
    title: 'Trojan',
    direction: 'inbound',
    structure: 'TrojanServerConfig',
  },
  {
    kind: 'shadowsocks-inbound',
    protocol: 'shadowsocks',
    title: 'Shadowsocks',
    direction: 'inbound',
    structure: 'ShadowsocksServerConfig',
  },
  {
    kind: 'wireguard-inbound',
    protocol: 'wireguard',
    title: 'WireGuard',
    direction: 'inbound',
    structure: 'WireGuardConfig',
    note: 'Uses Xray’s userspace WireGuard stack on Windows. Peers define authentication and allowed source addresses.',
  },
  {
    kind: 'hysteria-inbound',
    protocol: 'hysteria',
    title: 'Hysteria 2',
    direction: 'inbound',
    structure: 'HysteriaServerConfig',
  },
  {
    kind: 'masque-inbound',
    protocol: 'masque',
    title: 'MASQUE',
    direction: 'inbound',
    structure: 'MasqueServerConfig',
  },
  {
    kind: 'tun-inbound',
    protocol: 'tun',
    title: 'TUN adapter',
    direction: 'inbound',
    structure: 'TunConfig',
    note: 'Capture this PC through a service-managed Windows adapter.',
  },
  {
    kind: 'ics-tun',
    protocol: 'tun',
    title: 'ICS TUN',
    direction: 'inbound',
    structure: 'TunConfig',
    note: 'Route Windows Internet sharing through its own traffic path.',
  },
  {
    kind: 'direct-outbound',
    protocol: 'freedom',
    title: 'Direct',
    direction: 'outbound',
    structure: 'FreedomConfig',
    aliases: ['direct'],
  },
  {
    kind: 'block-outbound',
    protocol: 'blackhole',
    title: 'Block',
    direction: 'outbound',
    structure: 'BlackholeConfig',
    aliases: ['block'],
  },
  {
    kind: 'socks-outbound',
    protocol: 'socks',
    title: 'SOCKS',
    direction: 'outbound',
    structure: 'SocksClientConfig',
  },
  {
    kind: 'vless-outbound',
    protocol: 'vless',
    title: 'VLESS',
    direction: 'outbound',
    structure: 'VLessOutboundConfig',
  },
  {
    kind: 'http-outbound',
    protocol: 'http',
    title: 'HTTP CONNECT',
    direction: 'outbound',
    structure: 'HTTPClientConfig',
  },
  {
    kind: 'vmess-outbound',
    protocol: 'vmess',
    title: 'VMess',
    direction: 'outbound',
    structure: 'VMessOutboundConfig',
  },
  {
    kind: 'trojan-outbound',
    protocol: 'trojan',
    title: 'Trojan',
    direction: 'outbound',
    structure: 'TrojanClientConfig',
  },
  {
    kind: 'shadowsocks-outbound',
    protocol: 'shadowsocks',
    title: 'Shadowsocks',
    direction: 'outbound',
    structure: 'ShadowsocksClientConfig',
  },
  {
    kind: 'wireguard-outbound',
    protocol: 'wireguard',
    title: 'WireGuard',
    direction: 'outbound',
    structure: 'WireGuardConfig',
  },
  {
    kind: 'hysteria-outbound',
    protocol: 'hysteria',
    title: 'Hysteria 2',
    direction: 'outbound',
    structure: 'HysteriaClientConfig',
  },
  {
    kind: 'masque-outbound',
    protocol: 'masque',
    title: 'MASQUE',
    direction: 'outbound',
    structure: 'MasqueClientConfig',
    note: 'CONNECT-IP over HTTP/3. Credentials belong to masqueSettings. Xray rejects mux for this protocol.',
  },
  {
    kind: 'loopback-outbound',
    protocol: 'loopback',
    title: 'Loopback',
    direction: 'outbound',
    structure: 'LoopbackConfig',
    note: 'Reinjects traffic with the chosen inbound tag. Routing rules must terminate that traffic instead of returning it to this same loopback.',
  },
  {
    kind: 'dns-outbound',
    protocol: 'dns',
    title: 'DNS',
    direction: 'outbound',
    structure: 'DNSOutboundConfig',
    note: 'A DNS traffic handler, distinct from the global DNS resolver settings. Rewrite settings and request rules use native Xray semantics.',
  },
];
export const protocolInboundKinds: ProtocolInboundKind[] = [
  'tunnel-inbound',
  'vless-inbound',
  'vmess-inbound',
  'trojan-inbound',
  'shadowsocks-inbound',
  'wireguard-inbound',
  'hysteria-inbound',
  'masque-inbound',
  'tun-inbound',
  'ics-tun',
];
export const protocolOutboundKinds: ProtocolOutboundKind[] = [
  'http-outbound',
  'vmess-outbound',
  'trojan-outbound',
  'shadowsocks-outbound',
  'wireguard-outbound',
  'hysteria-outbound',
  'masque-outbound',
  'loopback-outbound',
  'dns-outbound',
];
export const isProtocolInbound = (kind: string): kind is ProtocolInboundKind =>
  (protocolInboundKinds as string[]).includes(kind);
export const isProtocolOutbound = (kind: string): kind is ProtocolOutboundKind =>
  (protocolOutboundKinds as string[]).includes(kind);
export const isProtocolKind = (kind: string): kind is ProtocolKind =>
  isProtocolInbound(kind) || isProtocolOutbound(kind);
export const specForKind = (kind: NodeKind) => protocolSpecs.find((s) => s.kind === kind);
export const specForProtocol = (protocol: unknown, direction: ProtocolSpec['direction']) =>
  protocolSpecs.find(
    (s) =>
      s.direction === direction &&
      [s.protocol, ...(s.aliases ?? [])].includes(String(protocol).toLowerCase()),
  );
export const nativeValue = (o: Record<string, unknown>, key: string): unknown =>
  o[Object.keys(o).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key];
export function setNative(
  o: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const result = cloneJson(o),
    aliases = Object.keys(result).filter((k) => k.toLowerCase() === key.toLowerCase());
  if (aliases.length > 1) throw new Error(`Resolve competing ${key} spellings in Native JSON.`);
  if (value === undefined) delete result[aliases[0] ?? key];
  else result[aliases[0] ?? key] = cloneJson(value);
  return result;
}
export function protocolJson(data: RuleNodeData): Record<string, unknown> {
  const value = parseXrayJson(String(data.settings.json));
  if (!jsonRecord(value)) throw new Error('Protocol options must be a JSON object.');
  if (Object.keys(value).some((k) => k.toLowerCase() === 'tag'))
    throw new Error('Use the node Tag field instead of adding tag to protocol options.');
  const spec = specForKind(data.kind);
  if (
    spec &&
    isProtocolKind(data.kind) &&
    (data.kind === 'ics-tun'
      ? nativeValue(value, 'protocol') !== 'tun'
      : specForProtocol(nativeValue(value, 'protocol'), spec.direction)?.kind !== data.kind)
  )
    throw new Error(
      'The protocol must match this node type. Add the appropriate node to change protocol.',
    );
  return value;
}

// Paths are source-defined; only active transport/security defaults are applied.
// Imported omissions remain native until an override is edited or Use default is chosen.
export function commonPath(
  key: string,
  raw: Record<string, unknown>,
  direction: ProtocolSpec['direction'],
): string[] | undefined {
  const stream = jsonRecord(nativeValue(raw, 'streamSettings'))
      ? (nativeValue(raw, 'streamSettings') as Record<string, unknown>)
      : {},
    network = jsonText(
      nativeValue(stream, 'method') ?? nativeValue(stream, 'network') ?? 'raw',
    ).toLowerCase(),
    security = jsonText(nativeValue(stream, 'security') ?? 'none').toLowerCase();
  const socket: Record<string, string> = {
    interface: 'interface',
    domainStrategy: 'domainStrategy',
    dialerProxy: 'dialerProxy',
    tcpFastOpen: 'tcpFastOpen',
    tcpKeepAliveIdle: 'tcpKeepAliveIdle',
    tcpKeepAliveInterval: 'tcpKeepAliveInterval',
    tcpUserTimeout: 'tcpUserTimeout',
  };
  if (socket[key]) return ['streamSettings', 'sockopt', socket[key]];
  if (key === 'sendThrough' || key === 'targetStrategy') return [key];
  const mux: Record<string, string> = {
    muxEnabled: 'enabled',
    muxConcurrency: 'concurrency',
    xudpConcurrency: 'xudpConcurrency',
    xudpProxyUDP443: 'xudpProxyUDP443',
  };
  if (mux[key] && network !== 'xhttp' && network !== 'splithttp') return ['mux', mux[key]];
  const tls: Record<string, string> = {
    fingerprint: 'fingerprint',
    alpn: 'alpn',
    tlsMinVersion: 'minVersion',
    tlsMaxVersion: 'maxVersion',
    sessionResumption: 'enableSessionResumption',
    disableSystemRoot: 'disableSystemRoot',
    cipherSuites: 'cipherSuites',
    curvePreferences: 'curvePreferences',
    certificates: 'certificates',
    echSockopt: 'echSockopt',
  };
  if (tls[key] && security === 'tls') return ['streamSettings', 'tlsSettings', tls[key]];
  if (key === 'fingerprint' && security === 'reality')
    return ['streamSettings', 'realitySettings', 'fingerprint'];
  if (key === 'realityShow' && security === 'reality')
    return ['streamSettings', 'realitySettings', 'show'];
  const sniff: Record<string, string> = {
    sniffing: 'enabled',
    routeOnly: 'routeOnly',
    metadataOnly: 'metadataOnly',
    domainsExcluded: 'domainsExcluded',
    ipsExcluded: 'ipsExcluded',
  };
  if (direction === 'inbound' && sniff[key]) return ['sniffing', sniff[key]];
  if (direction === 'inbound' && key === 'streamSettings') return ['streamSettings'];
  if (key === 'userLevel') {
    const protocol = String(nativeValue(raw, 'protocol')).toLowerCase();
    if (['tunnel', 'dokodemo-door', 'tun', 'dns'].includes(protocol))
      return ['settings', 'userLevel'];
    if (['http', 'vmess', 'trojan', 'shadowsocks'].includes(protocol) && direction === 'outbound') {
      const settings = nativeValue(raw, 'settings');
      if (jsonRecord(settings) && nativeValue(settings, 'address') === undefined) {
        const endpoints = protocol === 'vmess' ? 'vnext' : 'servers';
        if (jsonArray(nativeValue(settings, endpoints)))
          return ['settings', endpoints, '*', 'users', '*', 'level'];
      }
      return ['settings', 'level'];
    }
  }
  if (key === 'userAgent') {
    const paths: Record<string, string[]> = {
      ws: ['wsSettings', 'headers', 'User-Agent'],
      httpupgrade: ['httpupgradeSettings', 'headers', 'User-Agent'],
      grpc: ['grpcSettings', 'user_agent'],
      xhttp: ['xhttpSettings', 'extra', 'headers', 'User-Agent'],
      splithttp: ['splithttpSettings', 'extra', 'headers', 'User-Agent'],
    };
    if (paths[network]) return ['streamSettings', ...paths[network]];
    const tcp = network === 'tcp' ? 'tcpSettings' : 'rawSettings',
      options = nativeValue(stream, tcp);
    if (
      ['raw', 'tcp'].includes(network) &&
      jsonRecord(options) &&
      jsonRecord(nativeValue(options, 'header')) &&
      nativeValue(nativeValue(options, 'header') as Record<string, unknown>, 'type') === 'http'
    )
      return ['streamSettings', tcp, 'header', 'request', 'headers', 'User-Agent'];
  }
  const tune: Record<string, [string, string, string[]]> = {
    wsHeartbeat: ['ws', 'heartbeatPeriod', ['wsSettings']],
    xhttpMode: ['xhttp', 'mode', ['xhttpSettings']],
    grpcIdleTimeout: ['grpc', 'idle_timeout', ['grpcSettings']],
    grpcHealthTimeout: ['grpc', 'health_check_timeout', ['grpcSettings']],
    grpcPermitWithoutStream: ['grpc', 'permit_without_stream', ['grpcSettings']],
    grpcInitialWindow: ['grpc', 'initial_windows_size', ['grpcSettings']],
    kcpMtu: ['kcp', 'mtu', ['kcpSettings']],
    kcpTti: ['kcp', 'tti', ['kcpSettings']],
    kcpUp: ['kcp', 'uplinkCapacity', ['kcpSettings']],
    kcpDown: ['kcp', 'downlinkCapacity', ['kcpSettings']],
    kcpCwnd: ['kcp', 'cwndMultiplier', ['kcpSettings']],
    kcpWindow: ['kcp', 'maxSendingWindow', ['kcpSettings']],
    hysteriaUdpTimeout: ['hysteria', 'udpIdleTimeout', ['hysteriaSettings']],
  };
  if (tune[key]) {
    const [n, k, path] = tune[key];
    if (network === n || (network === 'splithttp' && n === 'xhttp'))
      return ['streamSettings', ...path, k];
  }
  if (network === 'hysteria' && ['hysteriaUp', 'hysteriaDown'].includes(key))
    return [
      'streamSettings',
      'finalmask',
      'quicParams',
      key === 'hysteriaUp' ? 'brutalUp' : 'brutalDown',
    ];
  if (network === 'hysteria' && key === 'hysteriaHopInterval') {
    const mask = nativeValue(stream, 'finalmask'),
      udp = jsonRecord(mask) ? nativeValue(mask, 'udp') : undefined,
      index = jsonArray(udp)
        ? udp.findIndex((m) => jsonRecord(m) && nativeValue(m, 'type') === 'udphop')
        : -1;
    if (index >= 0)
      return ['streamSettings', 'finalmask', 'udp', String(index), 'settings', 'interval'];
  }
  const objects: Record<string, [string, string]> = {
    sockoptExtra: ['', 'sockopt'],
    tlsExtra: ['tls', 'tlsSettings'],
    realityExtra: ['reality', 'realitySettings'],
    xhttpExtra: ['xhttp', 'xhttpSettings.extra'],
    finalmask: ['', 'finalmask'],
  };
  if (objects[key]) {
    const [mode, name] = objects[key];
    if (!mode || mode === security || mode === network)
      return ['streamSettings', ...name.split('.')];
  }
  if (key.startsWith('happyEyeballs')) {
    const k = (
      {
        happyEyeballsEnabled: '',
        happyEyeballsDelay: 'tryDelayMs',
        happyEyeballsIPv6: 'prioritizeIPv6',
        happyEyeballsInterleave: 'interleave',
        happyEyeballsMax: 'maxConcurrentTry',
      } as Record<string, string>
    )[key];
    if (k !== undefined) return ['streamSettings', 'sockopt', 'happyEyeballs', ...(k ? [k] : [])];
  }
  return undefined;
}
function getPath(o: unknown, path: string[]): unknown {
  for (const key of path) {
    if (key === '*' || /^\d+$/.test(key)) {
      if (!jsonArray(o)) return undefined;
      o = o[key === '*' ? 0 : Number(key)];
    } else {
      if (!jsonRecord(o)) return undefined;
      o = nativeValue(o, key);
    }
  }
  return o;
}
function putPath(
  o: Record<string, unknown>,
  path: string[],
  v: unknown,
  replace: boolean,
): Record<string, unknown> {
  const update = (value: unknown, keys: string[]): unknown => {
    const [key, ...rest] = keys;
    if (key === '*') return jsonArray(value) ? value.map((entry) => update(entry, rest)) : value;
    if (/^\d+$/.test(key) && jsonArray(value))
      return value.map((entry, index) => (index === Number(key) ? update(entry, rest) : entry));
    const obj = jsonRecord(value) ? value : {};
    if (!rest.length)
      return replace || nativeValue(obj, key) === undefined ? setNative(obj, key, v) : obj;
    return setNative(obj, key, update(nativeValue(obj, key), rest));
  };
  return update(o, path) as Record<string, unknown>;
}
const listKeys = ['alpn', 'curvePreferences'];
const jsonKeys = [
  'certificates',
  'echSockopt',
  'sockoptExtra',
  'tlsExtra',
  'realityExtra',
  'xhttpExtra',
  'finalmask',
  'domainsExcluded',
  'ipsExcluded',
  'streamSettings',
];
function commonValue(key: string, value: SettingValue, s: RuleNodeData['settings']): unknown {
  if (key === 'tcpFastOpen') return value === 'default' ? undefined : value === 'enabled';
  if (['hysteriaUp', 'hysteriaDown'].includes(key)) return value ? `${value}mbps` : undefined;
  if (listKeys.includes(key))
    return value
      ? String(value)
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean)
      : undefined;
  if (jsonKeys.includes(key)) return value ? parseXrayJson(String(value)) : undefined;
  if (key === 'happyEyeballsEnabled')
    return value
      ? {
          tryDelayMs: s.happyEyeballsDelay,
          prioritizeIPv6: s.happyEyeballsIPv6,
          interleave: s.happyEyeballsInterleave,
          maxConcurrentTry: s.happyEyeballsMax,
        }
      : undefined;
  if (key.startsWith('happyEyeballs') && !s.happyEyeballsEnabled) return undefined;
  return value === '' ? undefined : value;
}
export const sharedSocketKeys = [
  'udpReceiveBufferKiB',
  'udpSendBufferKiB',
  'sendThrough',
  'interface',
  'domainStrategy',
  'dialerProxy',
  'tcpFastOpen',
  'tcpKeepAliveIdle',
  'tcpKeepAliveInterval',
  'tcpUserTimeout',
  'happyEyeballsEnabled',
  'happyEyeballsDelay',
  'happyEyeballsIPv6',
  'happyEyeballsInterleave',
  'happyEyeballsMax',
  'targetStrategy',
  'sockoptExtra',
];
export const sharedStreamKeys = [
  'fingerprint',
  'alpn',
  'tlsMinVersion',
  'tlsMaxVersion',
  'sessionResumption',
  'disableSystemRoot',
  'cipherSuites',
  'curvePreferences',
  'certificates',
  'tlsExtra',
  'echSockopt',
  'realityShow',
  'realityExtra',
  'userAgent',
  'muxEnabled',
  'muxConcurrency',
  'xudpConcurrency',
  'xudpProxyUDP443',
  'wsHeartbeat',
  'xhttpMode',
  'grpcIdleTimeout',
  'grpcHealthTimeout',
  'grpcPermitWithoutStream',
  'grpcInitialWindow',
  'kcpMtu',
  'kcpTti',
  'kcpUp',
  'kcpDown',
  'kcpCwnd',
  'kcpWindow',
  'hysteriaUdpTimeout',
  'hysteriaUp',
  'hysteriaDown',
  'hysteriaHopInterval',
  'xhttpExtra',
  'finalmask',
];
export const sharedInputKeys = [
  'sniffing',
  'sniffHttp',
  'sniffTls',
  'sniffQuic',
  'routeOnly',
  'metadataOnly',
  'domainsExcluded',
  'ipsExcluded',
  'userLevel',
  'streamSettings',
];
export const streamProtocolOutbounds: ProtocolOutboundKind[] = [
  'http-outbound',
  'vmess-outbound',
  'trojan-outbound',
  'shadowsocks-outbound',
  'hysteria-outbound',
];
export const socketProtocolOutbounds: ProtocolOutboundKind[] = [
  ...streamProtocolOutbounds,
  'masque-outbound',
  'wireguard-outbound',
  'dns-outbound',
];
export function commonKeys(kind: NodeKind): string[] {
  if (isProtocolInbound(kind))
    return sharedInputKeys.filter(
      (k) =>
        (!['tun-inbound', 'ics-tun'].includes(kind) || k !== 'streamSettings') &&
        (k !== 'userLevel' || ['tun-inbound', 'ics-tun', 'tunnel-inbound'].includes(kind)),
    );
  if (!isProtocolOutbound(kind)) return [];
  return [
    ...(socketProtocolOutbounds.includes(kind) ? sharedSocketKeys : []),
    ...(streamProtocolOutbounds.includes(kind)
      ? sharedStreamKeys
      : kind === 'masque-outbound'
        ? sharedStreamKeys.filter((k) => !k.startsWith('mux') && !k.startsWith('xudp'))
        : []),
    ...([
      'http-outbound',
      'vmess-outbound',
      'trojan-outbound',
      'shadowsocks-outbound',
      'dns-outbound',
    ].includes(kind)
      ? ['userLevel']
      : []),
  ];
}
export function hydrateProtocolCommon(
  raw: Record<string, unknown>,
  defaults: RuleNodeData['settings'],
  direction: ProtocolSpec['direction'],
): RuleNodeData['settings'] {
  const s = { ...defaults };
  for (const key of Object.keys(s)) {
    const path = commonPath(key, raw, direction);
    if (!path) continue;
    const value = getPath(raw, path);
    if (value === undefined) continue;
    if (key === 'tcpFastOpen' && typeof value === 'boolean')
      s[key] = value ? 'enabled' : 'disabled';
    else if (listKeys.includes(key) && jsonArray(value)) s[key] = value.join(', ');
    else if (jsonKeys.includes(key)) s[key] = JSON.stringify(value);
    else if (key === 'happyEyeballsEnabled') s[key] = jsonRecord(value);
    else if (
      ['hysteriaUp', 'hysteriaDown'].includes(key) &&
      typeof value === 'string' &&
      /^\d+mbps$/i.test(value)
    )
      s[key] = Number(value.replace(/mbps/i, ''));
    else if (key === 'hysteriaHopInterval' && typeof value === 'number') s[key] = String(value);
    else if (key === 'userAgent' && jsonArray(value) && value.every((v) => typeof v === 'string'))
      s[key] = value[0] ?? '';
    else if (typeof value === typeof s[key]) s[key] = value as SettingValue;
  }
  const sniff = nativeValue(raw, 'sniffing');
  if (jsonRecord(sniff) && jsonArray(sniff.destOverride))
    for (const [key, name] of [
      ['sniffHttp', 'http'],
      ['sniffTls', 'tls'],
      ['sniffQuic', 'quic'],
    ])
      if (Object.hasOwn(s, key)) s[key] = sniff.destOverride.includes(name);
  return s;
}
export function protocolPreview(data: RuleNodeData): Record<string, unknown> {
  let raw = protocolJson(data);
  const spec = specForKind(data.kind);
  if (!spec) throw new Error('Unknown protocol node.');
  const s = data.settings,
    baseline = s.commonBaseline ? parseXrayJson(String(s.commonBaseline)) : undefined;
  const keys = commonKeys(data.kind),
    objectsFirst = [
      'streamSettings',
      'sockoptExtra',
      'tlsExtra',
      'realityExtra',
      'xhttpExtra',
      'finalmask',
    ];
  for (const key of [
    ...keys.filter((k) => objectsFirst.includes(k)),
    ...keys.filter((k) => !objectsFirst.includes(k)),
  ]) {
    const path = commonPath(key, raw, spec.direction);
    if (!path) continue;
    if (data.coreDefaults?.includes(key)) {
      if (!objectsFirst.includes(key)) raw = putPath(raw, path, undefined, true);
      continue;
    }
    const changed =
        data.native?.editedKeys?.includes(key) ||
        (jsonRecord(baseline) && !jsonEqual(baseline[key], s[key])),
      reset = data.native?.overrideKeys?.includes(key) && !data.overrides?.includes(key);
    if (baseline && !changed && !reset) continue;
    let value = commonValue(key, s[key], s);
    if (key === 'userAgent' && path.includes('request') && value !== undefined) value = [value];
    // Empty defaults do not erase native values on newly added nodes. Explicit
    // changes/reset do erase them, including false and zero.
    if (value === undefined && !changed && !reset) continue;
    if (
      path.at(-1) === 'extra' ||
      ['streamSettings', 'sockoptExtra', 'tlsExtra', 'realityExtra', 'finalmask'].includes(key)
    ) {
      const old = getPath(raw, path);
      if (
        key === 'streamSettings' &&
        jsonRecord(old) &&
        jsonRecord(value) &&
        jsonRecord(old.sockopt) &&
        jsonRecord(value.sockopt)
      )
        value = { ...value, sockopt: { ...old.sockopt, ...value.sockopt } };
      raw = putPath(
        raw,
        path,
        jsonRecord(value) ? { ...(jsonRecord(old) ? old : {}), ...value } : value,
        true,
      );
    } else
      raw = putPath(
        raw,
        path,
        value,
        !baseline || !!changed || !!reset || !!data.overrides?.includes(key),
      );
  }
  if (spec.direction === 'inbound') {
    const sniffChanged = ['sniffHttp', 'sniffTls', 'sniffQuic'].some((k) =>
      jsonRecord(baseline)
        ? data.native?.editedKeys?.includes(k) ||
          !jsonEqual(baseline[k], s[k]) ||
          (data.native?.overrideKeys?.includes(k) && !data.overrides?.includes(k))
        : !jsonRecord(nativeValue(raw, 'sniffing')) ||
          nativeValue(nativeValue(raw, 'sniffing') as Record<string, unknown>, 'destOverride') ===
            undefined,
    );
    if (sniffChanged && s.sniffing) {
      const old = nativeValue(raw, 'sniffing');
      const overrides = jsonRecord(old) ? nativeValue(old, 'destOverride') : undefined;
      raw = setNative(
        raw,
        'sniffing',
        setNative(
          jsonRecord(old) ? old : {},
          'destOverride',
          [
            ...(jsonArray(overrides)
              ? overrides.filter((name) => !['http', 'tls', 'quic'].includes(String(name)))
              : []),
            s.sniffHttp && 'http',
            s.sniffTls && 'tls',
            s.sniffQuic && 'quic',
          ].filter(Boolean),
        ),
      );
    }
  }
  const stream = nativeValue(raw, 'streamSettings');
  if (
    jsonRecord(stream) &&
    nativeValue(stream, 'network') === 'hysteria' &&
    ['hysteriaUp', 'hysteriaDown'].some(
      (k) =>
        !baseline ||
        data.native?.editedKeys?.includes(k) ||
        (jsonRecord(baseline) && !jsonEqual(baseline[k], s[k])) ||
        (data.native?.overrideKeys?.includes(k) && !data.overrides?.includes(k)),
    )
  ) {
    const path = ['streamSettings', 'finalmask', 'quicParams', 'congestion'];
    if (Number(s.hysteriaUp) > 0 || Number(s.hysteriaDown) > 0)
      raw = putPath(raw, path, 'brutal', true);
    else if (getPath(raw, path) === 'brutal') raw = putPath(raw, path, undefined, true);
  }
  if (spec.direction === 'outbound') {
    const stream = nativeValue(raw, 'streamSettings');
    const sockopt = jsonRecord(stream) ? nativeValue(stream, 'sockopt') : undefined;
    const next = applyUdpBufferSettings(jsonRecord(sockopt) ? sockopt : {}, data);
    if (next !== sockopt && (jsonRecord(sockopt) || Object.keys(next).length))
      raw = putPath(
        raw,
        ['streamSettings', 'sockopt'],
        Object.keys(next).length ? next : undefined,
        true,
      );
  }
  raw = omitCoreDefaults(data, setNative(raw, 'tag', s.tag || undefined));
  checkJson(raw);
  return raw;
}
export function protocolConfig(data: RuleNodeData): Record<string, unknown> {
  const current = protocolPreview(data);
  return omitCoreDefaults(
    data,
    data.native
      ? (patchProjection(data.native.original, data.native.projection, current) as Record<
          string,
          unknown
        >)
      : current,
  );
}
const protoSettings = (protocol: string): Record<string, unknown> => {
  if (protocol === 'vless') return { decryption: 'none', clients: [] };
  if (['vmess', 'trojan'].includes(protocol)) return { clients: [] };
  if (protocol === 'shadowsocks') return { method: 'aes-128-gcm', password: '' };
  if (protocol === 'wireguard')
    return { secretKey: '', address: ['10.90.0.1'], peers: [], noKernelTun: true };
  if (protocol === 'hysteria') return { version: 2, clients: [] };
  if (protocol === 'masque') return { clients: [], address: ['10.90.0.1/24'], mtu: 1500 };
  if (protocol === 'tun') return tunCaptureSettings(true);
  return { rewriteAddress: '127.0.0.1', rewritePort: 8080, allowedNetwork: 'tcp,udp' };
};
export function protocolTemplate(spec: ProtocolSpec): Record<string, unknown> {
  const udp = spec.protocol === 'hysteria' || spec.protocol === 'masque';
  const stream = udp
    ? {
        network: spec.protocol,
        security: 'tls',
        ...(spec.protocol === 'hysteria'
          ? { hysteriaSettings: { version: 2 } }
          : { masqueSettings: {} }),
      }
    : {};
  if (spec.direction === 'inbound')
    return {
      protocol: spec.protocol,
      ...(spec.protocol === 'tun' ? {} : { listen: '127.0.0.1', port: 2082 }),
      settings:
        spec.kind === 'ics-tun'
          ? {
              name: DEFAULT_ICS_ADAPTER_NAME,
              gateway: [DEFAULT_ICS_GATEWAY],
              autoSystemRoutingTable: [],
              autoOutboundsInterface: 'auto',
            }
          : protoSettings(spec.protocol),
      ...(udp ? { streamSettings: stream } : {}),
    };
  const settings =
    spec.protocol === 'wireguard'
      ? protoSettings('wireguard')
      : spec.protocol === 'loopback'
        ? { inboundTag: 'loopback-traffic' }
        : spec.protocol === 'dns'
          ? {}
          : {
              address: 'example.com',
              port: 443,
              ...(spec.protocol === 'vmess'
                ? { id: '', security: 'auto' }
                : spec.protocol === 'trojan'
                  ? { password: '' }
                  : spec.protocol === 'shadowsocks'
                    ? { method: 'aes-128-gcm', password: '' }
                    : spec.protocol === 'hysteria'
                      ? { version: 2 }
                      : {}),
            };
  return { protocol: spec.protocol, settings, ...(udp ? { streamSettings: stream } : {}) };
}
export function protocolDefinitions(
  outbound: NodeDefinition,
  inbound: NodeDefinition,
): NodeDefinition[] {
  return protocolSpecs
    .filter((spec) => isProtocolKind(spec.kind))
    .map((spec) => {
      const localCapture = ['tun-inbound', 'ics-tun'].includes(spec.kind),
        keys = commonKeys(spec.kind),
        source = spec.direction === 'inbound' ? inbound.fields : outbound.fields;
      const shared = keys
        .map((k) => source.find((f) => f.key === k))
        .filter((f): f is SettingDefinition => !!f)
        .map((f) => ({ ...f, section: 'defaults', visibleWhen: undefined, required: false }));
      const fields: SettingDefinition[] = [
        {
          key: 'tag',
          label: `${localCapture ? 'Capture' : spec.direction === 'inbound' ? 'Inbound' : 'Outbound'} tag`,
          type: 'text',
          maxLength: 4096,
          required: false,
        },
        {
          key: 'json',
          label: 'Native protocol options (JSON)',
          type: 'json',
          jsonShape: 'object',
          maxLength: 524288,
        },
        {
          key: 'commonBaseline',
          label: 'Default comparison baseline',
          type: 'text',
          maxLength: 65536,
          required: false,
        },
        ...(spec.kind === 'ics-tun'
          ? ['sharingVersion', 'publicId', 'privateId'].map((key) => ({
              key,
              label: key,
              type: 'text' as const,
              optional: true,
              maxLength: 128,
            }))
          : []),
        ...(spec.kind === 'ics-tun'
          ? [
              {
                key: 'shareIpv6',
                label: 'Share IPv6 with clients',
                type: 'boolean' as const,
                optional: true,
                defaultValue: false,
              },
            ]
          : []),
        ...shared,
        ...(spec.kind === 'tun-inbound'
          ? [
              {
                key: 'separateNatTraffic',
                label: 'Separate Windows NAT traffic',
                type: 'boolean' as const,
                optional: true,
                defaultValue: false,
              },
            ]
          : []),
      ];
      return {
        kind: spec.kind,
        title: localCapture
          ? spec.title
          : `${spec.title} ${spec.direction === 'inbound' ? 'inbound' : 'outbound'}`,
        group: localCapture
          ? 'Local capture'
          : spec.direction === 'inbound'
            ? 'Inbounds'
            : 'Outbounds',
        category: spec.direction,
        summary:
          spec.note ??
          `Source-defined ${spec.title} settings, transport, accounts and native import/export`,
        fields,
        defaults: {
          tag: spec.kind === 'ics-tun' ? 'ics-traffic' : `${spec.protocol}-${spec.direction}`,
          json: JSON.stringify(protocolTemplate(spec), null, 2),
          commonBaseline: '',
          ...(spec.kind === 'tun-inbound' ? { separateNatTraffic: false } : {}),
          ...(spec.kind === 'ics-tun'
            ? { sharingVersion: '', publicId: '', privateId: '', shareIpv6: false }
            : {}),
          ...Object.fromEntries(
            shared.filter((f) => f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue!]),
          ),
        },
      };
    });
}
/** Adapter settings own the capture name; graph labels are its display projection. */
export function captureNodeName(data: RuleNodeData): string {
  if (!isTunKind(data.kind)) return data.label;
  try {
    const settings = nativeValue(protocolJson(data), 'settings');
    const name = jsonRecord(settings) ? nativeValue(settings, 'name') : undefined;
    if (typeof name === 'string' && name) return name;
    return data.kind === 'ics-tun' ? DEFAULT_ICS_ADAPTER_NAME : DEFAULT_TUN_ADAPTER_NAME;
  } catch {
    return data.label;
  }
}

export function protocolSummary(data: RuleNodeData): [string, string][] {
  if (isTunKind(data.kind)) return [];
  try {
    const j = protocolConfig(data),
      settings = nativeValue(j, 'settings');
    return isProtocolInbound(data.kind)
      ? [
          ['Protocol', String(j.protocol)],
          ['Listen', `${jsonText(j.listen ?? '')}:${jsonText(j.port ?? '')}`],
        ]
      : [
          ['Protocol', String(j.protocol)],
          [
            'Destination',
            jsonRecord(settings)
              ? jsonText(
                  settings.address ??
                    settings.inboundTag ??
                    (jsonArray(settings.peers)
                      ? `${settings.peers.length} peers`
                      : data.settings.tag),
                )
              : String(data.settings.tag),
          ],
        ];
  } catch {
    return [['Configuration', 'Invalid draft']];
  }
}
export function protocolProblems(data: RuleNodeData): Diagnostic[] {
  if (!isProtocolKind(data.kind)) return [];
  const add = (message: string, severity: Diagnostic['severity'] = 'error'): Diagnostic => ({
    message,
    severity,
    fieldKey: 'json',
  });
  try {
    const raw = protocolConfig(data),
      spec = specForKind(data.kind)!,
      settings = nativeValue(raw, 'settings') ?? {};
    if (!jsonRecord(settings)) return [add('Protocol settings must be an object.')];
    const issues: Diagnostic[] = structureProblems(spec.structure, settings).map((message) =>
        add(message),
      ),
      value = (key: string) => nativeValue(settings, key),
      stream = nativeValue(raw, 'streamSettings'),
      network = jsonRecord(stream)
        ? jsonText(
            nativeValue(stream, 'method') ?? nativeValue(stream, 'network') ?? 'raw',
          ).toLowerCase()
        : 'raw';
    for (const key of ['clients', 'users', 'peers', 'fallbacks', 'servers', 'vnext', 'rules'])
      if (
        value(key) !== undefined &&
        (!jsonArray(value(key)) || (value(key) as unknown[]).some((v) => !jsonRecord(v)))
      )
        issues.push(add(`${key} must contain native objects.`));
    if (spec.protocol === 'tun') {
      const nameProblem = tunAdapterNameProblem(value('name'));
      if (nameProblem) issues.push(add(nameProblem));
      const routes = value('autoSystemRoutingTable');
      if (data.kind !== 'ics-tun' && (!jsonArray(routes) || !routes.length))
        issues.push(
          add(
            'No system routes are configured. This adapter will not capture general traffic.',
            'warning',
          ),
        );
      for (const key of ['gateway', 'autoSystemRoutingTable']) {
        const entries = value(key);
        if (
          entries !== undefined &&
          (!jsonArray(entries) ||
            entries.some((entry) => {
              if (typeof entry !== 'string') return true;
              const [address, bits, extra] = entry.split('/');
              return (
                !isIpLiteral(address) ||
                bits === undefined ||
                !/^\d+$/.test(bits) ||
                extra !== undefined ||
                Number(bits) > (address.includes(':') ? 128 : 32)
              );
            }))
        )
          issues.push(add(`${key} must contain valid IP/prefix lengths.`));
      }
      const dns = value('dns');
      if (
        dns !== undefined &&
        (!jsonArray(dns) || dns.some((entry) => typeof entry !== 'string' || !isIpLiteral(entry)))
      )
        issues.push(
          add('Adapter DNS must contain IP addresses. Configure resolver URLs in DNS servers.'),
        );
      if (value('autoSystemDnsToGateway'))
        issues.push(
          add(
            'Use gateway for system DNS is Linux-only. Set the Windows adapter DNS servers instead.',
          ),
        );
    }
    if (['hysteria', 'masque'].includes(spec.protocol) && network !== spec.protocol)
      issues.push(add(`${spec.title} uses the ${spec.protocol} transport.`));
    if (spec.protocol === 'hysteria' && value('version') !== 2)
      issues.push(add('The pinned core supports Hysteria version 2 only.'));
    const mux = nativeValue(raw, 'mux');
    if (spec.protocol === 'masque' && jsonRecord(mux) && nativeValue(mux, 'enabled') === true)
      issues.push(add('MASQUE does not support enabled mux.'));
    if (spec.protocol === 'trojan' && value('flow'))
      issues.push(add('Trojan flow was removed from the pinned Xray core.'));
    if (spec.protocol === 'loopback' && !value('inboundTag'))
      issues.push(add('Set the inbound tag used when reinjecting traffic.'));
    if (spec.protocol === 'wireguard' && !value('secretKey'))
      issues.push(add('A WireGuard secret key is required.'));
    if (
      spec.direction === 'outbound' &&
      !['wireguard', 'loopback', 'dns'].includes(spec.protocol) &&
      value('address') !== undefined
    ) {
      if (typeof value('address') !== 'string' || !String(value('address')).trim())
        issues.push(add('A destination address is required.'));
      if (
        typeof value('port') !== 'number' ||
        Number(value('port')) < 1 ||
        Number(value('port')) > 65535
      )
        issues.push(add('Destination port must be 1–65535.'));
      if (['trojan', 'shadowsocks'].includes(spec.protocol) && !value('password'))
        issues.push(add('A server password is required.'));
      if (spec.protocol === 'vmess' && !value('id'))
        issues.push(add('A VMess user ID is required.'));
    }
    const accounts = value('clients') ?? value('users');
    if (
      spec.direction === 'inbound' &&
      ['vless', 'vmess', 'trojan', 'hysteria', 'masque'].includes(spec.protocol) &&
      (!jsonArray(accounts) || !accounts.length)
    )
      issues.push(
        add('Configure at least one accepted account before using this listener.', 'warning'),
      );
    if (spec.direction === 'inbound' && jsonArray(accounts))
      for (const [index, account] of accounts.entries())
        if (jsonRecord(account))
          for (const key of spec.protocol === 'masque'
            ? ['email', 'pass']
            : spec.protocol === 'hysteria'
              ? ['auth']
              : spec.protocol === 'trojan'
                ? ['password']
                : ['vless', 'vmess'].includes(spec.protocol)
                  ? ['id']
                  : [])
            if (
              typeof nativeValue(account, key) !== 'string' ||
              !String(nativeValue(account, key)).trim()
            )
              issues.push(add(`Account ${index + 1}: ${key} is required.`));
    if (
      jsonRecord(stream) &&
      jsonRecord(stream.tlsSettings) &&
      stream.tlsSettings.allowInsecure === true
    )
      issues.push(add('allowInsecure was removed; use certificate pinning or verification names.'));
    return issues;
  } catch (e) {
    return [add(e instanceof Error ? e.message : 'Invalid protocol configuration.')];
  }
}

export function outboundDependencyProblems(
  config: Record<string, unknown>,
): { tag: string; message: string }[] {
  const outputs = jsonArray(config.outbounds) ? config.outbounds.filter(jsonRecord) : [];
  const byTag = new Map(
    outputs
      .filter((o) => typeof nativeValue(o, 'tag') === 'string' && nativeValue(o, 'tag'))
      .map((o) => [String(nativeValue(o, 'tag')), o]),
  );
  const dependencies = new Map<string, string[]>();
  const problems: { tag: string; message: string }[] = [];
  for (const [tag, output] of byTag) {
    const stream = nativeValue(output, 'streamSettings'),
      sock = jsonRecord(stream) ? nativeValue(stream, 'sockopt') : undefined,
      proxy = nativeValue(output, 'proxySettings');
    const targets = [
      jsonRecord(sock) ? nativeValue(sock, 'dialerProxy') : undefined,
      jsonRecord(proxy) ? nativeValue(proxy, 'tag') : undefined,
    ].filter((t): t is string => typeof t === 'string' && !!t);
    dependencies.set(tag, [...new Set(targets)]);
    for (const target of targets)
      if (!byTag.has(target))
        problems.push({
          tag,
          message: `Dial-through destination ${target} is not defined in this configuration.`,
        });
  }
  for (const tag of byTag.keys()) {
    const seen = new Set<string>(),
      todo = [...(dependencies.get(tag) ?? [])];
    while (todo.length) {
      const next = todo.pop()!;
      if (next === tag) {
        problems.push({ tag, message: 'Dial-through settings create an outbound loop.' });
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      todo.push(...(dependencies.get(next) ?? []));
    }
  }
  return problems;
}

export function loopbackProblems(
  config: Record<string, unknown>,
): { tag: string; message: string; severity: Diagnostic['severity'] }[] {
  const outputs = jsonArray(config.outbounds) ? config.outbounds.filter(jsonRecord) : [],
    loops = outputs.filter((o) => o.protocol === 'loopback'),
    rules =
      jsonRecord(config.routing) && jsonArray(config.routing.rules)
        ? config.routing.rules.filter(jsonRecord)
        : [];
  const choices = new Map<string, string[]>();
  for (const loop of loops) {
    const tag = jsonText(loop.tag ?? ''),
      input = jsonRecord(loop.settings) ? loop.settings.inboundTag : undefined,
      targets: string[] = [];
    let terminated = false;
    for (const rule of rules) {
      if (jsonArray(rule.inboundTag) && !rule.inboundTag.includes(input)) continue;
      if (typeof rule.outboundTag === 'string') targets.push(rule.outboundTag);
      const conditional = Object.entries(rule).some(
        ([key, value]) =>
          !['type', 'inboundTag', 'outboundTag', 'balancerTag', 'ruleTag'].includes(key) &&
          value !== undefined,
      );
      if (!conditional) {
        terminated = true;
        break;
      }
    }
    if (!terminated) targets.push(jsonText(outputs[0]?.tag ?? ''));
    choices.set(tag, [...new Set(targets)]);
  }
  const problems: { tag: string; message: string; severity: Diagnostic['severity'] }[] = [];
  for (const loop of loops) {
    const tag = jsonText(loop.tag ?? ''),
      search = (current: string, seen: Set<string>, definite: boolean): boolean | undefined => {
        if (seen.has(current)) return current === tag ? definite : undefined;
        const next = choices.get(current);
        if (!next) return undefined;
        let possible: boolean | undefined;
        for (const target of next) {
          const result = search(target, new Set([...seen, current]), definite && next.length === 1);
          if (result === true) return true;
          if (result === false) possible = false;
        }
        return possible;
      };
    const cycle = search(tag, new Set(), true);
    if (cycle !== undefined)
      problems.push({
        tag,
        severity: cycle ? 'error' : 'warning',
        message: cycle
          ? 'Reinjected traffic returns to this loopback without a terminating route.'
          : 'A routing branch may send reinjected traffic back to this loopback. Check rule conditions and fallback.',
      });
  }
  return problems;
}
