import { describe, it, expect } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults, resolveGraph } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { compileCapturePlan, defaultCaptureOptions, parseCaptureOptions } from './capture';
import { parseGraph, serializeGraph } from './model';
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
  it('retains identities and adapter choices in graph files', () => {
    const graph = fixture();
    graph.captureOptions = {
      ...defaultCaptureOptions(),
      interfaces: {
        monitorNewInterfaces: false,
        interfaces: [{ id: 'adapter-one', name: 'LAN', monitored: true }],
      },
    };
    const restored = parseGraph(serializeGraph(graph));
    expect(compileCapturePlan(restored)).toEqual(compileCapturePlan(graph));
    expect(compileRuntimeGraph(restored).config).toEqual(compileRuntimeGraph(graph).config);
  });
  it('uses app sniffing defaults while retaining the required relay UDP support', () => {
    const graph = fixture();
    graph.defaults!.settings.sniffing = true;
    graph.defaults!.settings.routeOnly = false;
    graph.defaults!.settings.udp = false;
    expect(compileRuntimeGraph(resolveGraph(graph)).config.inbounds).toMatchObject([
      { settings: { udp: true }, sniffing: { enabled: true, routeOnly: false } },
    ]);
  });
  it('orders capture inputs by priority without embedding application filters', () => {
    const graph = fixture();
    const second = structuredClone(graph.nodes[0]);
    second.id = 'second';
    second.data.settings.tag = 'second';
    second.data.settings.capturePriority = 1;
    second.data.settings.port = 22081;
    graph.nodes.push(second);
    expect(compileCapturePlan(graph)?.inputs.map((i) => i.tag)).toEqual([
      'second',
      'captured-traffic',
    ]);
    expect(
      compileCapturePlan(graph)?.inputs.every((i) => i.ports === '' && i.selectors.length === 0),
    ).toBe(true);
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
  it('rejects duplicate adapter identities', () =>
    expect(() =>
      parseCaptureOptions({
        ...defaultCaptureOptions(),
        interfaces: {
          monitorNewInterfaces: true,
          interfaces: [
            { id: 'LAN', name: 'LAN', monitored: true },
            { id: 'lan', name: 'LAN', monitored: false },
          ],
        },
      }),
    ).toThrow(/duplicate/));
});
