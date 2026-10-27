import { describe, expect, it } from 'vitest';
import { sameExecutionGraph } from './useExecutionGraph';
import { createRoutingExample } from './graph/example';

describe('compiler work isolation', () => {
  it('ignores canvas positions, viewport, graph title and selection', () => {
    const graph = createRoutingExample();
    const moved = {
      ...graph,
      name: 'Renamed',
      viewport: { x: 10, y: 10, zoom: 1 },
      nodes: graph.nodes.map((n) => ({ ...n, selected: true, position: { x: 10, y: 10 } })),
      edges: graph.edges.map((e) => ({ ...e, selected: true })),
    };
    expect(sameExecutionGraph(graph, moved)).toBe(true);
  });
  it('detects changes to settings, connections, defaults and native metadata', () => {
    const graph = createRoutingExample();
    expect(
      sameExecutionGraph(graph, {
        ...graph,
        nodes: graph.nodes.map((n, i) =>
          i ? n : { ...n, data: { ...n.data, settings: { ...n.data.settings, port: 21900 } } },
        ),
      }),
    ).toBe(false);
    expect(sameExecutionGraph(graph, { ...graph, edges: graph.edges.slice(1) })).toBe(false);
    expect(sameExecutionGraph(graph, { ...graph, defaults: { version: 1, settings: {} } })).toBe(
      false,
    );
  });
});

it.each([
  { bypassLocalTraffic: false },
  { interfaces: { monitorNewInterfaces: false, interfaces: [] } },
  {
    interfaces: {
      monitorNewInterfaces: true,
      interfaces: [{ id: 'adapter', name: 'LAN', monitored: false }],
    },
  },
])('invalidates analysis when capture policy changes: %j', async (change) => {
  const { defaultCaptureOptions } = await import('./graph/capture');
  const graph = { ...createRoutingExample(), captureOptions: defaultCaptureOptions() };
  expect(
    sameExecutionGraph(graph, { ...graph, captureOptions: { ...graph.captureOptions, ...change } }),
  ).toBe(false);
  expect(sameExecutionGraph(createRoutingExample(), graph)).toBe(false);
});
