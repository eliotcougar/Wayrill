import { Position } from '@xyflow/react';
import type { EdgeGeometry } from './edgeGeometry';
import { edgeRouterBindings } from './libavoid';
import { connectionTypes, type ConnectionKind } from './connectionKinds';

export type Point = { x: number; y: number };
export type NodeBounds = { id: string; x: number; y: number; width: number; height: number };
export type EdgePath = {
  path: string;
  labelX: number;
  labelY: number;
  points: Point[];
  junctions: Point[];
  sharedWires: { path: string; kinds: ConnectionKind[] }[];
  blocked?: boolean;
};
type Rect = { id: string; left: number; right: number; top: number; bottom: number };
const SPACING = 16;
const EPSILON = 0.00001;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const equal = (a: Point, b: Point) => distance(a, b) < EPSILON;
const directions = {
  [Position.Right]: 8,
  [Position.Left]: 4,
  [Position.Top]: 1,
  [Position.Bottom]: 2,
};
const clean = (value: number) => Math.round(value * 1e6) / 1e6;

function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    if (result.length && equal(result[result.length - 1], p)) continue;
    const a = result[result.length - 2],
      b = result[result.length - 1];
    if (
      a &&
      ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) &&
      Math.abs(distance(a, p) - distance(a, b) - distance(b, p)) < EPSILON
    )
      result.pop();
    result.push(p);
  }
  return result;
}

function intersects(a: Point, b: Point, r: Rect) {
  return a.x === b.x
    ? a.x > r.left + EPSILON &&
        a.x < r.right - EPSILON &&
        Math.min(a.y, b.y) < r.bottom - EPSILON &&
        Math.max(a.y, b.y) > r.top + EPSILON
    : a.y > r.top + EPSILON &&
        a.y < r.bottom - EPSILON &&
        Math.min(a.x, b.x) < r.right - EPSILON &&
        Math.max(a.x, b.x) > r.left + EPSILON;
}
const pathClear = (points: Point[], rects: Rect[]) =>
  points.length >= 2 &&
  points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
  points
    .slice(1)
    .every(
      (b, i) =>
        (points[i].x === b.x || points[i].y === b.y) &&
        rects.every((r) => !intersects(points[i], b, r)),
    );

function validRoute(points: Point[], e: EdgeGeometry, rects: Rect[]) {
  if (
    !pathClear(points, rects) ||
    !equal(points[0], { x: e.sourceX, y: e.sourceY }) ||
    !equal(points[points.length - 1], { x: e.targetX, y: e.targetY })
  )
    return false;
  const outward = (a: Point, b: Point, position: Position) =>
    position === Position.Right
      ? b.x > a.x && b.y === a.y
      : position === Position.Left
        ? b.x < a.x && b.y === a.y
        : position === Position.Top
          ? b.y < a.y && b.x === a.x
          : b.y > a.y && b.x === a.x;
  return (
    outward(points[0], points[1], e.sourcePosition) &&
    outward(points[points.length - 1], points[points.length - 2], e.targetPosition)
  );
}

function endpointKey(e: EdgeGeometry, type: 'source' | 'target') {
  return JSON.stringify([
    type,
    e[type] ?? e.id,
    e[`${type}Handle`] ?? '',
    e[`${type}X`],
    e[`${type}Y`],
    e[`${type}Position`],
  ]);
}

