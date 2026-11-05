import { Position } from '@xyflow/react';
import type { EdgeGeometry } from './edgeGeometry';
import type { EdgePath, NodeBounds, Point } from './edgePaths';
import type { RoutingGeometry } from './edgeRoutingClient';

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const length = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const horizontal = (side: Position) => side === Position.Left || side === Position.Right;
const sign = (side: Position) => (side === Position.Left || side === Position.Top ? -1 : 1);
const axis = (side: Position) => (horizontal(side) ? 'x' : 'y');
const crossAxis = (side: Position) => (horizontal(side) ? 'y' : 'x');
const pathText = (points: Point[]) =>
  points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('');
function compact(points: Point[]) {
  const result: Point[] = [];
  for (const p of points) {
    if (result.length && samePoint(p, result[result.length - 1])) continue;
    const a = result[result.length - 2],
      b = result[result.length - 1];
    if (
      a &&
      ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) &&
      length(a, p) === length(a, b) + length(b, p)
    )
      result.pop();
    result.push(p);
  }
  return result;
}
function valid(points: Point[], edge: EdgeGeometry) {
  if (points.length < 2 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    return false;
  const outward = (end: Point, next: Point, side: Position) =>
    end[crossAxis(side)] === next[crossAxis(side)] &&
    sign(side) * (next[axis(side)] - end[axis(side)]) > 0;
  if (
    !outward(points[0], points[1], edge.sourcePosition) ||
    !outward(points.at(-1)!, points.at(-2)!, edge.targetPosition)
  )
    return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    if (a.x !== b.x && a.y !== b.y) return false;
    if (
      c &&
      ((a.x === b.x && b.x === c.x && (b.y - a.y) * (c.y - b.y) < 0) ||
        (a.y === b.y && b.y === c.y && (b.x - a.x) * (c.x - b.x) < 0))
    )
      return false;
  }
  return true;
}
function enters(points: Point[], node: NodeBounds) {
  return points.slice(1).some((b, i) => {
    const a = points[i];
    return a.x === b.x
      ? a.x > node.x &&
          a.x < node.x + node.width &&
          Math.min(a.y, b.y) < node.y + node.height &&
          Math.max(a.y, b.y) > node.y
      : a.y > node.y &&
          a.y < node.y + node.height &&
          Math.min(a.x, b.x) < node.x + node.width &&
          Math.max(a.x, b.x) > node.x;
  });
}
function retarget(route: EdgePath, edge: EdgeGeometry, nodes: readonly NodeBounds[]): Point[] {
  const source = { x: edge.sourceX, y: edge.sourceY },
    target = { x: edge.targetX, y: edge.targetY };
  const ends = nodes.filter((n) => n.id === edge.source || n.id === edge.target);
  const points = route.points.map((p) => ({ ...p }));
  points[0] = source;
  points[points.length - 1] = target;
  if (points.length >= 3) {
    // Move the adjacent bends, rather than splicing back through the old corners.
    points[1][crossAxis(edge.sourcePosition)] = source[crossAxis(edge.sourcePosition)];
    points[points.length - 2][crossAxis(edge.targetPosition)] =
      target[crossAxis(edge.targetPosition)];
    const projected = compact(points);
    if (valid(projected, edge) && ends.every((n) => !enters(projected, n))) return projected;
  }
  // Short links or a node crossing its old bend need a new local elbow/detour.
  // The worker replaces this small display-only route with the obstacle solution.
  const stub = (end: Point, side: Position) => ({
    ...end,
    [axis(side)]: end[axis(side)] + sign(side) * 16,
  });
  const a = stub(source, edge.sourcePosition),
    b = stub(target, edge.targetPosition);
  const candidates: Point[][] = [
    [source, a, { x: b.x, y: a.y }, b, target],
    [source, a, { x: a.x, y: b.y }, b, target],
  ];
  const xs = [source.x, target.x, ...ends.flatMap((n) => [n.x, n.x + n.width])];
  const ys = [source.y, target.y, ...ends.flatMap((n) => [n.y, n.y + n.height])];
  for (const x of [(source.x + target.x) / 2, Math.min(...xs) - 16, Math.max(...xs) + 16])
    candidates.push([source, a, { x, y: a.y }, { x, y: b.y }, b, target]);
  for (const y of [(source.y + target.y) / 2, Math.min(...ys) - 16, Math.max(...ys) + 16])
    candidates.push([source, a, { x: a.x, y }, { x: b.x, y }, b, target]);
  const simple = candidates.map(compact).filter((p) => valid(p, edge));
  const clear = simple.filter((p) => ends.every((n) => !enters(p, n)));
  return (
    (clear.length ? clear : simple).sort(
      (a, b) =>
        a.slice(1).reduce((sum, p, i) => sum + length(a[i], p), 0) -
        b.slice(1).reduce((sum, p, i) => sum + length(b[i], p), 0),
    )[0] ?? points
  );
}
function labelOn(points: Point[], label: Point) {
  let closest = points[0],
    best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const p = {
      x: Math.max(Math.min(a.x, b.x), Math.min(label.x, Math.max(a.x, b.x))),
      y: Math.max(Math.min(a.y, b.y), Math.min(label.y, Math.max(a.y, b.y))),
    };
    const distance = length(p, label);
    if (distance < best) {
      closest = p;
      best = distance;
    }
  }
  return closest;
}
const translatedPath = (path: string, dx: number, dy: number) =>
  path.replace(
    /([ML])([+\-\d.eE]+) ([+\-\d.eE]+)/g,
    (_, command: string, x: string, y: string) => `${command}${Number(x) + dx} ${Number(y) + dy}`,
  );

/** Immediate endpoint projection while the bounded worker computes the obstacle layout. */
export function previewEdgePaths(
  paths: ReadonlyMap<string, EdgePath>,
  from: RoutingGeometry | null,
  to: RoutingGeometry,
): ReadonlyMap<string, EdgePath> {
  if (from === to) return paths;
  const previous = new Map(from?.edges.map((e) => [e.id, e]));
  const result = new Map<string, EdgePath>();
  for (const edge of to.edges) {
    const old = previous.get(edge.id),
      route = paths.get(edge.id);
    if (
      !old ||
      !route ||
      old.source !== edge.source ||
      old.target !== edge.target ||
      old.sourceHandle !== edge.sourceHandle ||
      old.targetHandle !== edge.targetHandle
    )
      continue;
    if (route.blocked || route.points.length < 2) {
      result.set(edge.id, route);
      continue;
    }
    const dx = edge.sourceX - old.sourceX,
      dy = edge.sourceY - old.sourceY;
    if (
      dx === edge.targetX - old.targetX &&
      dy === edge.targetY - old.targetY &&
      edge.sourcePosition === old.sourcePosition &&
      edge.targetPosition === old.targetPosition
    ) {
      result.set(
        edge.id,
        dx === 0 && dy === 0
          ? route
          : {
              ...route,
              points: route.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
              path: translatedPath(route.path, dx, dy),
              labelX: route.labelX + dx,
              labelY: route.labelY + dy,
              junctions: route.junctions.map((p) => ({ x: p.x + dx, y: p.y + dy })),
              sharedWires: route.sharedWires.map((w) => ({
                ...w,
                path: translatedPath(w.path, dx, dy),
              })),
            },
      );
      continue;
    }
    const points = retarget(route, edge, to.nodes);
    const label = labelOn(points, { x: route.labelX, y: route.labelY });
    result.set(edge.id, {
      ...route,
      points,
      path: pathText(points),
      labelX: label.x,
      labelY: label.y,
      junctions: [],
      sharedWires: [],
    });
  }
  return result;
}
