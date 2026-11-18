import { expect, it } from 'vitest';
import { largeGraph } from './analysis';
import { createChainedExample } from './chainedExample';

it('offloads chained filters before shared paths can expand on the UI thread', () => {
  const graph = createChainedExample();
  expect(largeGraph(graph)).toBe(true);
  graph.edges = graph.edges.filter((edge) => edge.source !== 'entry-filter');
  expect(largeGraph(graph)).toBe(false);
});
