import { Position } from '@xyflow/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { routeEdgePaths, type EdgePath, type NodeBounds, type Point } from './edgePaths';
import type { EdgeGeometry } from './edgeGeometry';
import { edgeRouterBindings, initializeEdgeRouter } from './libavoid';
import verificationFixture from './fixtures/schematic-verification.json';

beforeAll(() => initializeEdgeRouter());
const edge = (id: string, changes: Partial<EdgeGeometry> = {}): EdgeGeometry => ({
  id,
  source: `source-${id}`,
  target: `target-${id}`,
  sourceX: 0,
  sourceY: 0,
  targetX: 300,
  targetY: 300,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  ...changes,
});
const obstacle: NodeBounds = {
  id: 'obstacle',
  x: 100,
  y: 70,
  width: 100,
  height: 160,
};
const EPS = 0.0001;
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < EPS;
const on = (p: Point, a: Point, b: Point) =>
  ((Math.abs(a.x - b.x) < EPS && Math.abs(p.x - a.x) < EPS) ||
    (Math.abs(a.y - b.y) < EPS && Math.abs(p.y - a.y) < EPS)) &&
  p.x >= Math.min(a.x, b.x) - EPS &&
  p.x <= Math.max(a.x, b.x) + EPS &&
  p.y >= Math.min(a.y, b.y) - EPS &&
  p.y <= Math.max(a.y, b.y) + EPS;

function assertClear(route: EdgePath, nodes: readonly NodeBounds[]) {
  expect(route.blocked).not.toBe(true);
  expect(route.path).not.toMatch(/NaN|Infinity|Q|C/);
  const points = [...route.path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    x: +m[1],
    y: +m[2],
  }));
  expect(points).toEqual(route.points);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    expect(a.x === b.x || a.y === b.y, 'Non-orthogonal segment').toBe(true);
    for (const n of nodes) {
      const hit =
        a.x === b.x
          ? a.x > n.x + EPS &&
            a.x < n.x + n.width - EPS &&
            Math.max(a.y, b.y) > n.y + EPS &&
            Math.min(a.y, b.y) < n.y + n.height - EPS
          : a.y > n.y + EPS &&
            a.y < n.y + n.height - EPS &&
            Math.max(a.x, b.x) > n.x + EPS &&
            Math.min(a.x, b.x) < n.x + n.width - EPS;
      expect(hit, `Route enters ${n.id}: ${JSON.stringify([a, b])}`).toBe(false);
    }
  }
}
function suffix(points: Point[], p: Point) {
  const i = points.findIndex((b, k) => k > 0 && on(p, points[k - 1], b));
  if (i < 0) return [];
  const result = [p, ...points.slice(i).filter((q) => !same(p, q))];
  return result.filter(
    (q, k) => k === 0 || k === result.length - 1 || !on(q, result[k - 1], result[k + 1]),
  );
}
function assertSchematic(
  edges: readonly EdgeGeometry[],
  routes: ReadonlyMap<string, EdgePath>,
  nodes: readonly NodeBounds[] = [],
) {
  for (const e of edges) {
    const r = routes.get(e.id)!;
    assertClear(r, nodes);
    expect(r.points[0]).toEqual({ x: e.sourceX, y: e.sourceY });
    expect(r.points.at(-1)).toEqual({ x: e.targetX, y: e.targetY });
    for (const dot of r.junctions)
      for (const other of edges) {
        if (e.target === other.target && e.targetHandle === other.targetHandle) continue;
        const points = routes.get(other.id)!.points;
        expect(
          points.some((p, i) => i > 0 && on(dot, points[i - 1], p)),
          `Unrelated ${other.id} touches junction of ${e.id}`,
        ).toBe(false);
      }
  }
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i],
        f = edges[j],
        a = routes.get(e.id)!.points,
        b = routes.get(f.id)!.points;
      for (let u = 1; u < a.length; u++)
        for (let v = 1; v < b.length; v++) {
          const x = a[u - 1],
            y = a[u],
            z = b[v - 1],
            w = b[v];
          const vertical = x.x === y.x && z.x === w.x && Math.abs(x.x - z.x) < EPS;
          const horizontal = x.y === y.y && z.y === w.y && Math.abs(x.y - z.y) < EPS;
          if (!vertical && !horizontal) continue;
          const start = Math.max(
            vertical ? Math.min(x.y, y.y) : Math.min(x.x, y.x),
            vertical ? Math.min(z.y, w.y) : Math.min(z.x, w.x),
          );
          const end = Math.min(
            vertical ? Math.max(x.y, y.y) : Math.max(x.x, y.x),
            vertical ? Math.max(z.y, w.y) : Math.max(z.x, w.x),
          );
          if (end - start <= EPS) continue;
          const p = vertical ? { x: x.x, y: (start + end) / 2 } : { x: (start + end) / 2, y: x.y };
          expect(
            e.target === f.target && e.targetHandle === f.targetHandle,
            `Accidental shared segment ${e.id}/${f.id} at ${JSON.stringify(p)} routes ${JSON.stringify([a, b])}`,
          ).toBe(true);
          expect(suffix(a, p), `Merge splits again: ${e.id}/${f.id}`).toEqual(suffix(b, p));
        }
    }
}

