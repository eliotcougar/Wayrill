import { expect, it } from 'vitest';
import { analyzeGraph, largeGraph } from './analysis';
import { diagnoseRuntimeGraph } from './diagnostics';
import { compileRuntimeGraph } from './runtime';
import { createTrafficExample } from './example';
import { createChainedExample } from './chainedExample';
import { createPolicyExample } from './policyExample';
import { importXrayConfig } from './xrayImport';
it('returns the same diagnostics and complete executable config as direct compilation', () => {
  for (const graph of [createTrafficExample(), createPolicyExample('leastPing')]) {
    const result = analyzeGraph(graph);
    expect(result.issues).toEqual(diagnoseRuntimeGraph(graph));
    expect(result.compilation).toEqual(compileRuntimeGraph(graph));
    expect(result.configBytes).toBe(
      new TextEncoder().encode(JSON.stringify(result.compilation!.config)).length,
    );
  }
});
it('returns errors without an executable configuration for an invalid graph', () => {
  const graph = createTrafficExample();
  graph.edges = [];
  const result = analyzeGraph(graph);
  expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
  expect(result.compilation).toBeNull();
  expect(result.configBytes).toBe(0);
});

it('offloads large ordinary routing tables, including many small settings', () => {
  const graph = createTrafficExample();
  const filter = graph.nodes.find((n) => n.data.kind === 'routing-filter')!;
  const rows = JSON.parse(String(filter.data.settings.rules));
  filter.data.settings.rules = JSON.stringify(
    Array.from({ length: 2000 }, (_, i) => ({ ...rows[0], id: `row-${i}` })),
  );
  expect(largeGraph(graph)).toBe(true);
});

it('offloads chained filters before shared paths can expand on the UI thread', () => {
  const graph = createChainedExample();
  expect(graph.nodes.length).toBeLessThan(20);
  expect(largeGraph(graph)).toBe(true);
  graph.edges = graph.edges.filter((edge) => edge.source !== 'entry-filter');
  expect(largeGraph(graph)).toBe(false);
});

it('offloads an imported policy pool above the interactive threshold', () => {
  expect(largeGraph(createPolicyExample())).toBe(false);
  const graph = importXrayConfig(
    JSON.stringify({
      outbounds: Array.from({ length: 502 }, (_, i) => ({
        tag: `candidate-${i}`,
        protocol: 'freedom',
      })),
      routing: { balancers: [{ tag: 'pool', selector: ['candidate-'] }] },
    }),
  );
  expect(largeGraph(graph)).toBe(true);
});
