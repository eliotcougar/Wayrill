import { Position } from '@xyflow/react';
import { expect, it } from 'vitest';
import { previewEdgePaths } from './edgeRoutePreview';
import type { RoutingGeometry } from './edgeRoutingClient';
import type { EdgePath } from './edgePaths';
const from: RoutingGeometry = {
  nodes: [],
  edges: [
    {
      id: 'wire',
      source: 'a',
      target: 'b',
      sourceX: 200,
      sourceY: 40,
      targetX: 500,
      targetY: 160,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    },
  ],
};
const route: EdgePath = {
  path: 'M200 40L350 40L350 160L500 160',
  points: [
    { x: 200, y: 40 },
    { x: 350, y: 40 },
    { x: 350, y: 160 },
    { x: 500, y: 160 },
  ],
  labelX: 350,
  labelY: 100,
  junctions: [],
  sharedWires: [],
};
const paths = new Map([['wire', route]]);
it('retains completed routes and keeps both endpoints attached throughout varied live movement', () => {
  for (let i = 0; i < 60; i++) {
    const edge = {
      ...from.edges[0],
      sourceX: 200 + i * 16,
      sourceY: 40 - i * 16,
      targetX: 500 - i * 8,
      targetY: 160 + i * 8,
    };
    const preview = previewEdgePaths(paths, from, { nodes: [], edges: [edge] }).get('wire')!;
    expect(preview.path).not.toBe('');
    expect(preview.points[0]).toEqual({ x: edge.sourceX, y: edge.sourceY });
    expect(preview.points.at(-1)).toEqual({ x: edge.targetX, y: edge.targetY });
    expect(preview.points[1].x).toBeGreaterThan(edge.sourceX);
    expect(preview.points.at(-2)!.x).toBeLessThan(edge.targetX);
    for (let j = 1; j < preview.points.length; j++)
      expect(
        preview.points[j].x === preview.points[j - 1].x ||
          preview.points[j].y === preview.points[j - 1].y,
      ).toBe(true);
  }
  expect(route.points[0]).toEqual({ x: 200, y: 40 });
});
it('does not resurrect deleted links, show a new link before routing, or reuse a replaced endpoint', () => {
  expect(previewEdgePaths(paths, from, { edges: [], nodes: [] }).size).toBe(0);
  expect(
    previewEdgePaths(paths, from, { edges: [{ ...from.edges[0], target: 'c' }], nodes: [] }).size,
  ).toBe(0);
  expect(previewEdgePaths(paths, null, from).size).toBe(0);
  expect(
    previewEdgePaths(new Map([['wire', { ...route, blocked: true, path: '' }]]), from, {
      ...from,
    }).get('wire')!.blocked,
  ).toBe(true);
});
it('keeps all port-direction combinations orthogonal, attached and free of retraced segments', () => {
  const sides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
  for (const sourcePosition of sides)
    for (const targetPosition of sides) {
      const base = { ...from.edges[0], sourcePosition, targetPosition };
      for (let step = 0; step < 24; step++) {
        const e = {
          ...base,
          sourceX: 200 + step * 32,
          sourceY: 40 - step * 16,
          targetX: 500 - step * 16,
          targetY: 160 + step * 32,
        };
        const p = previewEdgePaths(paths, from, { nodes: [], edges: [e] }).get('wire')!.points;
        expect(p[0]).toEqual({ x: e.sourceX, y: e.sourceY });
        expect(p.at(-1)).toEqual({ x: e.targetX, y: e.targetY });
        for (const [end, next, side] of [
          [p[0], p[1], sourcePosition],
          [p.at(-1)!, p.at(-2)!, targetPosition],
        ] as const) {
          if (side === Position.Right) expect(next.x).toBeGreaterThan(end.x);
          if (side === Position.Left) expect(next.x).toBeLessThan(end.x);
          if (side === Position.Bottom) expect(next.y).toBeGreaterThan(end.y);
          if (side === Position.Top) expect(next.y).toBeLessThan(end.y);
        }
        for (let i = 1; i < p.length; i++) {
          const a = p[i - 1],
            b = p[i],
            c = p[i + 1];
          expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
          expect(a.x === b.x || a.y === b.y).toBe(true);
          if (c && a.x === b.x && b.x === c.x)
            expect((b.y - a.y) * (c.y - b.y)).toBeGreaterThanOrEqual(0);
          if (c && a.y === b.y && b.y === c.y)
            expect((b.x - a.x) * (c.x - b.x)).toBeGreaterThanOrEqual(0);
        }
      }
    }
});
