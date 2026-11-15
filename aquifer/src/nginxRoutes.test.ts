import { expect, it } from 'vitest';
import { nginxRoutes, type NginxDirective, type NginxObservation } from './nginxRoutes';
import { nginxNodeId, withNginx } from './NginxNode';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { observedPoolAccounts } from './users/observedPoolAccounts';
import { generateServerKeys } from './serverKeys';

const directive = (name: string, args: string[], children?: NginxDirective[]): NginxDirective => ({
  name,
  args,
  children,
});
const block = (name: string, ...children: NginxDirective[]) => directive(name, [], children);
const fixture = (location: NginxDirective, backend = 'app.example.test'): NginxObservation => ({
  state: 'ready',
  config: [
    block(
      'stream',
      directive(
        'map',
        ['$ssl_preread_server_name', '$backend'],
        [
          directive(backend, ['https_local']),
          directive('cover.example.test', ['127.0.0.1:8444']),
          directive('default', ['https_local']),
        ],
      ),
      directive('upstream', ['https_local'], [directive('server', ['127.0.0.1:8443'])]),
      block(
        'server',
        directive('listen', ['443']),
        directive('listen', ['[::]:443']),
        directive('ssl_preread', ['on']),
        directive('proxy_pass', ['$backend']),
      ),
    ),
    block(
      'http',
      block(
        'server',
        directive('listen', ['127.0.0.1:8443', 'ssl']),
        directive('listen', ['443', 'quic']),
        directive('server_name', ['app.example.test']),
        directive('http2', ['on']),
        location,
      ),
    ),
  ],
});
const listener = (tag: string, port: number, streamSettings: Record<string, unknown>) => ({
  tag,
  listen: '127.0.0.1',
  port,
  protocol: 'vless',
  settings: {
    decryption: 'none',
    clients: [{ email: 'Alice', id: '8b950709-245d-40f2-a65f-3e937907838a' }],
  },
  streamSettings,
});
const xhttp = listener('web', 444, {
  network: 'xhttp',
  security: 'tls',
  xhttpSettings: { path: '/inside/' },
});
const session = { id: 'fixture', name: 'Server', host: '192.0.2.1', port: 22, user: 'admin' };

