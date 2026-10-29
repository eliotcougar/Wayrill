import type { NodeDefinition, SettingDefinition, SettingSection } from './types';

export const advancedSettings: Record<string, readonly string[]> = {
  DokodemoConfig: ['portMap', 'userLevel'],
  HTTPServerConfig: ['allowTransparent', 'userLevel'],
  HTTPClientConfig: ['level', 'email'],
  HTTPRemoteConfig: [],
  HTTPAccount: [],
  ShadowsocksServerConfig: ['level', 'email'],
  ShadowsocksClientConfig: ['level', 'email'],
  ShadowsocksUserConfig: ['level', 'email'],
  ShadowsocksServerTarget: ['level', 'email'],
  SocksServerConfig: ['userLevel'],
  SocksClientConfig: ['level', 'email'],
  SocksRemoteConfig: [],
  SocksAccount: [],
  VLessInboundConfig: ['fallbacks', 'testseed'],
  VLessOutboundConfig: ['level', 'email', 'seed', 'reverse', 'testpre', 'testseed'],
  VLessOutboundVnext: [],
  VLessInboundFallback: ['name', 'alpn', 'path', 'type', 'xver'],
  VLessUserConfig: ['testseed', 'reverse', 'level', 'email'],
  VMessInboundConfig: ['default'],
  VMessOutboundConfig: ['level', 'email', 'experiments'],
  VMessOutboundTarget: [],
  VMessUserConfig: ['experiments', 'level', 'email'],
  VMessDefaultConfig: ['level'],
  TrojanServerConfig: ['fallbacks'],
  TrojanClientConfig: ['level', 'email', 'flow'],
  TrojanServerTarget: ['level', 'email', 'flow'],
  TrojanUserConfig: ['level', 'email', 'flow'],
  TrojanInboundFallback: ['name', 'alpn', 'path', 'type', 'xver'],
  WireGuardConfig: ['noKernelTun', 'mtu', 'reserved'],
  WireGuardPeerConfig: ['keepAlive', 'level', 'email'],
  HysteriaClientConfig: ['version'],
  HysteriaServerConfig: ['version'],
  HysteriaUserConfig: ['level', 'email'],
  MasqueClientConfig: [],
  MasqueServerConfig: ['mtu'],
  MasqueUserConfig: ['level'],
  TunConfig: ['desc', 'mtu', 'userLevel'],
  LoopbackConfig: ['sniffing'],
  DNSOutboundConfig: [
    'rewriteNetwork',
    'rewriteAddress',
    'rewritePort',
    'network',
    'address',
    'port',
    'userLevel',
  ],
  DNSOutboundRuleConfig: [],
  StreamConfig: ['address', 'port', 'finalmask', 'sockopt'],
  SniffingConfig: ['domainsExcluded', 'ipsExcluded', 'metadataOnly'],
  MuxConfig: ['enabled', 'concurrency', 'xudpConcurrency', 'xudpProxyUDP443'],
  TCPConfig: ['header', 'acceptProxyProtocol'],
  SplitHTTPConfig: [
    'headers',
    'xPaddingBytes',
    'xPaddingObfsMode',
    'xPaddingKey',
    'xPaddingHeader',
    'xPaddingPlacement',
    'xPaddingMethod',
    'uplinkHTTPMethod',
    'sessionIDPlacement',
    'sessionIDKey',
    'sessionIDTable',
    'sessionIDLength',
    'seqPlacement',
    'seqKey',
    'uplinkDataPlacement',
    'uplinkDataKey',
    'uplinkChunkSize',
    'noGRPCHeader',
    'noSSEHeader',
    'scMaxEachPostBytes',
    'scMinPostsIntervalMs',
    'scMaxBufferedPosts',
    'scStreamUpServerSecs',
    'serverMaxHeaderBytes',
    'xmux',
    'downloadSettings',
    'extra',
  ],
  KCPConfig: [
    'mtu',
    'tti',
    'uplinkCapacity',
    'downlinkCapacity',
    'cwndMultiplier',
    'maxSendingWindow',
  ],
  GRPCConfig: [
    'idle_timeout',
    'health_check_timeout',
    'permit_without_stream',
    'initial_windows_size',
    'user_agent',
  ],
  WebSocketConfig: ['acceptProxyProtocol', 'heartbeatPeriod'],
  HttpUpgradeConfig: ['acceptProxyProtocol'],
  HysteriaConfig: ['version', 'udpIdleTimeout', 'masquerade'],
  MasqueConfig: ['xmux'],
  MasqueWarpConfig: [],
  XDriveConfig: [
    'xmux',
    'segmentBytes',
    'flushIntervalMs',
    'pollIntervalMs',
    'maxPollIntervalMs',
    'sessionTtlSeconds',
    'concurrency',
    'eagerWindowMs',
    'holeTimeoutMs',
  ],
  TLSConfig: [
    'allowInsecure',
    'enableSessionResumption',
    'disableSystemRoot',
    'useSystemCA',
    'minVersion',
    'maxVersion',
    'cipherSuites',
    'rejectUnknownSni',
    'curvePreferences',
    'masterKeyLog',
    'echSockopt',
  ],
  TLSCertConfig: ['usage', 'ocspStapling', 'oneTimeLoading', 'buildChain'],
  REALITYConfig: [
    'masterKeyLog',
    'show',
    'dest',
    'type',
    'xver',
    'minClientVer',
    'maxClientVer',
    'maxTimeDiff',
    'limitFallbackUpload',
    'limitFallbackDownload',
    'spiderX',
  ],
  SocketConfig: [
    'mark',
    'tcpFastOpen',
    'tproxy',
    'acceptProxyProtocol',
    'domainStrategy',
    'tcpKeepAliveInterval',
    'tcpKeepAliveIdle',
    'tcpCongestion',
    'tcpWindowClamp',
    'tcpMaxSeg',
    'penetrate',
    'tcpUserTimeout',
    'v6only',
    'interface',
    'tcpMptcp',
    'customSockopt',
    'addressPortStrategy',
    'happyEyeballs',
    'trustedXForwardedFor',
  ],
  HappyEyeballsConfig: ['prioritizeIPv6', 'tryDelayMs', 'interleave', 'maxConcurrentTry'],
  CustomSockoptConfig: ['system', 'network', 'level', 'opt', 'value', 'type'],
  Masquerade: ['rewriteHost', 'xForwarded', 'insecure', 'headers', 'statusCode'],
  FreedomConfig: [
    'domainStrategy',
    'redirect',
    'userLevel',
    'fragment',
    'noise',
    'noises',
    'proxyProtocol',
    'ipsBlocked',
    'finalRules',
  ],
  BlackholeConfig: ['response'],
  FinalMask: ['tcp', 'udp', 'quicParams'],
  Mask: [],
  QuicParamsConfig: [
    'congestion',
    'debug',
    'bbrProfile',
    'brutalUp',
    'brutalDown',
    'brutalDisableLossCompensation',
    'initStreamReceiveWindow',
    'maxStreamReceiveWindow',
    'initConnectionReceiveWindow',
    'maxConnectionReceiveWindow',
    'maxIdleTimeout',
    'keepAlivePeriod',
    'disablePathMTUDiscovery',
    'disableChromeParrot',
    'disableGSO',
    'maxIncomingStreams',
    'disableStatelessReset',
  ],
  VLessOutboundUserConfig: ['testpre', 'testseed', 'reverse', 'level', 'email'],
  HTTPUserConfig: ['level', 'email'],
  SocksUserConfig: ['level', 'email'],
  DNSConfig: ['clientIp', 'disableCache', 'serveStale', 'serveExpiredTTL', 'enableParallelQuery'],
  NameServerConfig: ['clientIp', 'timeoutMs', 'disableCache', 'serveStale', 'serveExpiredTTL'],
  LogConfig: ['dnsLog', 'maskAddress'],
  RouterConfig: ['domainMatcher'],
};

