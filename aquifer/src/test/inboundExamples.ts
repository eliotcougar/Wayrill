import type { ServerObject } from '../inboundFields';
export const certs = {
  certificates: [{ certificateFile: '/etc/ssl/fullchain.pem', keyFile: '/etc/ssl/privkey.pem' }],
};
const id = '00000000-0000-4000-8000-000000000001';
export const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export const examples: [string, ServerObject, ServerObject?][] = [
  [
    'vless',
    {
      clients: [{ id, reverse: { tag: 'reverse-client' } }],
      decryption: 'none',
      flow: 'xtls-rprx-vision',
    },
    {
      network: 'raw',
      security: 'reality',
      realitySettings: {
        target: 'example.org:443',
        serverNames: ['example.org'],
        privateKey: key.slice(0, -1),
        shortIds: ['', '0123'],
        show: false,
        fingerprint: 'chrome',
      },
    },
  ],
  ['vmess', { clients: [{ id }], default: { level: 1 } }],
  [
    'trojan',
    { clients: [{ password: 'test' }], fallbacks: [{ dest: 8080, xver: 1 }] },
    { security: 'tls', tlsSettings: certs },
  ],
  ['shadowsocks', { method: 'chacha20-poly1305', password: 'test', network: 'tcp,udp' }],
  [
    'shadowsocks',
    {
      method: '2022-blake3-aes-256-gcm',
      password: key,
      clients: [{ password: key, email: 'ss-user' }],
    },
  ],
  [
    'socks',
    { auth: 'password', accounts: [{ user: 'test', pass: 'test' }], udp: true, ip: '192.0.2.2' },
  ],
  ['http', { accounts: [{ user: 'test', pass: 'test' }], allowTransparent: true }],
  ['mixed', { auth: 'password', accounts: [{ user: 'test', pass: 'test' }], udp: true }],
  ['tunnel', { rewriteAddress: '127.0.0.1', rewritePort: 8080, allowedNetwork: 'tcp' }],
  ['dokodemo-door', { address: '127.0.0.1', port: 8080, network: 'tcp,udp', followRedirect: true }],
  [
    'wireguard',
    {
      secretKey: key,
      address: ['10.40.0.1/24'],
      peers: [{ publicKey: key, allowedIPs: ['10.40.0.2/32'] }],
      reserved: [1, 2, 3],
    },
  ],
  [
    'hysteria',
    { version: 2, clients: [{ auth: 'test' }] },
    { network: 'hysteria', security: 'tls', tlsSettings: certs, hysteriaSettings: { version: 2 } },
  ],
  [
    'masque',
    { address: ['10.40.0.1/24', 'fd40::1/64'], clients: [{ email: 'alice', pass: 'test' }] },
    { network: 'masque', security: 'tls', tlsSettings: certs },
  ],
  [
    'tun',
    {
      name: 'xray-tun',
      gateway: ['10.40.0.1/30'],
      autoSystemRoutingTable: ['0.0.0.0/0'],
      autoOutboundsInterface: 'eth0',
      desc: 'Windows-only preserved value',
    },
  ],
];
export const inbound = (
  protocol: string,
  settings: ServerObject,
  streamSettings?: ServerObject,
): ServerObject => ({
  tag: 'server',
  protocol,
  ...(protocol === 'tun' ? {} : { listen: '0.0.0.0', port: 443 }),
  settings,
  ...(streamSettings ? { streamSettings } : {}),
});
