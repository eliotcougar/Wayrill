import { expect, it } from 'vitest';
import { makeNode } from '../graph/catalog';
import { analyzeGraph } from '../graph/analysis';
import { compileRuntimeGraph } from '../graph/runtime';
import { parseGraph, serializeGraph } from '../graph/model';
import { applyStashedProfile } from './graph';
import { graph, replacementCases } from './replacementMatrix.fixture';
for (const { label, original, candidate } of replacementCases) {
  it(label + ' preserves incoming routes and survives graph serialization', () => {
    const next = candidate();
    const analysis = analyzeGraph(next);
    expect(analysis.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(next.edges.filter((edge) => edge.target === 'proxy')).toEqual(
      parseGraph(serializeGraph(graph)).edges.filter((edge) => edge.target === 'proxy'),
    );
    expect(next.nodes.find((node) => node.id === 'proxy')!.data.settings.tag).toBe('proxy');
    expect(compileRuntimeGraph(parseGraph(serializeGraph(next)))).toEqual(analysis.compilation);
  });
  it(label + ' preserves TUN and WinDivert capture scope', () => {
    for (const kind of ['tun-inbound', 'windivert-inbound'] as const) {
      const captured = (g: typeof graph) => ({
        ...g,
        nodes: g.nodes.map((node) =>
          node.id === 'input' ? makeNode(kind, node.position, node.id) : node,
        ),
        edges: g.edges.map((edge) =>
          edge.source === 'input' && edge.sourceHandle === 'data' && kind === 'tun-inbound'
            ? { ...edge, sourceHandle: 'traffic' }
            : edge,
        ),
      });
      const before = compileRuntimeGraph(
        captured(applyStashedProfile(graph, original, { x: 0, y: 0 }, 'proxy')),
      );
      const after = compileRuntimeGraph(captured(candidate()));
      expect(before.capture).toBeDefined();
      expect(after.capture).toEqual(before.capture);
    }
  });
}