describe('schematic routing', () => {
  it('routes the measured 12-node verification graph with every connection role', () => {
    const edges = verificationFixture.edges as EdgeGeometry[];
    const nodes = verificationFixture.nodes;
    const routes = routeEdgePaths(edges, nodes);
    assertSchematic(edges, routes, nodes);
    expect(
      [...routes.values()]
        .flatMap((route) => route.sharedWires)
        .some((wire) => wire.kinds.length === 2),
    ).toBe(true);
  });
  it('marks real merges into the same input, while orthogonal crossings have no dots', () => {
    const edges = [
      edge('a', { target: 'shared', targetHandle: 'in' }),
      edge('b', { sourceY: 100, target: 'shared', targetHandle: 'in' }),
    ];
    const routes = routeEdgePaths(edges, [obstacle]);
    assertSchematic(edges, routes, [obstacle]);
    const dots = [...routes.values()].flatMap((r) => r.junctions);
    expect(dots.length).toBeGreaterThan(0);
    for (const p of dots)
      for (const r of routes.values())
        expect(r.points.some((b, i) => i > 0 && on(p, r.points[i - 1], b))).toBe(true);
    const separate = [edge('a'), edge('b', { sourceY: 100, targetY: 200 })];
    expect([...routeEdgePaths(separate, []).values()].flatMap((r) => r.junctions)).toEqual([]);
  });
  it('reports an impossible attachment instead of drawing a wire behind a covering node', () => {
    const e = edge('covered');
    const r = routeEdgePaths(
      [e],
      [{ id: 'covering', x: -10, y: -10, width: 100, height: 100 }],
    ).get(e.id)!;
    expect(r.blocked).toBe(true);
    expect(r.path).toBe('');
  });
  it('handles dense fan-in with shared terminal suffixes only', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      x: 0,
      y: i * 120,
      width: 160,
      height: 90,
    }));
    nodes.push(
      { id: 'target', x: 700, y: 300, width: 160, height: 300 },
      { id: 'obstacle', x: 350, y: 200, width: 150, height: 400 },
    );
    const edges = nodes.slice(0, 8).map((n, i) =>
      edge(`e${i}`, {
        source: n.id,
        sourceHandle: 'out',
        target: 'target',
        targetHandle: 'in',
        sourceX: 165,
        sourceY: n.y + 45,
        targetX: 695,
        targetY: 450,
      }),
    );
    assertSchematic(edges, routeEdgePaths(edges, nodes), nodes);
  });
  it('releases native and borrowed wrapper allocations after repeated edits', () => {
    const A = edgeRouterBindings();
    const constructors = [
      A.Router,
      A.ShapeRef,
      A.ConnRef,
      A.ShapeConnectionPin,
      A.Point,
      A.Rectangle,
    ];
    const counts = () => constructors.map((c) => Object.keys(A.getCache(c)).length);
    routeEdgePaths([edge('warm')], [obstacle]);
    const before = counts();
    for (let i = 0; i < 30; i++)
      routeEdgePaths([edge('move', { sourceY: i * 7 })], [{ ...obstacle, x: 100 + i }]);
    expect(counts()).toEqual(before);
  });
});