function solve(
  edges: readonly EdgeGeometry[],
  nodes: readonly NodeBounds[],
  padding: number,
  merge: boolean,
) {
  const A = edgeRouterBindings(),
    router = new A.Router(A.OrthogonalRouting);
  // libavoid owns shapes, pins, connectors and displayRoute polygons. Its WebIDL
  // wrapper cache does not know when the router frees them; retire the borrowed
  // wrappers without destroying their C++ objects a second time.
  const borrowed = new Set<Parameters<typeof A.getPointer>[0]>();
  const remember = <T extends Parameters<typeof A.getPointer>[0]>(value: T): T => {
    borrowed.add(value);
    return value;
  };
  const destroy = (value: Parameters<typeof A.destroy>[0]) => A.destroy(value);
  try {
    router.setRoutingParameter(A.segmentPenalty, 40);
    router.setRoutingParameter(A.idealNudgingDistance, SPACING);
    router.setRoutingParameter(A.shapeBufferDistance, padding);
    router.setRoutingOption(A.nudgeSharedPathsWithCommonEndPoint, !merge);
    router.setRoutingOption(A.nudgeOrthogonalTouchingColinearSegments, true);
    const bounds = new Map(
      nodes.map((n) => [
        n.id,
        { id: n.id, left: n.x, right: n.x + n.width, top: n.y, bottom: n.y + n.height },
      ]),
    );
    // Pins live on measured handle boundaries, which may protrude beyond cards.
    // Extend only the routing obstacle to include them, never move a real port.
    for (const e of edges)
      for (const type of ['source', 'target'] as const) {
        const r = bounds.get(e[type] ?? '');
        if (r) {
          r.left = Math.min(r.left, e[`${type}X`]);
          r.right = Math.max(r.right, e[`${type}X`]);
          r.top = Math.min(r.top, e[`${type}Y`]);
          r.bottom = Math.max(r.bottom, e[`${type}Y`]);
        }
      }
    type Shape = { rect: Rect; ref: InstanceType<typeof A.ShapeRef>; pins: Map<string, number> };
    const shapes = new Map<string, Shape>();
    const shape = (rect: Rect): Shape => {
      const p = new A.Point(rect.left, rect.top),
        q = new A.Point(rect.right, rect.bottom);
      const polygon = new A.Rectangle(p, q);
      const ref = remember(new A.ShapeRef(router, polygon));
      destroy(polygon);
      destroy(q);
      destroy(p);
      return { rect, ref, pins: new Map() };
    };
    for (const r of [...bounds.values()].sort((a, b) => a.id.localeCompare(b.id)))
      shapes.set(r.id, shape(r));
    const endpoint = (e: EdgeGeometry, type: 'source' | 'target') => {
      const key = endpointKey(e, type),
        x = e[`${type}X`],
        y = e[`${type}Y`],
        position = e[`${type}Position`];
      let s = shapes.get(e[type] ?? '');
      if (!s) {
        // Test/free endpoints still need direction-constrained pins. Tiny virtual
        // obstacles also distinguish distinct ports that happen to be aligned.
        s = shapes.get(key);
        if (!s) {
          const left = position === Position.Right ? x - 1 : x;
          const top = position === Position.Bottom ? y - 1 : y;
          s = shape({ id: key, left, right: left + 1, top, bottom: top + 1 });
          shapes.set(key, s);
        }
      }
      let pin = s.pins.get(key);
      if (pin === undefined) {
        pin = s.pins.size + 1;
        s.pins.set(key, pin);
        remember(
          new A.ShapeConnectionPin(
            s.ref,
            pin,
            x - s.rect.left,
            y - s.rect.top,
            false,
            0,
            directions[position],
          ),
        ).setExclusive(false);
      }
      return new A.ConnEnd(s.ref, pin);
    };
    const connectors = edges.map((e) => {
      const from = endpoint(e, 'source'),
        to = endpoint(e, 'target');
      const ref = remember(new A.ConnRef(router, from, to));
      destroy(to);
      destroy(from);
      return { e, ref };
    });
    router.processTransaction();
    return normalizeRoutes(
      new Map(
        connectors.map(({ e, ref }) => {
          const polygon = remember(ref.displayRoute());
          const count = polygon.size();
          if (!Number.isInteger(count) || count < 0 || count > 4096)
            throw new Error('Invalid route vertex count.');
          const points = simplify(
            Array.from({ length: count }, (_, i) => {
              const p = remember(polygon.get_ps(i));
              return { x: p.x, y: p.y };
            }),
          );
          return [e.id, points];
        }),
      ),
      edges,
    );
  } finally {
    destroy(router);
    for (const object of borrowed) delete A.getCache(A.getClass(object))[A.getPointer(object)];
  }
}

