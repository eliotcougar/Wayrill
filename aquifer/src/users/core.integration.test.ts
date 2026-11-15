import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { observedPoolAccounts } from './observedPoolAccounts';
import {
  addSetToWorkspace,
  compileUsers,
  connectUserSet,
  createUserWorkspace,
  emptyLibrary,
  newUserSet,
  type UserProtocol,
} from './model';

const core = process.env.WAYRILL_REMOTE_TEST_CORE;
const directory = resolve(
  process.env.WAYRILL_REMOTE_CORE_FIXTURES ?? '.tools/user-config-fixtures',
);
const protocols: [string, UserProtocol, Record<string, unknown>][] = [
  ['vless', 'vless', { decryption: 'none' }],
  ['vmess', 'vmess', {}],
  ['trojan', 'trojan', {}],
  ['socks', 'password', { auth: 'noauth', udp: true }],
  ['http', 'password', {}],
  ['mixed', 'password', {}],
  ['shadowsocks', 'shadowsocks', { clients: [] }],
  [
    'ss2022-128',
    'ss2022-128',
    { method: '2022-blake3-aes-128-gcm', password: 'AAAAAAAAAAAAAAAAAAAAAA==', clients: [] },
  ],
  [
    'ss2022-256',
    'ss2022-256',
    {
      method: '2022-blake3-aes-256-gcm',
      password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      clients: [],
    },
  ],
  ['hysteria', 'hysteria', { version: 2 }],
  ['masque', 'masque', { address: ['10.201.0.1/24'] }],
];
describe('executable Xray user configuration validation', () => {
  it.each(protocols)('accepts compiled multi-user %s settings', (name, family, settings) => {
    mkdirSync(directory, { recursive: true });
    const protocol = name.startsWith('ss2022') ? 'shadowsocks' : name;
    const config = {
      inbounds: [
        {
          tag: 'users-one',
          protocol,
          listen: '127.0.0.1',
          port: 18080,
          settings,
          ...(name === 'hysteria'
            ? {
                streamSettings: {
                  network: 'hysteria',
                  security: 'tls',
                  hysteriaSettings: { version: 2 },
                },
              }
            : name === 'masque'
              ? { streamSettings: { network: 'masque', security: 'tls' } }
              : {}),
        },
      ],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    };
    const set = newUserSet(family),
      second = newUserSet(family);
    if (family === 'password') second.users[0].account.user = 'second-user';
    else second.users[0].account.email = 'second-user';
    let workspace = createUserWorkspace(config, emptyLibrary());
    workspace = connectUserSet(config, addSetToWorkspace(workspace, set), set.id, 0);
    workspace = connectUserSet(config, addSetToWorkspace(workspace, second), second.id, 0);
    const result = compileUsers(config, workspace);
    expect(result.errors).toEqual([]);
    const file = join(directory, name + '.json');
    writeFileSync(file, JSON.stringify(result.config, null, 2));
    const test = spawnSync(core!, ['run', '-test', '-config', file], {
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true,
    });
    writeFileSync(join(directory, name + '.log'), test.stdout + test.stderr);
    expect(test.error).toBeUndefined();
    expect(test.status, test.stdout + test.stderr).toBe(0);
  });
});

it('accepts client profiles derived from Nginx HTTP/3, gRPC and UDP routes', async () => {
  const location = (path: string, target: string) => ({
    name: 'location',
    args: [path],
    children: [{ name: 'grpc_pass', args: [target] }],
  });
  const id = '8b950709-245d-40f2-a65f-3e937907838a';
  const inbounds = [
    {
      protocol: 'vless',
      listen: '/run/xhttp.sock,0666',
      settings: { decryption: 'none', clients: [{ id }] },
      streamSettings: { method: 'xhttp', xhttpSettings: { path: '/edge/', mode: 'stream-one' } },
    },
    {
      protocol: 'trojan',
      listen: '127.0.0.1',
      port: 1441,
      settings: { clients: [{ password: 'test-account' }] },
      streamSettings: { method: 'grpc', grpcSettings: { serviceName: '/rpc/v1/member|batch' } },
    },
    {
      protocol: 'hysteria',
      listen: '127.0.0.1',
      port: 1442,
      settings: { version: 2, clients: [{ auth: 'test-account', email: 'tester' }] },
      streamSettings: {
        method: 'hysteria',
        security: 'tls',
        tlsSettings: { serverName: 'edge.example.test' },
      },
    },
  ];
  const text = JSON.stringify({ inbounds });
  const session = {
    id: 'example',
    name: 'Test server',
    host: 'edge.example.test',
    user: 'admin',
    port: 22,
  };
  const observed = await observedPoolAccounts(session, {
    path: '/etc/xray.json',
    text,
    sha256: '',
    bytes: text.length,
    nginx: {
      state: 'ready',
      config: [
        {
          name: 'http',
          args: [],
          children: [
            {
              name: 'server',
              args: [],
              children: [
                { name: 'server_name', args: ['edge.example.test'] },
                { name: 'listen', args: ['443', 'quic'] },
                location('/edge/', 'unix:/run/xhttp.sock'),
              ],
            },
            {
              name: 'server',
              args: [],
              children: [
                { name: 'server_name', args: ['edge.example.test'] },
                { name: 'listen', args: ['443', 'ssl', 'http2'] },
                location('/rpc/v1/batch', '127.0.0.1:1441'),
              ],
            },
          ],
        },
        {
          name: 'stream',
          args: [],
          children: [
            {
              name: 'server',
              args: [],
              children: [
                { name: 'listen', args: ['2443', 'udp', 'reuseport'] },
                { name: 'proxy_pass', args: ['127.0.0.1:1442'] },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(observed.skipped).toEqual([]);
  expect(observed.accounts).toHaveLength(inbounds.length);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'nginx-client.json');
  writeFileSync(
    path,
    JSON.stringify({
      outbounds: observed.accounts.map(({ outbound }, index) => ({
        ...outbound,
        tag: 'client-' + index,
      })),
    }),
  );
  const test = spawnSync(core!, ['run', '-test', '-config', path], {
    encoding: 'utf-8',
    timeout: 15000,
    windowsHide: true,
  });
  expect(test.error).toBeUndefined();
  expect(test.status, test.stdout + test.stderr).toBe(0);
});
