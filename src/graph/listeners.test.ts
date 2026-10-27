import { listenerNetworks } from './listenerNetworks';
import { describe, expect, it } from 'vitest';
import { listenerEndpointsConflict, listenerProblem } from './listeners';
import { listenerEndpointKeys } from './inbounds';

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
  it('keeps wildcard UDP and TCP as separate sockets', () => {
    expect(
      listenerEndpointKeys({
        protocol: 'tunnel',
        listen: '::',
        port: 53,
        settings: { network: 'tcp,udp' },
      }),
    ).toEqual(['tcp:[::]:53', 'udp:[::]:53']);
  });
  it('rejects malformed IPs and ports without rejecting public addresses', () => {
    for (const listen of ['192.0.2.1', '::', '0.0.0.0', 'localhost'])
      expect(listenerProblem({ listen, port: 80 })).toBeNull();
    for (const listen of ['example.org', '999.1.1.1', '[::1]', ''])
      expect(listenerProblem({ listen, port: 80 })).toMatch(/address/);
    for (const port of [0, 65536, 1.5, -1, '80'])
      expect(listenerProblem({ listen: '0.0.0.0', port })).toMatch(/port/);
  });
});

it.each([
  ['mixed', {}, {}, ['tcp']],
  ['http', {}, {}, ['tcp']],
  ['tun', {}, {}, []],
  ['wireguard', {}, {}, ['udp']],
  ['tunnel', { allowedNetwork: 'tcp,udp' }, {}, ['tcp', 'udp']],
  ['shadowsocks', { network: ['udp'] }, {}, ['udp']],
  ['vmess', {}, { network: 'kcp' }, ['udp']],
  ['hysteria', {}, { network: 'hysteria' }, ['udp']],
  ['masque', {}, { network: 'masque' }, ['udp']],
  ['masque', {}, { network: 'masque', security: 'tls', tlsSettings: { alpn: ['h2'] } }, ['tcp']],
  [
    'masque',
    {},
    { network: 'masque', security: 'tls', tlsSettings: { alpn: ['h2', 'h3'] } },
    ['tcp', 'udp'],
  ],
  ['vless', {}, { network: 'xhttp', security: 'tls', tlsSettings: { alpn: ['h3'] } }, ['udp']],
  ['masque', {}, { network: 'masque', security: 'tls', tlsSettings: { alpn: 'h2' } }, ['tcp']],
  [
    'masque',
    {},
    { network: 'masque', security: 'tls', tlsSettings: { alpn: 'h2,h3' } },
    ['tcp', 'udp'],
  ],
  ['vless', {}, { network: 'xhttp', security: 'tls', tlsSettings: { alpn: 'h3' } }, ['udp']],
  ['trojan', {}, { network: 'ws' }, ['tcp']],
])('selects the physical %s listener sockets', (protocol, settings, streamSettings, expected) => {
  expect(listenerNetworks({ protocol, settings, streamSettings })).toEqual(expected);
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