export const basicGlobalSettings = new Set([
  'sniffing',
  'routeOnly',
  'sniffHttp',
  'sniffTls',
  'sniffQuic',
  'udp',
  'fingerprint',
  'userAgent',
  'muxEnabled',
  'fragmentEnabled',
  'finalFragmentEnabled',
  'interface',
  'proxyDomainStrategy',
  'directDomainStrategy',
  'targetStrategy',
  'happyEyeballsEnabled',
  'xhttpMode',
  'kcpUp',
  'kcpDown',
  'hysteriaUp',
  'hysteriaDown',
  'routingDomainStrategy',
  'logLevel',
  'statistics',
]);

export function isBasicSetting(coreKey?: string, direction?: 'inbound' | 'outbound') {
  if (!coreKey) return true;
  const dot = coreKey.indexOf('.'),
    structure = coreKey.slice(0, dot),
    key = coreKey.slice(dot + 1);
  if (structure === 'TLSConfig' && key === 'certificates' && direction === 'outbound') return false;
  // Unknown fields remain accessible until the upgraded schema has been reviewed.
  return !advancedSettings[structure]?.includes(key);
}

export function securityFieldsForRole<T extends { key: string }>(
  fields: T[],
  security: string,
  direction: 'inbound' | 'outbound',
  object: Record<string, unknown> = {},
) {
  const client = new Set([
    'fingerprint',
    'serverName',
    'password',
    'publicKey',
    'shortId',
    'mldsa65Verify',
    'spiderX',
  ]);
  const server = new Set([
    'target',
    'dest',
    'serverNames',
    'privateKey',
    'shortIds',
    'mldsa65Seed',
    'minClientVer',
    'maxClientVer',
    'maxTimeDiff',
    'limitFallbackUpload',
    'limitFallbackDownload',
  ]);
  const keys = Object.keys(object).map((k) => k.toLowerCase());
  const publicKeyAlias = keys.includes('publickey') && !keys.includes('password');
  return fields
    .filter(
      (f) =>
        f.key !== 'allowInsecure' &&
        (security !== 'reality' ||
          (!(direction === 'inbound' ? client : server).has(f.key) &&
            (f.key !== 'password' || !publicKeyAlias) &&
            (f.key !== 'publicKey' || publicKeyAlias))),
    )
    .map((f) =>
      security === 'reality' && ['password', 'publicKey'].includes(f.key)
        ? { ...f, label: 'Public key / password' }
        : f,
    );
}

