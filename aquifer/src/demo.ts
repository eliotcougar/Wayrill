export const demoConfig = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      tag: 'public-vless',
      listen: '0.0.0.0',
      port: 443,
      protocol: 'vless',
      settings: { clients: [{ id: '00000000-0000-4000-8000-000000000001' }], decryption: 'none' },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          certificates: [
            { certificateFile: '/etc/ssl/server.pem', keyFile: '/etc/ssl/server.key' },
          ],
        },
      },
    },
    {
      tag: 'local-admin',
      listen: '127.0.0.1',
      port: 10085,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    },
  ],
  outbounds: [
    { tag: 'direct', protocol: 'freedom', settings: {} },
    { tag: 'blocked', protocol: 'blackhole', settings: {} },
    { tag: 'relay-eu', protocol: 'socks', settings: { address: 'relay.example.net', port: 1080 } },
  ],
  api: { tag: 'api', services: ['StatsService'] },
  dns: { servers: ['localhost', 'https://dns.google/dns-query'] },
  observatory: {
    subjectSelector: ['relay-'],
    probeURL: 'https://www.google.com/generate_204',
    probeInterval: '30s',
  },
  routing: {
    domainStrategy: 'IPIfNonMatch',
    balancers: [
      {
        tag: 'regional',
        selector: ['relay-'],
        fallbackTag: 'direct',
        strategy: { type: 'leastPing' },
      },
    ],
    rules: [
      { type: 'field', inboundTag: ['local-admin'], outboundTag: 'api' },
      { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
      { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'blocked' },
      { type: 'field', domain: ['domain:example.org'], balancerTag: 'regional' },
    ],
  },
};

/** Fictional local example for shared users, policy candidates and nested proxies. */
const familyUsers = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'alice@example.org' },
  { id: '00000000-0000-4000-8000-000000000002', email: 'bob@example.org' },
];
export const sharedUsersExample = {
  ...demoConfig,
  inbounds: [
    { ...demoConfig.inbounds[0], settings: { clients: familyUsers, decryption: 'none' } },
    demoConfig.inbounds[1],
    {
      ...demoConfig.inbounds[0],
      tag: 'alternate-vless',
      port: 8443,
      settings: { clients: familyUsers, decryption: 'none' },
    },
  ],
  outbounds: [
    demoConfig.outbounds[0],
    demoConfig.outbounds[1],
    { ...demoConfig.outbounds[2], streamSettings: { sockopt: { dialerProxy: 'entry-proxy' } } },
    {
      tag: 'entry-proxy',
      protocol: 'socks',
      settings: { address: 'entry.example.org', port: 1080 },
    },
  ],
};
