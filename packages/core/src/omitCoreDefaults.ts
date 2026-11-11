import { jsonRecord as object, valueAt, jsonArray, parseJson } from './xrayJson';
import type { SettingValue } from './settings';

// These keys are derived by resolveNodeData, never saved in graph documents.
// Omit native settings instead of baking resolved core values into JSON. This
// preserves contextual defaults, and naturally follows the embedded core.
export function omitCoreDefaults(
  data: { kind: string; settings: Record<string, SettingValue>; coreDefaults?: string[] },
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