// The constraint solver uses epsilon offsets for coincident segments. Collapse
// only numerical noise globally; measured port coordinates remain exact.
function normalizeRoutes(routes: Map<string, Point[]>, edges: readonly EdgeGeometry[]) {
  for (const axis of ['x', 'y'] as const) {
    const ports = [
      ...new Set(
        edges.flatMap((e) => (axis === 'x' ? [e.sourceX, e.targetX] : [e.sourceY, e.targetY])),
      ),
    ];
    const values = [
      ...new Set([...routes.values()].flatMap((points) => points.map((p) => p[axis]))),
    ].sort((a, b) => a - b);
    const normalized = new Map<number, number>();
    let previous = -Infinity;
    for (const value of values) {
      const port = ports.includes(value) ? value : ports.find((p) => Math.abs(p - value) < EPSILON);
      const result = port ?? (Math.abs(previous - value) < EPSILON ? previous : clean(value));
      normalized.set(value, result);
      previous = result;
    }
    for (const points of routes.values())
      for (const p of points) p[axis] = normalized.get(p[axis])!;
  }
  for (const [id, points] of routes) routes.set(id, simplify(points));
  return routes;
}

// Walk backwards from a common input. Only a contiguous common suffix is a
// legitimate wire merge; an overlap followed by divergence is never a merge.
function sharedTail(a: Point[], b: Point[]): Point[] {
  let i = a.length - 1,
    j = b.length - 1;
  if (i < 1 || j < 1 || !equal(a[i], b[j])) return [];
  let p = a[i];
  const tail = [p];
  while (i > 0 && j > 0) {
    const u = a[i - 1],
      v = b[j - 1];
    const dx = Math.sign(u.x - p.x),
      dy = Math.sign(u.y - p.y);
    if (dx !== Math.sign(v.x - p.x) || dy !== Math.sign(v.y - p.y)) break;
    const length = Math.min(distance(p, u), distance(p, v));
    p = { x: clean(p.x + dx * length), y: clean(p.y + dy * length) };
    tail.push(p);
    if (equal(p, u)) i--;
    if (equal(p, v)) j--;
  }
  return simplify(tail.reverse());
}
function overlap(a: Point, b: Point, c: Point, d: Point) {
  if (a.x === b.x && c.x === d.x && a.x === c.x)
    return (
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
        Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) >
      EPSILON
    );
  if (a.y === b.y && c.y === d.y && a.y === c.y)
    return (
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
        Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) >
      EPSILON
    );
  return false;
}
function sameTarget(a: EdgeGeometry, b: EdgeGeometry) {
  return !!a.target && endpointKey(a, 'target') === endpointKey(b, 'target');
}
function conflictingRoutes(edges: readonly EdgeGeometry[], routes: Map<string, Point[]>) {
  const invalid = new Set<string>();
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const a = routes.get(edges[i].id) ?? [],
        b = routes.get(edges[j].id) ?? [];
      const tail = sameTarget(edges[i], edges[j]) ? sharedTail(a, b) : [];
      for (let u = 1; u < a.length; u++)
        for (let v = 1; v < b.length; v++)
          if (overlap(a[u - 1], a[u], b[v - 1], b[v])) {
            const from =
              a[u - 1].x === a[u].x
                ? {
                    x: a[u].x,
                    y: Math.max(Math.min(a[u - 1].y, a[u].y), Math.min(b[v - 1].y, b[v].y)),
                  }
                : {
                    x: Math.max(Math.min(a[u - 1].x, a[u].x), Math.min(b[v - 1].x, b[v].x)),
                    y: a[u].y,
                  };
            const to =
              a[u - 1].x === a[u].x
                ? {
                    x: a[u].x,
                    y: Math.min(Math.max(a[u - 1].y, a[u].y), Math.max(b[v - 1].y, b[v].y)),
                  }
                : {
                    x: Math.min(Math.max(a[u - 1].x, a[u].x), Math.max(b[v - 1].x, b[v].x)),
                    y: a[u].y,
                  };
            if (
              !tail
                .slice(1)
                .some(
                  (p, k) =>
                    Math.abs(
                      distance(tail[k], from) +
                        distance(from, to) +
                        distance(to, p) -
                        distance(tail[k], p),
                    ) < EPSILON ||
                    Math.abs(
                      distance(tail[k], to) +
                        distance(to, from) +
                        distance(from, p) -
                        distance(tail[k], p),
                    ) < EPSILON,
                )
            ) {
              invalid.add(edges[i].id);
              invalid.add(edges[j].id);
            }
          }
    }
  return invalid;
}
function midpoint(points: Point[]) {
  const lengths = points.slice(1).map((p, i) => distance(points[i], p));
  let remaining = lengths.reduce((sum, n) => sum + n, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const a = points[i],
        b = points[i + 1];
      return {
        x: a.x + Math.sign(b.x - a.x) * remaining,
        y: a.y + Math.sign(b.y - a.y) * remaining,
      };
    }
    remaining -= lengths[i];
  }
  return points[0];
}

