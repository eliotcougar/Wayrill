// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { makeEditorNode } from '../graph/catalog';
import type { GraphState } from '../graph/types';
import Inspector from './Inspector';

it('keeps one description field across updates to a selected Pool policy group', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const group = makeEditorNode('policy-group', { x: 0, y: 0 }, 'pool-policy');
  group.data.stashLink = { groupId: 'pool-stash', entryId: 'policy' };
  const graph: GraphState = {
    name: 'Shared graph',
    poolId: '0123456789abcdef0123456789abcdef',
    nodes: [group],
    edges: [],
  };
  const onUpdate = vi.fn();
  const ignore = () => {};
  const render = (next: GraphState) =>
    act(() =>
      root.render(
        <Inspector
          graph={next}
          diagnostics={[]}
          node={next.nodes[0]}
          selectedCount={1}
          onUpdate={onUpdate}
          onSelect={ignore}
          onConnect={ignore}
          onSelectConnection={ignore}
          onEditConnection={ignore}
          onShowConnection={ignore}
          onEdit={ignore}
          onDelete={ignore}
          onClose={ignore}
        />,
      ),
    );
  const descriptions = () => [
    ...host.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Description"]'),
  ];
  try {
    await render(graph);
    expect(descriptions()).toHaveLength(1);
    const [field] = descriptions();
    for (let update = 0; update < 4; update++) await render(structuredClone(graph));
    expect(descriptions()).toHaveLength(1);
    expect(descriptions()[0]).toBe(field);
    expect(onUpdate).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
