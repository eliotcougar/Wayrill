import { makeNode, makeProxyInbound } from './catalog';
import { factoryDefaults } from './defaults';
import type { GraphState } from './types';
import { readDnsFilter } from './dns';
import { FAKE_DNS_PORT } from './fakeDns';

export function createFakeDnsExample(): GraphState {
  const input = makeProxyInbound('socks', { x: 30, y: 40 }, 'fake-input');
  Object.assign(input.data.settings, {
    tag: 'local',
    port: 2080,
    sniffing: false,
    metadataOnly: true,
    sniffHttp: false,
    sniffTls: false,
    sniffQuic: false,
  });
  input.data.overrides = ['sniffing', 'metadataOnly', 'sniffHttp', 'sniffTls', 'sniffQuic'];
  const handler = makeNode('dns-handler', { x: 370, y: 270 }, 'fake-handler');
  handler.data.settings.queryStrategy = 'UseIPv4';
  const resolver = makeNode('fakedns', { x: 740, y: 290 }, 'fake-resolver');
  const direct = makeNode('direct-outbound', { x: 740, y: 30 }, 'fake-direct');
  const routing = makeNode('dns-routing-filter', { x: 740, y: 290 }, 'fake-routing');
  const real = makeNode('dns-servers', { x: 1100, y: 450 }, 'fake-real-dns');
  real.data.label = 'Real DNS';
  resolver.position = { x: 1100, y: 80 };
  const fallback = readDnsFilter(routing.data.settings).outputs.find((o) => o.fallback)!.id;
  return {
    name: 'FakeDNS domain recovery',
    defaults: factoryDefaults(),
    nodes: [input, handler, routing, resolver, real, direct],
    edges: [
      {
        id: 'fake-data',
        source: input.id,
        sourceHandle: 'data',
        target: direct.id,
        targetHandle: 'in',
      },
      {
        id: 'fake-dns',
        source: input.id,
        sourceHandle: 'dns',
        target: handler.id,
        targetHandle: 'in',
      },
      {
        id: 'fake-selection',
        source: handler.id,
        sourceHandle: 'resolver',
        target: routing.id,
        targetHandle: 'in',
      },
      {
        id: 'fake-pool',
        source: routing.id,
        sourceHandle: FAKE_DNS_PORT,
        target: resolver.id,
        targetHandle: 'in',
      },
      {
        id: 'fake-real',
        source: routing.id,
        sourceHandle: fallback,
        target: real.id,
        targetHandle: 'in',
      },
      {
        id: 'fake-real-transport',
        source: real.id,
        sourceHandle: 'queries',
        target: direct.id,
        targetHandle: 'in',
      },
    ],
  };
}
