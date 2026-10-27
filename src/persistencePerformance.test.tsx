// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useGraphEditor from './useGraphEditor';
import * as model from './graph/model';
import { importXrayConfig } from './graph/xrayImport';

vi.mock('./useProtectedSlot', () => ({
  default: () => ({ loading: false, ready: true, error: '', status: 'session' }),
}));
let root: Root, editor: ReturnType<typeof useGraphEditor>;
function Harness() {
  editor = useGraphEditor();
  return null;
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
});

it('does not serialize a 5,000-candidate graph during dragging, selection or history comparison', async () => {
  const graph = importXrayConfig(
    JSON.stringify({
      outbounds: Array.from({ length: 5000 }, (_, i) => ({
        tag: `candidate-${i}`,
        protocol: 'freedom',
      })),
      routing: { balancers: [{ tag: 'pool', selector: ['candidate-'] }] },
    }),
  );
  await act(() => editor.loadGraph(graph));
  const serialize = vi.spyOn(model, 'serializeGraph');
  const node = editor.graph.nodes[0],
    start = node.position;
  await act(() => editor.beginDrag());
  for (let i = 1; i <= 30; i++) {
    await act(() =>
      editor.onNodesChange([
        {
          type: 'position',
          id: node.id,
          position: { x: start.x + i, y: start.y + i },
          dragging: true,
        },
      ]),
    );
  }
  await act(() => editor.endDrag());
  await act(() => editor.selectNode(node.id));
  expect(serialize).not.toHaveBeenCalled();
  await act(() => editor.undo());
  expect(editor.graph.nodes[0].position).toEqual(start);
  await act(() => editor.redo());
  expect(editor.graph.nodes[0].position).toEqual({ x: start.x + 30, y: start.y + 30 });
});
