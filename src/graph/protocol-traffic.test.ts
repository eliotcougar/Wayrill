/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { fixtureId } from './protocolFixtures';

// Optional disposable paired peers for Windows service QA. Secrets here belong
// only to the loopback fixtures; never load a host subscription into this suite.
const materialPath = process.env.WAYRILL_PROTOCOL_QA_MATERIAL,
  core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
const protocols = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'http',
  'socks',
  'wireguard',
  'hysteria',
  'masque',
];
describe.skipIf(!materialPath || !core || !dir)(
  'Graph-generated paired protocol traffic fixtures',
  () => {
    for (const protocol of protocols)
      for (const direction of ['input', 'output'])
        it(`${protocol} ${direction}: lossless paired core configs`, () => {
          const m = JSON.parse(readFileSync(materialPath!, 'utf8')) as Record<string, unknown>,
            password = 'fictional-qa-only';
          const cert = { certificate: m.certificate, key: m.key },
            trust = { certificate: m.certificate, usage: 'verify' };
          const server: Record<string, unknown> = {
              tag: 'qa-peer',
              protocol,
              listen: '127.0.0.1',
              port: 20922,
              settings: {},
            },
            out: Record<string, unknown> = {
              tag: 'qa-protocol',
              protocol,
              settings: { address: '127.0.0.1', port: 20922 },
            };
          const s = server.settings as Record<string, unknown>,
            o = out.settings as Record<string, unknown>;
          if (protocol === 'vless') {
            Object.assign(s, { decryption: 'none', clients: [{ id: fixtureId }] });
            Object.assign(o, { id: fixtureId, encryption: 'none' });
          }
          if (protocol === 'vmess') {
            s.clients = [{ id: fixtureId }];
            Object.assign(o, { id: fixtureId, security: 'auto' });
          }
          if (protocol === 'trojan') {
            s.clients = [{ password }];
            o.password = password;
          }
          if (protocol === 'shadowsocks') {
            Object.assign(s, { method: 'aes-128-gcm', password, network: 'tcp,udp' });
            Object.assign(o, { method: 'aes-128-gcm', password });
          }
          if (['http', 'socks'].includes(protocol)) {
            Object.assign(s, {
              accounts: [{ user: 'qa-peer', pass: password }],
              ...(protocol === 'socks' ? { auth: 'password', udp: true } : {}),
            });
            Object.assign(o, { user: 'qa-peer', pass: password });
          }
          if (protocol === 'wireguard') {
            server.settings = {
              secretKey: m.serverPrivate,
              address: ['10.90.0.1'],
              peers: [
                { publicKey: m.clientPublic, allowedIPs: ['10.90.0.2/32'], email: 'qa-peer' },
              ],
              noKernelTun: true,
            };
            out.settings = {
              secretKey: m.clientPrivate,
              address: ['10.90.0.2'],
              peers: [
                {
                  publicKey: m.serverPublic,
                  endpoint: '127.0.0.1:20922',
                  allowedIPs: ['0.0.0.0/0'],
                  keepAlive: 0,
                },
              ],
              noKernelTun: true,
            };
          }
          if (['trojan', 'hysteria', 'masque'].includes(protocol)) {
            const network = protocol === 'trojan' ? 'raw' : protocol;
            server.streamSettings = {
              network,
              security: 'tls',
              tlsSettings: { certificates: [cert] },
              ...(protocol === 'hysteria'
                ? { hysteriaSettings: { version: 2 } }
                : protocol === 'masque'
                  ? { masqueSettings: {} }
                  : {}),
            };
            out.streamSettings = {
              network,
              security: 'tls',
              tlsSettings: {
                serverName: 'localhost',
                certificates: [trust],
                disableSystemRoot: true,
              },
              ...(protocol === 'hysteria'
                ? { hysteriaSettings: { version: 2, auth: password } }
                : protocol === 'masque'
                  ? { masqueSettings: { user: 'qa@example.invalid', pass: password } }
                  : {}),
            };
          }
          if (protocol === 'hysteria') {
            Object.assign(s, { version: 2, clients: [{ auth: password }] });
            o.version = 2;
          }
          if (protocol === 'masque') {
            Object.assign(s, {
              address: ['10.91.0.1/24'],
              clients: [{ email: 'qa@example.invalid', pass: password }],
            });
          }
          const input = {
            tag: 'qa-mixed',
            protocol: 'mixed',
            listen: '127.0.0.1',
            port: 20921,
            settings: { auth: 'noauth', udp: true },
          };
          // Pinned Freedom blocks private targets for server protocols by default.
          // Permit only this fixture's loopback HTTP/UDP destinations.
          const direct = {
            tag: 'direct',
            protocol: 'freedom',
            settings: {
              finalRules: [{ action: 'allow', ip: ['127.0.0.1/32'], port: '18880-18881' }],
            },
          };
          // Userspace IP stacks reject loopback destinations inside tunnel packets.
          // Use a virtual tunnel address, then rewrite only this peer's test traffic
          // to loopback. No Windows adapter or route is installed.
          if (['wireguard', 'masque'].includes(protocol))
            Object.assign(direct.settings, { redirect: '127.0.0.1:0' });
          const peerServer = { inbounds: [server], outbounds: [direct] },
            peerClient = { inbounds: [input], outbounds: [out] };
          mkdirSync(dir!, { recursive: true });
          for (const [role, config] of [
            ['service', direction === 'input' ? peerServer : peerClient],
            ['peer', direction === 'input' ? peerClient : peerServer],
          ] as const) {
            const exported = compileXrayGraph(importXrayConfig(JSON.stringify(config))).config;
            expect(exported).toEqual(config);
            const file = join(dir!, `traffic-${protocol}-${direction}-${role}.json`);
            writeFileSync(file, JSON.stringify(exported, null, 2));
            const result = spawnSync(core!, ['run', '-test', '-config', file], {
              encoding: 'utf8',
              windowsHide: true,
              timeout: 10000,
            });
            writeFileSync(file + '.log', `${result.stdout}\n${result.stderr}`);
            expect(result.status, result.stdout + result.stderr).toBe(0);
          }
        });
    for (const protocol of ['tunnel', 'loopback', 'dns'])
      it(`${protocol}: graph-generated traffic fixture`, () => {
        const input = {
            tag: 'qa-mixed',
            protocol: 'mixed',
            listen: '127.0.0.1',
            port: 20921,
            settings: { auth: 'noauth', udp: true },
          },
          direct = { tag: 'direct', protocol: 'freedom' };
        const config =
          protocol === 'tunnel'
            ? {
                inbounds: [
                  {
                    tag: 'tunnel-tcp',
                    protocol: 'tunnel',
                    listen: '127.0.0.1',
                    port: 20922,
                    settings: {
                      rewriteAddress: '127.0.0.1',
                      rewritePort: 18880,
                      allowedNetwork: 'tcp',
                    },
                  },
                  {
                    tag: 'tunnel-udp',
                    protocol: 'dokodemo-door',
                    listen: '127.0.0.1',
                    port: 20924,
                    settings: {
                      rewriteAddress: '127.0.0.1',
                      rewritePort: 18881,
                      allowedNetwork: 'udp',
                    },
                  },
                ],
                outbounds: [direct],
              }
            : protocol === 'loopback'
              ? {
                  inbounds: [input],
                  outbounds: [
                    { tag: 'loop', protocol: 'loopback', settings: { inboundTag: 'qa-reinject' } },
                    direct,
                  ],
                  routing: {
                    rules: [{ type: 'field', inboundTag: ['qa-reinject'], outboundTag: 'direct' }],
                  },
                }
              : {
                  inbounds: [input],
                  outbounds: [
                    {
                      tag: 'dns',
                      protocol: 'dns',
                      settings: {
                        rewriteAddress: '127.0.0.1',
                        rewritePort: 18895,
                        allowedNetwork: 'udp',
                      },
                    },
                  ],
                  dns: { servers: [{ address: '127.0.0.1', port: 18895 }] },
                };
        const exported = compileXrayGraph(importXrayConfig(JSON.stringify(config))).config;
        expect(exported).toEqual(config);
        const file = join(dir!, `traffic-${protocol}-service.json`);
        writeFileSync(file, JSON.stringify(exported, null, 2));
        const result = spawnSync(core!, ['run', '-test', '-config', file], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        });
        writeFileSync(file + '.log', `${result.stdout}\n${result.stderr}`);
        expect(result.status, result.stdout + result.stderr).toBe(0);
      });
  },
);