it('projects a public XHTTP route through TLS termination and a separate REALITY passthrough', async () => {
  const { privateKey, publicKey } = await generateServerKeys(false);
  const reality = listener('camouflage', 8444, {
    network: 'tcp',
    security: 'reality',
    realitySettings: { privateKey, serverNames: ['cover.example.test'], shortIds: ['abcd'] },
  });
  const nginx = fixture(
    directive(
      'location',
      ['^~', '/edge/'],
      [directive('proxy_pass', ['https://127.0.0.1:444/inside/'])],
    ),
  );
  const config = {
    inbounds: [xhttp, reality],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
  const text = JSON.stringify(config);
  const resolved = nginxRoutes(nginx, config, session.host);
  expect(resolved.map(({ inbound, network }) => [inbound, network])).toEqual([
    [1, 'tcp'],
    [0, 'tcp'],
    [0, 'udp'],
  ]);
  const view = remoteView(text);
  const graph = withNginx(view, nginx, session.host);
  expect(
    graph.edges.filter(({ source }) => source === nginxNodeId).map(({ target }) => target),
  ).toEqual(['native-in-1', 'native-in-0', 'native-in-0']);
  const users = createUserWorkspace(view.original, emptyLibrary());
  expect(compileRemote(graph, users).config).toEqual(compileRemote(view, users).config);

  const snapshot = { path: '/etc/xray/config.json', text, sha256: '', bytes: text.length, nginx };
  const observed = await observedPoolAccounts(session, snapshot);
  expect(observed.skipped).toEqual([]);
  expect(observed.accounts.map(({ outbound }) => outbound)).toMatchObject([
    {
      settings: { address: 'app.example.test', port: 443 },
      streamSettings: {
        security: 'tls',
        tlsSettings: { serverName: 'app.example.test', alpn: ['h2'] },
        xhttpSettings: { host: 'app.example.test', path: '/edge/' },
      },
    },
    {
      settings: { address: '192.0.2.1', port: 443 },
      streamSettings: {
        security: 'reality',
        realitySettings: { serverName: 'cover.example.test', password: publicKey },
      },
    },
  ]);
  await expect(
    observedPoolAccounts(session, { ...snapshot, nginx: { state: 'unavailable' } }),
  ).rejects.toThrow('Nginx could not be inspected');
});

const snapshotOf = (inbounds: Record<string, unknown>[], nginx: NginxObservation) => {
  const text = JSON.stringify({ inbounds });
  return { path: '/xray.json', sha256: '', bytes: text.length, text, nginx };
};
const site = (config: NginxDirective[], ...listens: string[][]): NginxObservation => ({
  state: 'ready',
  config: [
    block(
      'http',
      block(
        'server',
        directive('server_name', ['edge.example.test']),
        ...listens.map((args) => directive('listen', args)),
        ...config,
      ),
    ),
  ],
});
const location = (path: string, ...directives: NginxDirective[]) =>
  directive('location', [path], directives);

it('generates XHTTP over HTTP/3 when Nginx forwards it via grpc_pass to a Unix socket', async () => {
  const nginx = site(
    [location('/edge/', directive('grpc_pass', ['unix:/run/xray.sock']))],
    ['443', 'quic'],
  );
  const observed = await observedPoolAccounts(
    session,
    snapshotOf(
      [
        {
          ...listener('xhttp3', 444, {
            method: 'splithttp',
            splithttpSettings: { path: '/edge/', mode: 'stream-one' },
          }),
          listen: '/run/xray.sock,0666',
          port: undefined,
        },
      ],
      nginx,
    ),
  );
  expect(observed.skipped).toEqual([]);
  expect(observed.accounts[0]?.outbound).toMatchObject({
    settings: { address: 'edge.example.test', port: 443 },
    streamSettings: {
      network: 'xhttp',
      security: 'tls',
      tlsSettings: { alpn: ['h3'] },
      xhttpSettings: { path: '/edge/', host: 'edge.example.test', mode: 'stream-one' },
    },
  });
});

it('sends WebSocket and HTTPUpgrade through upgrade guards, maps and upstream path replacement', async () => {
  const origin = directive('proxy_http_version', ['1.1']);
  const upgrade = directive('proxy_set_header', ['Upgrade', '$http_upgrade']);
  const connection = directive('proxy_set_header', ['Connection', '$upgrade_connection']);
  const nginx: NginxObservation = {
    state: 'ready',
    config: [
      block(
        'http',
        directive(
          'map',
          ['$http_upgrade', '$upgrade_connection'],
          [directive('default', ['upgrade']), directive('', ['close'])],
        ),
        origin,
        upgrade,
        connection,
        block(
          'server',
          directive('server_name', ['edge.example.test']),
          directive('listen', ['443', 'ssl', 'http2']),
          location(
            '/ws',
            directive('upgrade_required', []),
            directive('proxy_pass', ['http://127.0.0.1:1234']),
          ),
          location('/upgrade/', directive('proxy_pass', ['http://127.0.0.1:1235/tunnel/'])),
        ),
      ),
    ],
  };
  const ws = {
    ...listener('ws', 1234, { method: 'websocket', wsSettings: { path: '/ws?ed=2560' } }),
    protocol: 'vmess',
  };
  const httpupgrade = {
    ...listener('upgrade', 1235, {
      network: 'httpupgrade',
      httpupgradeSettings: { path: '/tunnel/connect' },
    }),
    protocol: 'trojan',
    settings: { clients: [{ email: 'Alice', password: 'test-password' }] },
  };
  const observed = await observedPoolAccounts(session, snapshotOf([ws, httpupgrade], nginx));
  expect(observed.accounts.map(({ outbound }) => outbound)).toMatchObject([
    {
      protocol: 'vmess',
      streamSettings: {
        network: 'ws',
        tlsSettings: { alpn: ['http/1.1'] },
        wsSettings: { path: '/ws?ed=2560' },
      },
    },
    {
      protocol: 'trojan',
      streamSettings: {
        network: 'httpupgrade',
        tlsSettings: { alpn: ['http/1.1'] },
        httpupgradeSettings: { path: '/upgrade/connect' },
      },
    },
  ]);
});

it('follows Xray TLS and Trojan fallbacks through a PROXY-protocol socket into custom gRPC', async () => {
  const nginx = site(
    [
      directive(
        'location',
        ['=', '/rpc/v2/batch'],
        [directive('grpc_pass', ['grpc://127.0.0.1:2001'])],
      ),
    ],
    ['unix:/run/h2c.sock', 'http2', 'proxy_protocol'],
  );
  const gateway = {
    ...listener('TLS entry', 443, { security: 'tls', tlsSettings: { alpn: ['h2'] } }),
    listen: '0.0.0.0',
    settings: { decryption: 'none', fallbacks: [{ alpn: 'h2', dest: '@hop', xver: 2 }] },
  };
  const hop = {
    ...listener('Trojan fallback', 0, { sockopt: { acceptProxyProtocol: true } }),
    protocol: 'trojan',
    listen: '@hop',
    settings: { fallbacks: [{ dest: '/run/h2c.sock', xver: 2 }] },
  };
  const grpc = listener('gRPC', 2001, {
    method: 'grpc',
    grpcSettings: { serviceName: '/rpc/v2/one|batch' },
  });
  const config = { inbounds: [gateway, hop, grpc] };
  const routes = nginxRoutes(nginx, config, session.host);
  expect(routes).toMatchObject([
    {
      inbound: 2,
      port: 443,
      security: 'tls',
      via: 'TLS entry → Trojan fallback → unix:/run/h2c.sock',
    },
  ]);
  const observed = await observedPoolAccounts(session, snapshotOf(config.inbounds, nginx));
  expect(observed.accounts[0]?.outbound).toMatchObject({
    streamSettings: {
      network: 'grpc',
      tlsSettings: { alpn: ['h2'] },
      grpcSettings: {
        serviceName: '/rpc/v2/batch',
        multiMode: true,
        authority: 'edge.example.test',
      },
    },
  });
  const broken = { ...hop, settings: { fallbacks: [{ dest: '/run/h2c.sock' }] } };
  expect(nginxRoutes(nginx, { inbounds: [gateway, broken, grpc] }, session.host)).toEqual([]);
});

it('resolves TCP and UDP separately at the same backend port, including mKCP and QUIC transports', async () => {
  const relay = (port: number, backend: number) =>
    block(
      'server',
      directive('listen', [String(port), 'udp', 'reuseport']),
      directive('proxy_pass', ['127.0.0.1:' + backend]),
    );
  const nginx: NginxObservation = {
    state: 'ready',
    config: [
      block(
        'stream',
        relay(1443, 3001),
        relay(1444, 3002),
        relay(1445, 3003),
        relay(1446, 3004),
        block('server', directive('listen', ['1443']), directive('proxy_pass', ['127.0.0.1:3001'])),
      ),
    ],
  };
  const inbounds = [
    listener('raw', 3001, {}),
    {
      ...listener('mkcp', 3001, { method: 'mkcp', kcpSettings: { mtu: 1280, tti: 25 } }),
      protocol: 'vmess',
    },
    {
      ...listener('hysteria', 3002, {
        method: 'hysteria',
        security: 'tls',
        tlsSettings: { serverName: 'hy.example.test' },
      }),
      protocol: 'hysteria',
      settings: { version: 2, clients: [{ email: 'Alice', auth: 'token' }] },
    },
    {
      ...listener('masque', 3003, { method: 'masque', security: 'tls' }),
      protocol: 'masque',
      settings: { clients: [{ email: 'Alice', pass: 'password' }] },
    },
    { ...listener('wireguard', 3004, {}), protocol: 'wireguard' },
  ];
  expect(
    nginxRoutes(nginx, { inbounds }, session.host).map(({ inbound, port, network }) => [
      inbound,
      port,
      network,
    ]),
  ).toEqual([
    [1, 1443, 'udp'],
    [2, 1444, 'udp'],
    [3, 1445, 'udp'],
    [4, 1446, 'udp'],
    [0, 1443, 'tcp'],
  ]);
  const observed = await observedPoolAccounts(session, snapshotOf(inbounds, nginx));
  expect(observed.skipped).toEqual([]);
  expect(observed.accounts.map(({ outbound }) => outbound)).toMatchObject([
    { protocol: 'vless', settings: { port: 1443 } },
    {
      protocol: 'vmess',
      settings: { port: 1443 },
      streamSettings: { network: 'kcp', kcpSettings: { mtu: 1280, tti: 25 } },
    },
    {
      protocol: 'hysteria',
      settings: { port: 1444 },
      streamSettings: {
        tlsSettings: { serverName: 'hy.example.test' },
        hysteriaSettings: { auth: 'token' },
      },
    },
    {
      protocol: 'masque',
      settings: { port: 1445 },
      streamSettings: {
        masqueSettings: { user: 'Alice', pass: 'password' },
        tlsSettings: { alpn: ['h3'] },
      },
    },
  ]);
});

it.each([
  { alpn: ['h2'], udp: false },
  { alpn: 'h3,h2', udp: true },
])('matches MASQUE listeners and selects the client ALPN for $alpn', async ({ alpn, udp }) => {
  const nginx: NginxObservation = {
    state: 'ready',
    config: [
      block(
        'stream',
        block('server', directive('listen', ['443']), directive('proxy_pass', ['127.0.0.1:3003'])),
        block(
          'server',
          directive('listen', ['1443', 'udp']),
          directive('proxy_pass', ['127.0.0.1:3003']),
        ),
      ),
    ],
  };
  const inbound = {
    ...listener('masque', 3003, {
      method: 'masque',
      security: 'tls',
      tlsSettings: { alpn },
    }),
    protocol: 'masque',
    settings: { clients: [{ email: 'Alice', pass: 'password' }] },
  };
  expect(nginxRoutes(nginx, { inbounds: [inbound] }, session.host)).toMatchObject([
    { port: 443, network: 'tcp', alpn: ['h2'] },
    ...(udp ? [{ port: 1443, network: 'udp', alpn: ['h3'] }] : []),
  ]);
  const observed = await observedPoolAccounts(session, snapshotOf([inbound], nginx));
  expect(observed.accounts[0]?.outbound).toMatchObject({
    protocol: 'masque',
    settings: { port: 443 },
    streamSettings: { tlsSettings: { alpn: ['h2'] } },
  });
});

it('matches TCP preread ALPN and stream TLS termination with upstream PROXY protocol', async () => {
  const nginx: NginxObservation = {
    state: 'ready',
    config: [
      block(
        'stream',
        directive(
          'map',
          ['$ssl_preread_alpn_protocols', '$peer'],
          [directive('~\\bh2\\b', ['127.0.0.1:4210']), directive('default', ['127.0.0.1:4209'])],
        ),
        block(
          'server',
          directive('listen', ['443']),
          directive('ssl_preread', ['on']),
          directive('proxy_pass', ['$peer']),
        ),
        block(
          'server',
          directive('listen', ['8443', 'ssl']),
          directive('server_name', ['proxy.example.test']),
          directive('proxy_protocol', ['on']),
          directive('proxy_pass', ['127.0.0.1:4211']),
        ),
      ),
    ],
  };
  const grpc = listener('gRPC', 4210, {
    method: 'grpc',
    security: 'tls',
    grpcSettings: { serviceName: 'rpc' },
  });
  const raw = listener('raw behind nginx TLS', 4211, { sockopt: { acceptProxyProtocol: true } });
  const routes = nginxRoutes(nginx, { inbounds: [grpc, raw] }, session.host);
  expect(routes).toMatchObject([
    { inbound: 0, port: 443, alpn: ['h2'], security: 'tls' },
    {
      inbound: 1,
      port: 8443,
      serverName: 'proxy.example.test',
      security: 'tls',
      terminatesTls: true,
    },
  ]);
});

it('keeps local listeners out of Pool when the public location does not match', async () => {
  const nginx = fixture(
    directive('location', ['^~', '/other/'], [directive('proxy_pass', ['https://127.0.0.1:444'])]),
  );
  const text = JSON.stringify({
    inbounds: [xhttp, { ...xhttp, tag: 'public', listen: '0.0.0.0', port: 8445 }],
  });
  const observation = await observedPoolAccounts(session, {
    path: '/xray.json',
    text,
    sha256: '',
    bytes: text.length,
    nginx,
  });
  expect(observation.skipped).toEqual(['web']);
  expect(observation.accounts.map(({ inbound }) => inbound)).toEqual(['public']);
});
