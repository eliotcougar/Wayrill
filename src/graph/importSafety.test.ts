import { expect, it } from 'vitest';
import { importXrayConfig } from './xrayImport';
import { compileXrayGraph } from './xrayCompiler';
import { parseGraph, serializeGraph } from './model';

it('keeps DNS and a route to the last of 5,000 imported outbounds after saving', () => {
  const count = 5000;
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
});
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
