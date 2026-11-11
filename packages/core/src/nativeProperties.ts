import { cloneJson, jsonArray, jsonRecord, jsonText } from './xrayJson';

/** Named sniffing controls own only their protocols; preserve FakeDNS and other native modes. */
export function setSniffingProtocols(
  sniffing: Record<string, unknown>,
  enabled: { http: boolean; tls: boolean; quic: boolean },
): Record<string, unknown> {
  const overrides = nativeValue(sniffing, 'destOverride');
  return setNative(sniffing, 'destOverride', [
    ...(jsonArray(overrides)
      ? overrides.filter((name) => !Object.hasOwn(enabled, String(name)))
      : []),
    ...Object.entries(enabled)
      .filter(([, on]) => on)
      .map(([name]) => name),
  ]);
}

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
export function commonPath(
  key: string,
  raw: Record<string, unknown>,
  direction: 'inbound' | 'outbound',
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
export function getNativePath(o: unknown, path: string[]): unknown {
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
export function putNativePath(
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
