import { expect, it } from 'vitest';
import { largeGraph } from './analysis';
import { createChainedExample } from './chainedExample';
import { createPolicyExample } from './policyExample';
import { importXrayConfig } from './xrayImport';

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
