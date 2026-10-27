import { expect, it } from 'vitest';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';

it.each([501, 5000])(
  'keeps large imported pools with DNS and late explicit candidates reloadable (%i)',
  (count) => {
    const config = {
      outbounds: Array.from({ length: count }, (_, i) => ({
        tag: `candidate-${i}`,
        protocol: 'freedom',
        settings: {},
      })),
      routing: {
        rules: [
          {
            type: 'field',
            domain: ['full:private.example'],
            outboundTag: `candidate-${count - 1}`,
          },
        ],
      },
      dns: { servers: ['https://dns.example/dns-query'] },
    };
    const graph = importXrayConfig(JSON.stringify(config));
    expect(graph.nodes.length).toBeLessThan(10);
    expect(compileXrayGraph(parseGraph(serializeGraph(graph))).config).toEqual(config);
    expect(Math.max(...graph.nodes.map((node) => Math.abs(node.position.y)))).toBeLessThan(100000);
  },
);
it('rejects a conversion that would exceed the distinct output budget before replacing the workspace', () => {
  const config = {
    outbounds: Array.from({ length: 501 }, (_, i) => ({
      tag: `candidate-${i}`,
      protocol: 'freedom',
      settings: {},
    })),
    routing: {
      rules: Array.from({ length: 501 }, (_, i) => ({
        type: 'field',
        domain: [`full:domain-${i}.example`],
        outboundTag: `candidate-${i}`,
      })),
    },
  };
  expect(() => importXrayConfig(JSON.stringify(config))).toThrow(/graph.*size|128 outputs/i);
});

it('distinguishes unsupported API routing from a missing configured outbound', () => {
  const config = {
    api: { tag: 'control', services: ['StatsService'] },
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    routing: { rules: [{ type: 'field', inboundTag: ['control-in'], outboundTag: 'control' }] },
  };
  expect(() => importXrayConfig(JSON.stringify(config))).toThrow(
    /API virtual outbound.*not supported/,
  );
  config.routing.rules[0].outboundTag = 'missing';
  expect(() => importXrayConfig(JSON.stringify(config))).toThrow(/missing destination/);
});
