import { Position, type InternalNode } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { edgeGeometry, routingGeometry } from './useEdgeRouting';

function node(id: string, x: number, y: number): InternalNode {
  const userNode = { id, position: { x, y }, data: {} };
  return {
    ...userNode,
    measured: { width: 200, height: 150 },
    internals: {
      positionAbsolute: { x, y },
      z: 0,
      userNode,
      handleBounds: {
        source: [
          {
            id: 'data',
            type: 'source',
            nodeId: id,
            position: Position.Right,
            x: 194,
            y: 30,
            width: 12,
            height: 12,
          },
        ],
        target: [
          {
            id: 'in',
            type: 'target',
            nodeId: id,
            position: Position.Left,
            x: -6,
            y: 69,
            width: 12,
            height: 12,
          },
        ],
      },
    },
  };
}

describe('measured edge geometry', () => {
  it('uses the actual handles and absolute node positions, including moves and port changes', () => {
    const source = node('source', 100, 200),
      target = node('target', 500, 600);
    const state = {
      edges: [
        {
          id: 'wire',
          source: 'source',
          sourceHandle: 'data',
          target: 'target',
          targetHandle: 'in',
        },
      ],
      nodeLookup: new Map([
        [source.id, source],
        [target.id, target],
      ]),
    };
    expect(edgeGeometry(state)).toEqual([
      {
        id: 'wire',
        source: 'source',
        target: 'target',
        sourceHandle: 'data',
        targetHandle: 'in',
        sourceX: 306,
        sourceY: 236,
        targetX: 494,
        targetY: 675,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      },
    ]);
    source.internals.positionAbsolute.x += 16;
    source.internals.handleBounds!.source![0].y += 27;
    expect(edgeGeometry(state)[0]).toMatchObject({ sourceX: 322, sourceY: 263 });
  });

  it('omits hidden, dangling and not-yet-measured connections', () => {
    const source = node('source', 0, 0),
      target = node('target', 500, 0);
    const state = {
      edges: [
        { id: 'hidden', source: 'source', target: 'target', hidden: true },
        { id: 'missing-node', source: 'missing', target: 'target' },
        { id: 'missing-port', source: 'source', sourceHandle: 'unknown', target: 'target' },
      ],
      nodeLookup: new Map([
        [source.id, source],
        [target.id, target],
      ]),
    };
    expect(edgeGeometry(state)).toEqual([]);
    state.edges = [{ id: 'unmeasured', source: 'source', target: 'target' }];
    source.internals.handleBounds = undefined;
    expect(edgeGeometry(state)).toEqual([]);
  });

  it('tracks unconnected obstacles, resizing and visibility independently of the links', () => {
    const obstacle = node('obstacle', 100, 200);
    const state = { edges: [], nodeLookup: new Map([[obstacle.id, obstacle]]) };
    expect(routingGeometry(state)).toEqual({
      edges: [],
      nodes: [{ id: 'obstacle', x: 100, y: 200, width: 200, height: 150 }],
    });
    obstacle.internals.positionAbsolute.x = 250;
    obstacle.measured.height = 300;
    expect(routingGeometry(state).nodes[0]).toMatchObject({ x: 250, height: 300 });
    obstacle.hidden = true;
    expect(routingGeometry(state).nodes).toEqual([]);
  });
});