// Different roles can enter one compatible input. Paint their common suffix as
// a striped bundle instead of allowing the last SVG stroke to hide other roles.
function bundleSharedWires(edges: readonly EdgeGeometry[], paths: Map<string, EdgePath>) {
  type Run = { start: number; end: number; kinds: ConnectionKind[]; owner: string };
  const lines = new Map<string, { vertical: boolean; coordinate: number; runs: Run[] }>();
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i],
        f = edges[j],
        a = paths.get(e.id)!,
        b = paths.get(f.id)!;
      if (!e.kind || !f.kind || e.kind === f.kind || a.blocked || b.blocked || !sameTarget(e, f))
        continue;
      const tail = sharedTail(a.points, b.points);
      for (let k = 1; k < tail.length; k++) {
        const p = tail[k - 1],
          q = tail[k],
          vertical = p.x === q.x,
          coordinate = vertical ? p.x : p.y;
        const key = JSON.stringify([endpointKey(e, 'target'), vertical, coordinate]);
        let line = lines.get(key);
        if (!line) {
          line = { vertical, coordinate, runs: [] };
          lines.set(key, line);
        }
        line.runs.push({
          start: vertical ? Math.min(p.y, q.y) : Math.min(p.x, q.x),
          end: vertical ? Math.max(p.y, q.y) : Math.max(p.x, q.x),
          kinds: [e.kind, f.kind],
          // Edges render in ID order. The final participant paints the bundle
          // after every solid base stroke that shares this suffix.
          owner: f.id,
        });
      }
    }
  for (const { vertical, coordinate, runs } of lines.values()) {
    const cuts = [...new Set(runs.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const start = cuts[i - 1],
        end = cuts[i],
        mid = (start + end) / 2;
      const covers = runs
        .filter((r) => r.start <= mid && r.end >= mid)
        .sort((a, b) => b.owner.localeCompare(a.owner));
      if (!covers.length) continue;
      const kinds = Object.keys(connectionTypes).filter((kind) =>
        covers.some((r) => r.kinds.includes(kind as ConnectionKind)),
      ) as ConnectionKind[];
      const p = vertical ? { x: coordinate, y: start } : { x: start, y: coordinate },
        q = vertical ? { x: coordinate, y: end } : { x: end, y: coordinate };
      paths.get(covers[0].owner)!.sharedWires.push({ path: `M${p.x} ${p.y}L${q.x} ${q.y}`, kinds });
    }
  }
}
function placeLabels(edges: readonly EdgeGeometry[], paths: Map<string, EdgePath>, rects: Rect[]) {
  const placed: { x: number; y: number; width: number }[] = [];
  for (const e of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const path = paths.get(e.id);
    if (!path || path.blocked || !e.label) continue;
    const width = Math.max(28, e.label.length * 8 + 14);
    const preferred = { x: path.labelX, y: path.labelY };
    const candidates = path.points
      .slice(1)
      .flatMap((b, i) => {
        const a = path.points[i],
          vertical = a.x === b.x;
        const margin = vertical ? 12 : width / 2 + 6;
        const low = Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x) + margin;
        const high = Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x) - margin;
        if (low > high) return [];
        const center = Math.max(low, Math.min(high, vertical ? preferred.y : preferred.x));
        return [0, -28, 28, -56, 56].map((shift) => {
          const value = Math.max(low, Math.min(high, center + shift));
          return vertical ? { x: a.x, y: value } : { x: value, y: a.y };
        });
      })
      .sort((a, b) => distance(a, preferred) - distance(b, preferred));
    let best = candidates[0] ?? preferred,
      bestScore = Infinity;
    for (const p of candidates) {
      const nodeCollisions = rects.filter(
        (r) =>
          p.x + width / 2 + 4 > r.left &&
          p.x - width / 2 - 4 < r.right &&
          p.y + 14 > r.top &&
          p.y - 14 < r.bottom,
      ).length;
      const labelCollisions = placed.filter(
        (other) =>
          Math.abs(p.x - other.x) < (width + other.width) / 2 + 6 && Math.abs(p.y - other.y) < 28,
      ).length;
      const score = nodeCollisions * 1000 + labelCollisions;
      if (score < bestScore) {
        best = p;
        bestScore = score;
      }
      if (score === 0) break;
    }
    paths.set(e.id, { ...path, labelX: best.x, labelY: best.y });
    placed.push({ ...best, width });
  }
}

