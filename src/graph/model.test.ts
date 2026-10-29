import { describe, expect, it } from 'vitest';
import { createRoutingExample } from './example';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import { connectionProblem, parseGraph, serializeGraph, toDocument } from './model';

describe('graph connections', () => {
  it('keeps each filter branch an unambiguous single path', () => {
    const graph = createRoutingExample();
    expect(
      connectionProblem(graph, {
        source: 'routes',
        target: 'direct',
        sourceHandle: 'preferred',
        targetHandle: 'in',
      }),
    ).toMatch(/already has a path/);
    graph.edges = graph.edges.filter((edge) => edge.sourceHandle !== 'preferred');
    expect(
      connectionProblem(graph, {
        source: 'routes',
        target: 'direct',
        sourceHandle: 'preferred',
        targetHandle: 'in',
      }),
    ).toBeNull();
  });
});

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

describe('editing and diagnostics', () => {
  it('restores removed nodes and their connections with undo, then reapplies redo', () => {
    const original = createRoutingExample();
    const edited = {
      ...original,
      nodes: original.nodes.filter((node) => node.id !== 'routes'),
      edges: original.edges.filter((edge) => edge.source !== 'routes' && edge.target !== 'routes'),
    };
    const history = commitWorkspaceHistory(initialWorkspaceHistory(original), { graph: edited });
    const undone = undoWorkspaceHistory(history);
    expect(undone.present.graph).toEqual(original);
    expect(redoWorkspaceHistory(undone).present.graph).toEqual(edited);
  });
});
