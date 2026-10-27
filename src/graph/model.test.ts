import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { createRoutingExample } from './example';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  redoWorkspaceHistory,
  undoWorkspaceHistory,
} from './workspaceHistory';
import {
  connectionProblem,
  diagnoseGraph,
  parseGraph,
  serializeGraph,
  toDocument,
  updateGraphNode,
} from './model';
import type { GraphState } from './types';

it.each(['tun-inbound', 'ics-tun'] as const)(
  'keeps %s names tied to the adapter across editing and graph round trips',
  (kind) => {
    const node = makeNode(kind, { x: 0, y: 0 }, 'capture');
    const raw = {
      Protocol: 'tun',
      Settings: { Name: 'Office capture', mtu: 1420, gateway: ['10.91.0.1/32'] },
    };
    node.data.settings.json = JSON.stringify(raw);
    node.data.label = 'Obsolete separate label';
    const graph: GraphState = { name: 'Capture names', nodes: [node], edges: [] };
    const loaded = parseGraph(serializeGraph(graph));
    expect(loaded.nodes[0].data.label).toBe('Office capture');
    const renamed = updateGraphNode(loaded, node.id, { label: 'Work capture' });
    expect(renamed.nodes[0].data.label).toBe('Work capture');
    expect(JSON.parse(String(renamed.nodes[0].data.settings.json))).toEqual({
      ...raw,
      Settings: { ...raw.Settings, Name: 'Work capture' },
    });
    expect(renamed.nodes[0].data.settings.tag).toBe(node.data.settings.tag);
    expect(parseGraph(serializeGraph(renamed)).nodes[0].data.label).toBe('Work capture');
    expect(JSON.parse(String(node.data.settings.json))).toEqual(raw);
  },
);

describe('graph connections', () => {
  it('allows separate inputs to merge into a condition', () => {
    const graph = createRoutingExample();
    graph.edges = graph.edges.filter((edge) => edge.source !== 'socks');
    expect(
      connectionProblem(graph, {
        source: 'socks',
        target: 'routes',
        sourceHandle: 'data',
        targetHandle: 'in',
      }),
    ).toBeNull();
  });
  it('rejects self-connections and connections into sources', () => {
    const graph = createRoutingExample();
    expect(
      connectionProblem(graph, {
        source: 'routes',
        target: 'routes',
        sourceHandle: 'preferred',
        targetHandle: 'in',
      }),
    ).toMatch(/itself/);
    expect(
      connectionProblem(graph, {
        source: 'routes',
        target: 'socks',
        sourceHandle: 'preferred',
        targetHandle: 'in',
      }),
    ).toMatch(/input port/);
  });
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
  it('rejects a cycle spanning several filters and rules', () => {
    const graph: GraphState = {
      name: 'Loop check',
      nodes: [
        makeNode('routing-filter', { x: 0, y: 0 }, 'a'),
        makeNode('routing-filter', { x: 300, y: 0 }, 'b'),
        makeNode('routing-filter', { x: 600, y: 0 }, 'c'),
      ],
      edges: [
        { id: 'a-b', source: 'a', target: 'b', sourceHandle: 'preferred', targetHandle: 'in' },
        { id: 'b-c', source: 'b', target: 'c', sourceHandle: 'preferred', targetHandle: 'in' },
      ],
    };
    expect(
      connectionProblem(graph, {
        source: 'c',
        target: 'a',
        sourceHandle: 'default',
        targetHandle: 'in',
      }),
    ).toMatch(/routing loop/);
  });
  it('rejects missing nodes and nonexistent port names', () => {
    const graph = createRoutingExample();
    expect(
      connectionProblem(graph, {
        source: 'missing',
        target: 'direct',
        sourceHandle: 'traffic',
        targetHandle: 'in',
      }),
    ).toMatch(/missing node/);
    expect(
      connectionProblem(graph, {
        source: 'preferred',
        target: 'direct',
        sourceHandle: 'traffic',
        targetHandle: 'in',
      }),
    ).toMatch(/no matching output/);
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
  it('rejects unregistered node types', () => {
    const raw = JSON.parse(serializeGraph(createRoutingExample()));
    raw.nodes[0].data.kind = 'unregistered-node';
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/Invalid or duplicate node/);
  });
  it('rejects dangling connections and out-of-range settings', () => {
    const raw = toDocument(createRoutingExample());
    raw.edges[0].target = 'missing';
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/missing node/);
    const other = toDocument(createRoutingExample());
    other.nodes.find((node) => node.data.kind === 'vless-outbound')!.data.settings.port = 70000;
    expect(() => parseGraph(JSON.stringify(other))).toThrow(/port/i);
  });
  it('does not accept non-finite positions or malformed JSON', () => {
    const raw = toDocument(createRoutingExample());
    raw.nodes[0].position.x = Infinity;
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/position/);
    expect(() => parseGraph('{')).toThrow(/valid JSON/);
  });
  it('rejects cycles contained in imported files', () => {
    const raw = toDocument(createRoutingExample());
    raw.nodes.push(
      makeNode('routing-filter', { x: 50, y: 50 }, 'a'),
      makeNode('routing-filter', { x: 350, y: 50 }, 'b'),
    );
    raw.edges.push(
      { id: 'a-b', source: 'a', target: 'b', sourceHandle: 'preferred', targetHandle: 'in' },
      { id: 'b-a', source: 'b', target: 'a', sourceHandle: 'preferred', targetHandle: 'in' },
    );
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/routing loop/);
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
  it('does not record selection-only changes and discards redo after a new edit', () => {
    const graph = createRoutingExample();
    const selected = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, selected: true })) };
    expect(
      commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: selected }).past,
    ).toHaveLength(0);
    const history = commitWorkspaceHistory(initialWorkspaceHistory(graph), {
      graph: { ...graph, name: 'One' },
    });
    const next = commitWorkspaceHistory(undoWorkspaceHistory(history), {
      graph: { ...graph, name: 'Two' },
    });
    expect(next.future).toHaveLength(0);
  });
  it('reports incomplete paths without inventing runtime validation', () => {
    const graph = createRoutingExample();
    expect(diagnoseGraph(graph)).toEqual([]);
    graph.edges = graph.edges.filter((edge) => edge.sourceHandle !== 'default');
    expect(diagnoseGraph(graph).some((issue) => issue.message.includes('Default'))).toBe(true);
    expect(diagnoseGraph({ name: 'Empty', nodes: [], edges: [] })).toHaveLength(1);
  });
});
