import { describe, it, expect } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { importXrayConfig } from './xrayImport';
import type { GraphState } from './types';
function fixture(): GraphState {
  const input = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture'),
    direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  return {
    name: 'Captured Windows traffic',
    defaults: factoryDefaults(),
    nodes: [input, direct],
    edges: ['data', 'dns'].map((port) => ({
      id: port,
      source: input.id,
      sourceHandle: port,
      target: direct.id,
      targetHandle: 'in',
    })),
  };
}
describe('Windows capture graph', () => {
  it('compiles the relay plan and distinct Data/DNS routing rules', () => {
    const result = compileRuntimeGraph(fixture());
    expect(result.capture?.inputs[0]).toMatchObject({
      tag: 'captured-traffic',
      networks: ['tcp', 'udp'],
      selectors: [],
      predicates: [],
      masks: ['0'],
    });
    expect(result.config.inbounds).toMatchObject([
      {
        listen: '127.0.0.1',
        port: 22080,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
      },
    ]);
    expect((result.config.routing as { rules: unknown[] }).rules).toHaveLength(2);
  });
  it('adds capture to an imported native global filter', () => {
    const graph = importXrayConfig(
      JSON.stringify({
        inbounds: [
          {
            tag: 'socks',
            protocol: 'socks',
            listen: '127.0.0.1',
            port: 2080,
            settings: { udp: true },
          },
        ],
        outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        routing: { rules: [] },
      }),
    );
    const capture = fixture().nodes[0];
    graph.nodes.push(capture);
    for (const port of ['data', 'dns'])
      graph.edges.push({
        id: `capture-${port}`,
        source: capture.id,
        sourceHandle: port,
        target: graph.xray!.routingNodeId,
        targetHandle: 'in',
      });
    expect(compileRuntimeGraph(graph).capture?.inputs).toHaveLength(1);
  });
});
