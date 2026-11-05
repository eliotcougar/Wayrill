import { beforeAll, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { initializeEdgeRouter } from '../graph/libavoid';
import { routeEdgePaths } from '../graph/edgePaths';
import type { RoutingGeometry } from '../graph/edgeRoutingClient';
import sample from './fixtures/fanout.json';

beforeAll(async () => {
  await initializeEdgeRouter();
});
const geometry = sample as RoutingGeometry;
it('draws separate Users output points without hiding unrelated traffic connections', () => {
  const paths = routeEdgePaths(geometry.edges, geometry.nodes);
  expect(paths.size).toBe(5);
  expect([...paths].filter(([, route]) => route.blocked).map(([id]) => id)).toEqual([]);
  expect([...paths.values()].every((route) => !!route.path)).toBe(true);
});
it('draws two user sets connected to both inbounds, with distinct source points and shared target trunks', () => {
  const edges = [
    ...geometry.edges,
    ...[0, 1].map((index) => ({
      id: `second-users-${index}`,
      source: 'user-set:second',
      sourceHandle: `users-${index}`,
      sourceX: -89,
      sourceY: -356.5 + index * 29,
      sourcePosition: Position.Right,
      target: `native-in-${index}`,
      targetHandle: 'users',
      targetX: 11,
      targetY: 81 + index * 240,
      targetPosition: Position.Left,
    })),
  ];
  const nodes = [
    ...geometry.nodes,
    { id: 'user-set:second', x: -370, y: -500, width: 272, height: 225 },
  ];
  const paths = routeEdgePaths(edges, nodes);
  expect(paths.size).toBe(7);
  expect([...paths].filter(([, route]) => route.blocked).map(([id]) => id)).toEqual([]);
});
