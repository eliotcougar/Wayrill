// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useWorkspaceViewport from './useWorkspaceViewport';

const mock = vi.hoisted(() => ({
  measured: false,
  nodeIds: ['one'],
  flow: { fitView: vi.fn(), setViewport: vi.fn() },
}));
vi.mock('@xyflow/react', () => ({
  useNodesInitialized: () => mock.measured,
  useReactFlow: () => mock.flow,
  useStore: (select: (state: { nodes: { id: string }[] }) => boolean) =>
    select({ nodes: mock.nodeIds.map((id) => ({ id })) }),
}));
let root: Root, container: HTMLDivElement;
function Harness(props: Parameters<typeof useWorkspaceViewport>[0]) {
  useWorkspaceViewport(props);
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.measured = false;
  mock.nodeIds = ['one'];
  mock.flow.fitView.mockReset();
  mock.flow.setViewport.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
});
describe('workspace viewport initialization', () => {
  it('does not fit the previous measured graph when a new example is loaded', async () => {
    mock.measured = true;
    await act(() => root.render(<Harness loadVersion={0} ready nodeIds={['one']} />));
    mock.flow.fitView.mockClear();
    await act(() =>
      root.render(<Harness loadVersion={1} ready nodeIds={['fake-input', 'fake-resolver']} />),
    );
    expect(mock.flow.fitView).not.toHaveBeenCalled();
    mock.nodeIds = ['fake-input', 'fake-resolver'];
    await act(() => root.render(<Harness loadVersion={1} ready nodeIds={mock.nodeIds} />));
    expect(mock.flow.fitView).toHaveBeenCalledOnce();
  });
});
