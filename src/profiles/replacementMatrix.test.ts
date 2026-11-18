import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { compileRuntimeGraph } from '../graph/runtime';
import { applyStashedProfile } from './graph';
import { graph, replacementCases } from './replacementMatrix.fixture';
it.each(['tun-inbound', 'windivert-inbound'] as const)(
  'preserves %s capture when replacing a policy containing a chain with a chain containing a policy',
  (kind) => {
    const base = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'input' ? makeNode(kind, node.position, node.id) : node,
      ),
      edges: graph.edges.map((edge) =>
        edge.source === 'input' && edge.sourceHandle === 'data' && kind === 'tun-inbound'
          ? { ...edge, sourceHandle: 'traffic' }
          : edge,
      ),
    };
    const { original, candidate } = replacementCases.find(
      ({ from, to }) => from === 'policyChain' && to === 'chainPolicy',
    )!;
    const before = compileRuntimeGraph(
      applyStashedProfile(base, original, { x: 0, y: 0 }, 'proxy'),
    );
    expect(before.capture?.inputs).toHaveLength(1);
    expect(compileRuntimeGraph(candidate(base)).capture).toEqual(before.capture);
  },
);