/** Presence includes explicit false, zero, blank, and empty collections. Never expose values/secrets. */
export function configuredFieldLabels(
  object: Record<string, unknown>,
  fields: readonly { key: string; label: string; aliases?: string[] }[],
) {
  const keys = Object.keys(object).map((k) => k.toLowerCase());
  return fields
    .filter((f) => [f.key, ...(f.aliases ?? [])].some((k) => keys.includes(k.toLowerCase())))
    .map((f) => f.label);
}

/** Keep the compact named forms aligned with the source-defined protocol editor. */
export function nodeSettingGroups(definition: NodeDefinition, fields: SettingDefinition[]) {
  if (!definition.sections) return [];
  const groups: (SettingSection & { fields: SettingDefinition[] })[] = [];
  const transportIdentity = new Set([
    'network',
    'rawHeaderType',
    'rawHost',
    'rawPath',
    'host',
    'path',
    'headers',
    'xhttpMode',
    'grpcServiceName',
    'grpcAuthority',
    'grpcMultiMode',
    'hysteriaAuth',
    'xdriveSettings',
  ]);
  const securityIdentity = new Set([
    'pinnedPeerCertSha256',
    'verifyPeerCertByName',
    'echConfigList',
    'mldsa65Verify',
  ]);
  for (const section of definition.sections) {
    let selected = fields.filter((f) => f.section === section.id);
    if (section.id === 'security')
      selected = [
        ...selected.filter((f) => f.key !== 'spiderX'),
        ...fields.filter((f) => securityIdentity.has(f.key)),
      ];
    if (['tls', 'reality'].includes(section.id))
      selected = selected.filter((f) => !securityIdentity.has(f.key));
    if (section.id === 'reality')
      selected = [...selected, ...fields.filter((f) => f.key === 'spiderX')];
    if (!selected.length) continue;
    const tuning =
      section.id === 'transport'
        ? selected.filter((f) => !transportIdentity.has(f.key) && !f.required)
        : definition.kind === 'direct-outbound' && section.id === 'socket'
          ? selected.filter((f) => f.key !== 'domainStrategy')
          : definition.kind === 'windivert-inbound'
            ? selected.filter((f) => ['port', 'capturePriority'].includes(f.key))
            : [];
    const basic = selected.filter((f) => !tuning.includes(f));
    if (basic.length) groups.push({ ...section, fields: basic });
    if (tuning.length)
      groups.push({
        id: `${section.id}-tuning`,
        title: section.id === 'transport' ? 'Transport tuning' : 'Local connection',
        advanced: true,
        fields: tuning,
      });
  }
  return groups;
}
