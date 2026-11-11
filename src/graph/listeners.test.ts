import { describe, expect, it } from 'vitest';
import { listenerEndpointsConflict } from './listeners';
import { listenerEndpointKeys } from './inbounds';
import { importXrayConfig } from './xrayImport';
import { diagnoseGraph } from './model';
import { importXrayConfig as importAquifer } from '../../aquifer/src/graph/xrayImport';
import { diagnoseGraph as diagnoseAquifer } from '../../aquifer/src/graph/model';

describe.each([
  ['Wayrill', (source: string) => diagnoseGraph(importXrayConfig(source))],
  ['Aquifer', (source: string) => diagnoseAquifer(importAquifer(source))],
] as const)('%s listener diagnostics', (_app, diagnose) => {
  it.each([
    ['xhttp', 'h3', false],
    ['masque', 'h2', true],
  ] as const)('checks %s/%s against a TCP listener on the same port', (network, alpn, conflict) => {
    const listener = { listen: '127.0.0.1', port: 2090 };
    const config = {
      inbounds: [
        {
          ...listener,
          tag: 'transport',
          protocol: 'vless',
          settings: {
            decryption: 'none',
            clients: [{ id: '11111111-2222-4333-8444-555555555555' }],
          },
          streamSettings: { network, security: 'tls', tlsSettings: { alpn: [alpn] } },
        },
        { ...listener, tag: 'proxy', protocol: 'http', settings: {} },
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    };
    const issues = diagnose(JSON.stringify(config)).filter((issue) =>
      /Listener conflicts/.test(issue.message),
    );
    expect(issues).toHaveLength(conflict ? 2 : 0);
    if (conflict) expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
  });
});

describe('Socket overlap semantics', () => {
  it.each([
    ['tcp:0.0.0.0:80', 'tcp:192.0.2.1:80', true],
    ['tcp:[::]:80', 'tcp:192.0.2.1:80', true],
    ['tcp:[::]:80', 'tcp:[2001:db8::1]:80', true],
    ['tcp:[0:0:0:0:0:0:0:1]:80', 'tcp:[::1]:80', true],
    ['tcp:[::ffff:127.0.0.1]:80', 'tcp:127.0.0.1:80', true],
    ['tcp:0.0.0.0:80', 'udp:127.0.0.1:80', false],
    ['tcp:0.0.0.0:80', 'tcp:127.0.0.1:443', false],
    ['tcp:0.0.0.0:80', 'tcp:[::1]:80', true],
    ['tcp:127.0.0.1:80', 'tcp:192.0.2.1:80', false],
    ['tcp:[2001:db8::1]:80', 'tcp:[2001:db8::2]:80', false],
  ])('%s versus %s', (a, b, expected) => {
    expect(listenerEndpointsConflict(a, b)).toBe(expected);
    expect(listenerEndpointsConflict(b, a)).toBe(expected);
  });
});

it('uses UDP for XHTTP/3 only while TLS is enabled, and checks MASQUE TCP and UDP separately', () => {
  const input = {
    protocol: 'vless',
    listen: '127.0.0.1',
    port: 2090,
    streamSettings: { network: 'xhttp', security: 'tls', tlsSettings: { alpn: ['h3'] } },
  };
  expect(listenerEndpointKeys(input)).toEqual(['udp:127.0.0.1:2090']);
  input.streamSettings.security = 'none';
  expect(listenerEndpointKeys(input)).toEqual(['tcp:127.0.0.1:2090']);
  input.streamSettings = {
    network: 'masque',
    security: 'tls',
    tlsSettings: { alpn: ['h2', 'h3'] },
  };
  expect(listenerEndpointKeys(input)).toEqual(['tcp:127.0.0.1:2090', 'udp:127.0.0.1:2090']);
  input.streamSettings.tlsSettings.alpn = ['h2'];
  expect(listenerEndpointKeys(input)).toEqual(['tcp:127.0.0.1:2090']);
});
