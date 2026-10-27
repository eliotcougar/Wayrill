// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Position, type InternalNode } from '@xyflow/react';
import useEdgeRouting from './useEdgeRouting';
import type { RoutingGeometry } from './graph/edgeRoutingClient';
import type { EdgePath } from './graph/edgePaths';
let store: {
  edges: { id: string; source: string; target: string }[];
  nodeLookup: Map<string, InternalNode>;
};
const jobs = vi.hoisted(
  () =>
    [] as {
      geometry: RoutingGeometry;
      complete: (paths: ReadonlyMap<string, EdgePath>, error: string) => void;
    }[],
);
let selected: RoutingGeometry | undefined;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useStore: (
    select: (s: typeof store) => RoutingGeometry,
    equal: (a: RoutingGeometry, b: RoutingGeometry) => boolean,
  ) => {
    const next = select(store);
    if (!selected || !equal(selected, next)) selected = next;
    return selected;
  },
}));
vi.mock('./graph/edgeRoutingClient', () => ({
  EdgeRoutingClient: class {
    request(
      geometry: RoutingGeometry,
      complete: (paths: ReadonlyMap<string, EdgePath>, error: string) => void,
    ) {
      jobs.push({ geometry, complete });
    }
    dispose() {}
  },
}));
let root: Root, host: HTMLDivElement, current: ReturnType<typeof useEdgeRouting>, frames: number[];
function Harness({ tick }: { tick: number }) {
  current = useEdgeRouting();
  frames.push(current.paths.size);
  return <span>{tick}</span>;
}
function node(id: string, x: number): InternalNode {
  const n = { id, position: { x, y: 0 }, data: {} };
  return {
    ...n,
    measured: { width: 200, height: 150 },
    internals: {
      positionAbsolute: { x, y: 0 },
      z: 0,
      userNode: n,
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
            y: 30,
            width: 12,
            height: 12,
          },
        ],
      },
    },
  };
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  frames = [];
  selected = undefined;
  jobs.length = 0;
  store = {
    edges: [{ id: 'wire', source: 'a', target: 'b' }],
    nodeLookup: new Map([
      ['a', node('a', 0)],
      ['b', node('b', 500)],
    ]),
  };
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
function finish(index: number) {
  const e = jobs[index].geometry.edges[0];
  const p: EdgePath = {
    path: 'ready',
    points: [
      { x: e.sourceX, y: e.sourceY },
      { x: 350, y: e.sourceY },
      { x: 350, y: e.targetY },
      { x: e.targetX, y: e.targetY },
    ],
    labelX: 350,
    labelY: e.sourceY,
    junctions: [],
    sharedWires: [],
  };
  jobs[index].complete(new Map([['wire', p]]), '');
}
it('never clears visible links while worker layouts trail a drag, then installs the exact final result', async () => {
  await act(() => root.render(<Harness tick={0} />));
  await act(() => finish(0));
  const mark = frames.length;
  store.nodeLookup.get('a')!.internals.positionAbsolute.x = 16;
  await act(() => root.render(<Harness tick={1} />));
  expect(current.pending).toBe(true);
  expect(current.paths.get('wire')!.points[0].x).toBe(222);
  store.nodeLookup.get('a')!.internals.positionAbsolute.x = 32;
  await act(() => root.render(<Harness tick={2} />));
  await act(() => finish(1));
  expect(current.pending).toBe(true);
  expect(current.paths.get('wire')!.points[0].x).toBe(238);
  await act(() => finish(2));
  expect(current.pending).toBe(false);
  expect(current.paths.get('wire')!.path).toBe('ready');
  expect(frames.slice(mark).every((n) => n === 1)).toBe(true);
});
it('discards stale failures and removed links while preserving explicit current failures and retry', async () => {
  await act(() => root.render(<Harness tick={0} />));
  await act(() => finish(0));
  store.nodeLookup.get('a')!.internals.positionAbsolute.x = 16;
  await act(() => root.render(<Harness tick={1} />));
  await act(() => jobs[0].complete(new Map(), 'old failure'));
  expect(current.error).toBe('');
  expect(current.paths.size).toBe(1);
  await act(() => jobs[1].complete(new Map(), 'current failure'));
  expect(current.error).toBe('current failure');
  expect(current.pending).toBe(false);
  await act(() => current.retry());
  expect(jobs).toHaveLength(3);
  await act(() => finish(2));
  expect(current.error).toBe('');
  store.edges = [];
  await act(() => root.render(<Harness tick={2} />));
  expect(current.paths.size).toBe(0);
  expect(current.pending).toBe(false);
  expect(jobs).toHaveLength(3);
});

it('cannot blank a good link with a blocked intermediate position, but honors the current blocked layout', async () => {
  await act(() => root.render(<Harness tick={0} />));
  await act(() => finish(0));
  store.nodeLookup.get('a')!.internals.positionAbsolute.x = 400;
  await act(() => root.render(<Harness tick={1} />));
  store.nodeLookup.get('a')!.internals.positionAbsolute.x = 32;
  await act(() => root.render(<Harness tick={2} />));
  const blocked: EdgePath = {
    path: '',
    points: [],
    blocked: true,
    labelX: 0,
    labelY: 0,
    junctions: [],
    sharedWires: [],
  };
  await act(() => jobs[1].complete(new Map([['wire', blocked]]), ''));
  expect(current.pending).toBe(true);
  expect(current.paths.get('wire')!.blocked).not.toBe(true);
  expect(current.paths.get('wire')!.points[0].x).toBe(238);
  await act(() => jobs[2].complete(new Map([['wire', blocked]]), ''));
  expect(current.pending).toBe(false);
  expect(current.paths.get('wire')!.blocked).toBe(true);
  expect(current.paths.get('wire')!.path).toBe('');
});
