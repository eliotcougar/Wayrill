import { useEffect, useMemo, useRef, useState } from 'react';
import { previewEdgePaths } from './graph/edgeRoutePreview';
import type { RoutingGeometry } from './graph/edgeRoutingClient';
import { EdgeRoutingClient } from './graph/edgeRoutingClient';
import { Position, useStore, type InternalNode, type ReactFlowState } from '@xyflow/react';
import type { EdgeGeometry } from './graph/edgeGeometry';
import { type EdgePath, type NodeBounds } from './graph/edgePaths';
import { connectionTypes, type ConnectionKind } from './graph/connectionKinds';

function endpoint(node: InternalNode | undefined, type: 'source' | 'target', id?: string | null) {
  if (!node || node.hidden) return;
  const handles = node.internals.handleBounds?.[type];
  const handle = id ? handles?.find((h) => h.id === id) : handles?.[0];
  if (!handle) return;
  const { position, width, height } = handle;
  return {
    position,
    x:
      node.internals.positionAbsolute.x +
      handle.x +
      (position === Position.Right ? width : position === Position.Left ? 0 : width / 2),
    y:
      node.internals.positionAbsolute.y +
      handle.y +
      (position === Position.Bottom ? height : position === Position.Top ? 0 : height / 2),
  };
}

export function edgeGeometry(state: Pick<ReactFlowState, 'edges' | 'nodeLookup'>): EdgeGeometry[] {
  const geometry: EdgeGeometry[] = [];
  for (const edge of state.edges) {
    if (edge.hidden) continue;
    const source = endpoint(state.nodeLookup.get(edge.source), 'source', edge.sourceHandle);
    const target = endpoint(state.nodeLookup.get(edge.target), 'target', edge.targetHandle);
    if (source && target) {
      geometry.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        sourceX: source.x,
        sourceY: source.y,
        targetX: target.x,
        targetY: target.y,
        sourcePosition: source.position,
        targetPosition: target.position,
        ...(typeof edge.label === 'string' ? { label: edge.label } : {}),
        ...(typeof edge.data?.connectionKind === 'string' &&
        Object.hasOwn(connectionTypes, edge.data.connectionKind)
          ? { kind: edge.data.connectionKind as ConnectionKind }
          : {}),
      });
    }
  }
  return geometry;
}

export function routingGeometry(state: Pick<ReactFlowState, 'edges' | 'nodeLookup'>) {
  const nodes: NodeBounds[] = [];
  for (const node of state.nodeLookup.values()) {
    const { width, height } = node.measured;
    const { x, y } = node.internals.positionAbsolute;
    if (
      !node.hidden &&
      width &&
      height &&
      width > 0 &&
      height > 0 &&
      [x, y, width, height].every(Number.isFinite)
    ) {
      nodes.push({ id: node.id, x, y, width, height });
    }
  }
  return { edges: edgeGeometry(state), nodes };
}

const sameGeometry = (
  a: ReturnType<typeof routingGeometry>,
  b: ReturnType<typeof routingGeometry>,
) =>
  a.edges.length === b.edges.length &&
  a.nodes.length === b.nodes.length &&
  a.edges.every(
    (e, index) =>
      e.id === b.edges[index].id &&
      e.source === b.edges[index].source &&
      e.target === b.edges[index].target &&
      e.sourceHandle === b.edges[index].sourceHandle &&
      e.targetHandle === b.edges[index].targetHandle &&
      e.sourceX === b.edges[index].sourceX &&
      e.sourceY === b.edges[index].sourceY &&
      e.targetX === b.edges[index].targetX &&
      e.targetY === b.edges[index].targetY &&
      e.sourcePosition === b.edges[index].sourcePosition &&
      e.targetPosition === b.edges[index].targetPosition &&
      e.label === b.edges[index].label &&
      e.kind === b.edges[index].kind,
  ) &&
  a.nodes.every(
    (n, i) =>
      n.id === b.nodes[i].id &&
      n.x === b.nodes[i].x &&
      n.y === b.nodes[i].y &&
      n.width === b.nodes[i].width &&
      n.height === b.nodes[i].height,
  );

export default function useEdgeRouting() {
  const geometry = useStore(routingGeometry, sameGeometry);
  const client = useRef<EdgeRoutingClient | null>(null);
  const [retry, setRetry] = useState(0);
  const alive = useRef(false);
  const latestGeometry = useRef(geometry);
  latestGeometry.current = geometry;
  const [state, setState] = useState<{
    paths: ReadonlyMap<string, EdgePath>;
    geometry: RoutingGeometry | null;
    attempt: number;
    error: string;
  }>({ paths: new Map(), geometry: null, attempt: -1, error: '' });
  useEffect(() => {
    const router = new EdgeRoutingClient();
    alive.current = true;
    client.current = router;
    return () => {
      alive.current = false;
      client.current = null;
      router.dispose();
    };
  }, []);
  useEffect(() => {
    if (!geometry.edges.length) {
      setState({ paths: new Map(), geometry, attempt: retry, error: '' });
      return;
    }
    client.current?.request(geometry, (paths, error) => {
      if (
        !alive.current ||
        !latestGeometry.current.edges.length ||
        (error && geometry !== latestGeometry.current)
      )
        return;
      // Completed drag frames can supply useful lanes, without ever clearing
      // visible links between worker transactions. Live endpoints are projected below.
      setState((previous) => {
        if (geometry === latestGeometry.current) return { paths, geometry, attempt: retry, error };
        // An intermediate overlapping position can be blocked. It cannot erase
        // a usable displayed link after the pointer has already moved away.
        const carried = previewEdgePaths(previous.paths, previous.geometry, geometry);
        const visible = new Map(paths);
        for (const [id, route] of carried)
          if (!route.blocked && (!visible.has(id) || visible.get(id)?.blocked))
            visible.set(id, route);
        return { paths: visible, geometry, attempt: retry, error };
      });
    });
  }, [geometry, retry]);
  const paths = useMemo(
    () => previewEdgePaths(state.paths, state.geometry, geometry),
    [state.paths, state.geometry, geometry],
  );
  const pending = state.geometry !== geometry || state.attempt !== retry;
  return {
    paths,
    pending: pending && geometry.edges.length > 0,
    error: pending ? '' : state.error,
    retry: () => setRetry((current) => current + 1),
  };
}
