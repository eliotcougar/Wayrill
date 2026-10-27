import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { udpDnsPolicyWarnings, tcpResolverAddress } from './dnsTransport';
import type { GraphState } from './types';

it('converts literal UDP addresses without losing nonstandard ports or IPv6 brackets', () => {
  expect(tcpResolverAddress('10.0.2.2', 19353)).toBe('tcp://10.0.2.2:19353');
  expect(tcpResolverAddress('2001:db8::53', 5353)).toBe('tcp://[2001:db8::53]:5353');
  expect(() => tcpResolverAddress('https://example.test/dns-query')).toThrow();
  expect(() => tcpResolverAddress('1.1.1.1', 0)).toThrow();
});
it('locates UDP policy failover warnings and leaves the graph unchanged', () => {
  const servers = makeNode('dns-servers', { x: 0, y: 0 }, 'servers');
  const policy = makeNode('policy-group', { x: 1, y: 1 }, 'policy');
  policy.data.settings.fallbackEnabled = true;
  const graph = {
    name: 'Public test',
    nodes: [servers, policy],
    edges: [
      {
        id: 'wire',
        source: servers.id,
        sourceHandle: 'queries',
        target: policy.id,
        targetHandle: 'in',
      },
    ],
  } as GraphState;
  const before = structuredClone(graph);
  expect(udpDnsPolicyWarnings(graph)).toEqual([
    expect.objectContaining({
      nodeId: 'servers',
      rowId: 'server-1',
      fieldKey: 'address',
      severity: 'warning',
    }),
  ]);
  expect(graph).toEqual(before);
  const rows = JSON.parse(String(servers.data.settings.servers));
  rows[0].address = 'tcp://1.1.1.1:53';
  servers.data.settings.servers = JSON.stringify(rows);
  expect(udpDnsPolicyWarnings(graph)).toEqual([]);
  rows[0].address = 'localhost';
  servers.data.settings.servers = JSON.stringify(rows);
  expect(udpDnsPolicyWarnings(graph)).toEqual([]);
});
it('includes native string resolver entries in the same warning without changing their representation', () => {
  const servers = makeNode('xray-dns-servers', { x: 0, y: 0 }, 'native');
  servers.data.settings.json = JSON.stringify({
    servers: ['1.1.1.1', { address: 'tcp://8.8.8.8:53' }],
  });
  const policy = makeNode('policy-group', { x: 1, y: 1 }, 'policy');
  policy.data.settings.strategy = 'leastPing';
  const graph = {
    name: 'Imported test',
    nodes: [servers, policy],
    edges: [
      {
        id: 'wire',
        source: servers.id,
        sourceHandle: 'queries',
        target: policy.id,
        targetHandle: 'in',
      },
    ],
  } as GraphState;
  expect(udpDnsPolicyWarnings(graph)).toHaveLength(1);
  expect(udpDnsPolicyWarnings(graph)[0]).toMatchObject({ nodeId: 'native', fieldKey: 'json' });
});
