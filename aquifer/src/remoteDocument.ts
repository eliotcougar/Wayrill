import type { Viewport, XYPosition } from '@xyflow/react';
import { parseGraph, toDocument } from './graph/model';
import { jsonEqual, jsonRecord, parseXrayJson } from './graph/xrayJson';
import { compileRemote } from './remoteExport';
import { remoteView, type RemoteView } from './remoteModel';
import { emptyLibrary, parseUserLibrary, type UserWorkspace } from './users/model';

export interface RemoteLayout {
  positions: Record<string, XYPosition>;
  shown: string[];
  viewport?: Viewport;
}
export const emptyLayout = (): RemoteLayout => ({ positions: {}, shown: [] });

export function saveRemoteDocument(view: RemoteView, users: UserWorkspace, layout: RemoteLayout) {
  return JSON.stringify(
    {
      format: 'wayrill.remote',
      version: 1,
      graph: toDocument({
        ...view.graph,
        nodes: view.graph.nodes.map((node) => ({
          ...node,
          position: layout.positions[node.id] ?? node.position,
        })),
        ...(layout.viewport ? { viewport: layout.viewport } : {}),
      }),
      users,
      layout,
    },
    null,
    2,
  );
}

/** Never trust a companion until its executable graph reproduces the server file. */
export function restoreRemoteDocument(source: string, text: string) {
  if (new TextEncoder().encode(text).length > 16 * 1024 * 1024)
    throw new Error('The Wayrill file exceeds 16 MiB.');
  const raw = parseXrayJson(text);
  if (
    !jsonRecord(raw) ||
    raw.format !== 'wayrill.remote' ||
    raw.version !== 1 ||
    !jsonRecord(raw.users) ||
    !Array.isArray(raw.users.bindings) ||
    raw.users.bindings.length > 10000 ||
    !jsonRecord(raw.layout)
  )
    throw new Error('Unsupported Wayrill Aquifer document.');
  const graph = parseGraph(JSON.stringify(raw.graph));
  const sets = parseUserLibrary(JSON.stringify({ ...emptyLibrary(), sets: raw.users.sets })).sets;
  const ids = new Set(sets.map((s) => s.id));
  const bindings = raw.users.bindings.map((binding) => {
    if (
      !jsonRecord(binding) ||
      typeof binding.set !== 'string' ||
      !ids.has(binding.set) ||
      !Number.isSafeInteger(binding.inbound) ||
      Number(binding.inbound) < 0
    )
      throw new Error('Invalid user-set binding in the Wayrill file.');
    return { inbound: Number(binding.inbound), set: binding.set };
  });
  const users = { sets, bindings };
  const view = remoteView(source, graph);
  const result = compileRemote(view, users);
  if (result.errors.length || !jsonEqual(result.config, view.normalized))
    throw new Error('The saved graph does not compile to the current Xray configuration.');
  const positions = raw.layout.positions;
  const point = (v: unknown): v is XYPosition =>
    jsonRecord(v) &&
    typeof v.x === 'number' &&
    Number.isFinite(v.x) &&
    Math.abs(v.x) <= 1e7 &&
    typeof v.y === 'number' &&
    Number.isFinite(v.y) &&
    Math.abs(v.y) <= 1e7;
  if (
    !jsonRecord(positions) ||
    Object.keys(positions).length > 1500 ||
    Object.values(positions).some((v) => !point(v)) ||
    !Array.isArray(raw.layout.shown) ||
    raw.layout.shown.length > 1500 ||
    raw.layout.shown.some((v) => typeof v !== 'string' || v.length > 128)
  )
    throw new Error('Invalid saved graph layout.');
  const viewport = raw.layout.viewport;
  const zoom = jsonRecord(viewport) ? viewport.zoom : undefined;
  if (
    viewport !== undefined &&
    (!point(viewport) ||
      typeof zoom !== 'number' ||
      !Number.isFinite(zoom) ||
      zoom < 0.12 ||
      zoom > 1.6)
  )
    throw new Error('Invalid saved graph viewport.');
  const layout: RemoteLayout = {
    positions: positions as Record<string, XYPosition>,
    shown: raw.layout.shown as string[],
    ...(viewport ? { viewport: viewport as Viewport } : {}),
  };
  return { view, users, layout };
}
