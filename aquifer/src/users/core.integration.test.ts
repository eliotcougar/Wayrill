import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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
