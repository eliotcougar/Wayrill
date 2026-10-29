import { describe, expect, it } from 'vitest';
import { makeNode } from './catalog';
import { createVerificationExample } from './example';
import { applyConnectionEdit, connectionEditProblem } from './connectionEditing';
import type { GraphState } from './types';

const link = (source: string, sourceHandle: string, target: string) => ({
  source,
  sourceHandle,
  target,
  targetHandle: 'in',
});

describe('connection edits', () => {
  it('replaces endpoints atomically, preserves identity and metadata, and selects the edited wire', () => {
    const graph = createVerificationExample(),
      old = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
    old.data = { marker: 'keep' };
    const next = applyConnectionEdit(
      graph,
      link('socks', 'data', 'block'),
      'ignored-new-id',
      old.id,
    );
    expect(next.edges).toHaveLength(graph.edges.length);
    expect(next.edges.find((e) => e.id === old.id)).toMatchObject({
      ...link('socks', 'data', 'block'),
      data: { marker: 'keep' },
      selected: true,
    });
    expect(next.nodes.some((n) => n.selected)).toBe(false);
    expect(next.edges.filter((e) => e.selected)).toHaveLength(1);
    expect(graph.edges.find((e) => e.id === old.id)?.target).toBe('routes');
  });
  it('guards stale edges, removed nodes and dynamic output ports', () => {
    const graph = createVerificationExample(),
      old = graph.edges.find((e) => e.source === 'routes')!;
    expect(connectionEditProblem(graph, link('socks', 'data', 'block'), 'deleted-edge')).toContain(
      'no longer exists',
    );
    expect(
      connectionEditProblem(graph, link('routes', 'deleted-output', 'block'), old.id),
    ).toContain('output port');
    expect(
      connectionEditProblem(graph, link('routes', old.sourceHandle!, 'deleted-node'), old.id),
    ).toContain('missing node');
    expect(
      applyConnectionEdit(graph, link('routes', 'deleted-output', 'block'), old.id, old.id),
    ).toBe(graph);
  });
  it('rejects cycles introduced by reconnecting either endpoint', () => {
    const a = makeNode('routing-filter', { x: 0, y: 0 }, 'a'),
      b = makeNode('routing-filter', { x: 1, y: 0 }, 'b'),
      c = makeNode('direct-outbound', { x: 2, y: 0 }, 'c');
    const aPort = JSON.parse(String(a.data.settings.outputs))[0].id,
      bPort = JSON.parse(String(b.data.settings.outputs))[0].id;
    const graph: GraphState = {
      name: 'cycle fixture',
      nodes: [a, b, c],
      edges: [
        { id: 'ab', ...link('a', aPort, 'b') },
        { id: 'bc', ...link('b', bPort, 'c') },
      ],
    };
    expect(connectionEditProblem(graph, link('b', bPort, 'a'), 'bc')).toContain('routing loop');
    expect(applyConnectionEdit(graph, link('b', bPort, 'a'), 'bc', 'bc')).toBe(graph);
  });
});
