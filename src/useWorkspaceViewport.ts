import { useNodesInitialized, useReactFlow, useStore, type Viewport } from '@xyflow/react';
import { useEffect, useRef } from 'react';

export default function useWorkspaceViewport({
  loadVersion,
  ready,
  viewport,
  nodeIds,
}: {
  loadVersion: number;
  ready: boolean;
  viewport?: Viewport;
  nodeIds: string[];
}) {
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const pending = useRef({ loadVersion, viewport, nodeIds: new Set(nodeIds), applied: false });
  if (pending.current.loadVersion !== loadVersion) {
    pending.current = { loadVersion, viewport, nodeIds: new Set(nodeIds), applied: false };
  }
  // React Flow can still report the previous graph as measured for one render.
  const loaded = useStore(
    (state) =>
      state.nodes.length === pending.current.nodeIds.size &&
      state.nodes.every((node) => pending.current.nodeIds.has(node.id)),
  );
  const hasNodes = nodeIds.length > 0;
  useEffect(() => {
    if (!ready || !loaded || (hasNodes && !measured) || pending.current.applied) return;
    pending.current.applied = true;
    const saved = pending.current.viewport;
    if (saved) void flow.setViewport(saved);
    else if (hasNodes) void flow.fitView({ padding: 0.18, maxZoom: 1 });
    else void flow.setViewport({ x: 0, y: 0, zoom: 1 });
  }, [flow, hasNodes, loaded, loadVersion, measured, ready]);
}
