// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NodeChange, Viewport } from '@xyflow/react';
import RemoteCanvas from './RemoteCanvas';
import { remoteView, type ViewNode } from './remoteModel';
import { demoConfig } from './demo';

interface FlowProps {
  nodes: ViewNode[];
  fitView: boolean;
  defaultViewport?: Viewport;
  onNodesChange: (changes: NodeChange<ViewNode>[]) => void;
  onMoveEnd: (event: null, viewport: Viewport) => void;
}
const rendered = vi.hoisted(() => ({ current: null as FlowProps | null }));
const flow = vi.hoisted(() => ({
  fitView: vi.fn().mockResolvedValue(true),
  getViewport: vi.fn(() => ({ x: 23, y: 40, zoom: 0.5 })),
  setCenter: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));
vi.mock('@xyflow/react', async (original) => ({
  ...(await original<typeof import('@xyflow/react')>()),
  ReactFlow: (props: FlowProps) => {
    rendered.current = props;
    return <div />;
  },
  useReactFlow: () => flow,
  useInternalNode: () => undefined,
  useNodesInitialized: () => true,
}));
const routing = vi.hoisted(() => ({ error: '', retry: vi.fn() }));
vi.mock('./useEdgeRouting', () => ({ default: () => ({ paths: new Map(), ...routing }) }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  routing.error = '';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const view = remoteView(JSON.stringify(demoConfig));
const layout = {
  positions: { 'native-in-0': { x: 740, y: -320 } },
  shown: [],
  viewport: { x: 13, y: 27, zoom: 0.65 },
};
const mount = async (onLayout = vi.fn()) => {
  await act(async () =>
    root.render(
      <RemoteCanvas
        view={view}
        layout={layout}
        onLayout={onLayout}
        selected=""
        mode="select"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onContext={vi.fn()}
        onConnect={vi.fn()}
        onAdd={vi.fn()}
        isValidConnection={() => false}
      />,
    ),
  );
  return onLayout;
};

it('plots the saved positions and viewport without fitting over them', async () => {
  await mount();
  expect(rendered.current!.nodes.find((node) => node.id === 'native-in-0')!.position).toEqual(
    layout.positions['native-in-0'],
  );
  expect(rendered.current!.defaultViewport).toEqual(layout.viewport);
  expect(rendered.current!.fitView).toBe(false);
  expect(flow.fitView).not.toHaveBeenCalled();
});

it('persists completed drags and keyboard moves, avoiding writes during a drag', async () => {
  const onLayout = await mount();
  await act(async () =>
    rendered.current!.onNodesChange([
      { id: 'native-in-0', type: 'position', position: { x: 100, y: 200 }, dragging: true },
    ]),
  );
  expect(onLayout).not.toHaveBeenCalled();
  await act(async () =>
    rendered.current!.onNodesChange([
      { id: 'native-in-0', type: 'position', position: { x: 120, y: 230 }, dragging: false },
    ]),
  );
  expect(onLayout).toHaveBeenLastCalledWith({ positions: { 'native-in-0': { x: 120, y: 230 } } });
  await act(async () =>
    rendered.current!.onNodesChange([
      { id: 'native-out-0', type: 'position', position: { x: 900, y: 400 } },
    ]),
  );
  expect(onLayout).toHaveBeenLastCalledWith({
    positions: { ...layout.positions, 'native-out-0': { x: 900, y: 400 } },
  });
});

it('fits a new graph only after node measurement and saves the resulting viewport', async () => {
  const onLayout = vi.fn();
  await act(async () =>
    root.render(
      <RemoteCanvas
        view={view}
        layout={{ positions: {}, shown: [] }}
        onLayout={onLayout}
        selected=""
        mode="select"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onContext={vi.fn()}
        onConnect={vi.fn()}
        onAdd={vi.fn()}
        isValidConnection={() => false}
      />,
    ),
  );
  expect(flow.fitView).toHaveBeenCalledOnce();
  await act(async () => rendered.current!.onMoveEnd(null, { x: 23, y: 40, zoom: 0.5 }));
  expect(onLayout).toHaveBeenLastCalledWith({ viewport: { x: 23, y: 40, zoom: 0.5 } });
});

it('offers worker recovery without changing the saved layout or graph', async () => {
  routing.error = 'Connection layout timed out.';
  const onLayout = await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('timed out');
  const retry = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry layout',
  )!;
  await act(async () => retry.click());
  expect(routing.retry).toHaveBeenCalledOnce();
  expect(onLayout).not.toHaveBeenCalled();
});
