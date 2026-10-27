/// <reference lib="webworker" />
import wasmUrl from 'libavoid-wasm?url';
import { initializeEdgeRouter } from './libavoid';
import { routeEdgePaths } from './edgePaths';
import type { RoutingGeometry } from './edgeRoutingClient';
self.onmessage = async (event: MessageEvent<RoutingGeometry & { id: number }>) => {
  const { id, edges, nodes } = event.data;
  try {
    await initializeEdgeRouter(wasmUrl);
    self.postMessage({ id, paths: [...routeEdgePaths(edges, nodes)] });
  } catch {
    self.postMessage({ id, error: 'Connection layout failed. Move overlapping nodes or retry.' });
  }
};
