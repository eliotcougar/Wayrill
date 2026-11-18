import { describe, expect, it } from 'vitest';
import { listenerEndpointsConflict } from './listeners';
import { listenerEndpointKeys } from './inbounds';
import { importXrayConfig } from './xrayImport';
import { diagnoseGraph } from './model';
import { importXrayConfig as importAquifer } from '../../aquifer/src/graph/xrayImport';
import { diagnoseGraph as diagnoseAquifer } from '../../aquifer/src/graph/model';

it.each([
  [
    'Wayrill',
    (source: string) => {
      const graph = importXrayConfig(source);
      return { nodes: graph.nodes, issues: diagnoseGraph(graph) };
    },
  ],
  [
    'Aquifer',
    (source: string) => {
      const graph = importAquifer(source);
      return { nodes: graph.nodes, issues: diagnoseAquifer(graph) };
    },
  ],
] as const)('%s flags only the TCP listeners sharing a port with XHTTP/3', (_app, inspect) => {
  const listener = { listen: '127.0.0.1', port: 2090 };
  const transported = (network: string, alpn: string) => ({
    ...listener,
    tag: network,
    protocol: 'vless',
    settings: { decryption: 'none', clients: [{ id: '11111111-2222-4333-8444-555555555555' }] },
    streamSettings: { network, security: 'tls', tlsSettings: { alpn: [alpn] } },
  });
  const config = {
    inbounds: [
      transported('xhttp', 'h3'),
      transported('masque', 'h2'),
      { ...listener, tag: 'proxy', protocol: 'http', settings: {} },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
  const { nodes, issues } = inspect(JSON.stringify(config));
  const conflicts = issues.filter((issue) => issue.message.includes('Listener conflicts'));
  expect(
    conflicts.map(({ nodeId }) => nodes.find((n) => n.id === nodeId)?.data.settings.tag).sort(),
  ).toEqual(['masque', 'proxy']);
  expect(conflicts.every(({ severity }) => severity === 'error')).toBe(true);
});

describe('Socket overlap semantics', () => {
  it.each([
    ['tcp:[::]:80', 'tcp:192.0.2.1:80', true],
    ['tcp:[0:0:0:0:0:0:0:1]:80', 'tcp:[::1]:80', true],
    ['tcp:[::ffff:127.0.0.1]:80', 'tcp:127.0.0.1:80', true],
    ['tcp:0.0.0.0:80', 'udp:127.0.0.1:80', false],
    ['tcp:0.0.0.0:80', 'tcp:127.0.0.1:443', false],
    ['tcp:0.0.0.0:80', 'tcp:[::1]:80', true],
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