/** Derived schematic geometry; never serialized or used by the Xray compiler. */
export function routeEdgePaths(
  edges: readonly EdgeGeometry[],
  nodes: readonly NodeBounds[],
): ReadonlyMap<string, EdgePath> {
  const ordered = edges
    .filter((e) => [e.sourceX, e.sourceY, e.targetX, e.targetY].every(Number.isFinite))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const paths = new Map<string, EdgePath>();
  if (!ordered.length) return paths;
  const rects = nodes.map((n) => ({
    id: n.id,
    left: n.x,
    right: n.x + n.width,
    top: n.y,
    bottom: n.y + n.height,
  }));
  let routes = new Map<string, Point[]>();
  for (const padding of [16, 8, 0]) {
    routes = solve(ordered, nodes, padding, true);
    if (conflictingRoutes(ordered, routes).size) routes = solve(ordered, nodes, padding, false);
    if (
      ordered.every((e) => validRoute(routes.get(e.id) ?? [], e, rects)) &&
      !conflictingRoutes(ordered, routes).size
    )
      break;
  }
  const conflicts = conflictingRoutes(ordered, routes);
  for (const e of ordered) {
    const points = routes.get(e.id) ?? [],
      clear = validRoute(points, e, rects) && !conflicts.has(e.id);
    const center = points.length ? midpoint(points) : { x: e.sourceX, y: e.sourceY };
    paths.set(e.id, {
      path: clear ? points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') : '',
      points,
      labelX: center.x,
      labelY: center.y,
      junctions: [],
      sharedWires: [],
      ...(!clear ? { blocked: true } : {}),
    });
  }
  const junctions = new Set<string>();
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      const a = paths.get(ordered[i].id)!,
        b = paths.get(ordered[j].id)!;
      if (a.blocked || b.blocked || !sameTarget(ordered[i], ordered[j])) continue;
      const tail = sharedTail(a.points, b.points),
        p = tail[0];
      if (tail.length < 2 || !p || equal(p, a.points[0]) || equal(p, b.points[0])) continue;
      const key = `${p.x}:${p.y}`;
      if (junctions.has(key)) continue;
      junctions.add(key);
      a.junctions.push(p);
    }
  placeLabels(ordered, paths, rects);
  bundleSharedWires(ordered, paths);
  return paths;
}
