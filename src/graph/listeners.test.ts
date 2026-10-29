import { describe, expect, it } from 'vitest';
import { listenerEndpointsConflict } from './listeners';
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
