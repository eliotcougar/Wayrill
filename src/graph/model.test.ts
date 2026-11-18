import { describe, expect, it } from 'vitest';
import { createRoutingExample } from './example';
import { parseGraph, serializeGraph, toDocument } from './model';

describe('versioned graph files', () => {
  it('round-trips the graph while removing transient renderer and selection state', () => {
    const graph = createRoutingExample();
    graph.viewport = { x: 42, y: -19, zoom: 0.8 };
    graph.nodes[0].measured = { width: 212, height: 150 };
    graph.edges[0].style = { stroke: 'red' };
    const restored = parseGraph(serializeGraph(graph));
    expect(restored.viewport).toEqual(graph.viewport);
    expect(restored.nodes.some((node) => node.selected)).toBe(false);
    expect(restored.nodes[0].measured).toBeUndefined();
    expect(restored.edges[0].style).toBeUndefined();
    expect(toDocument(restored)).toEqual(toDocument(graph));
  });
  it('rejects incompatible formats and duplicate IDs', () => {
    expect(() => parseGraph(JSON.stringify({ routing: { rules: [] } }))).toThrow(
      /supported Wayrill/,
    );
    const raw = toDocument(createRoutingExample());
    raw.nodes[1].id = raw.nodes[0].id;
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/duplicate node/);
  });
});
