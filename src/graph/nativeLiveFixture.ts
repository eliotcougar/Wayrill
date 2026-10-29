// Fictional loopback-only fixtures shared by core validation and VM QA.
export function nativeLiveFixture(mode: 'noauth' | 'password' | 'block'): Record<string, unknown> {
  const authenticated = mode !== 'noauth';
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'qa-mixed',
        protocol: 'mixed',
        listen: '127.0.0.1',
        port: 20921,
        settings: {
          auth: authenticated ? 'password' : 'noauth',
          udp: true,
          ...(authenticated ? { accounts: [{ user: 'qa-input', pass: 'qa-only' }] } : {}),
        },
        sniffing: { enabled: false },
      },
    ],
    outbounds: [
      {
        tag: 'upstream',
        protocol: 'socks',
        settings: {
          address: '127.0.0.1',
          port: 20922,
          ...(authenticated ? { user: 'qa-server', pass: 'qa-only' } : {}),
        },
      },
      { tag: 'dns-handler', protocol: 'dns', settings: {} },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        ...(mode === 'block'
          ? [{ type: 'field', inboundTag: ['qa-mixed'], port: '18880', outboundTag: 'block' }]
          : []),
        {
          type: 'field',
          inboundTag: ['qa-mixed'],
          network: 'udp',
          port: '53',
          outboundTag: 'dns-handler',
        },
        { type: 'field', inboundTag: ['dns-query'], outboundTag: 'upstream' },
        { type: 'field', inboundTag: ['qa-mixed'], outboundTag: 'upstream' },
      ],
    },
    dns: {
      tag: 'dns-query',
      queryStrategy: 'UseIPv4',
      disableCache: true,
      disableFallbackIfMatch: true,
      servers: [
        {
          address: '127.0.0.1',
          port: 18895,
          domains: ['full:preferred.example.test'],
          expectedIPs: ['192.0.2.11'],
          skipFallback: true,
          timeoutMs: 1000,
          disableCache: true,
        },
        {
          address: '127.0.0.1',
          port: 18896,
          skipFallback: false,
          timeoutMs: 1000,
          disableCache: true,
        },
      ],
    },
    policy: {
      levels: {
        '0': { handshake: 4, connIdle: 300, uplinkOnly: 2, downlinkOnly: 5, bufferSize: -1 },
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    stats: {},
    metrics: { tag: 'metrics', listen: '127.0.0.1:20923' },
  };
}
