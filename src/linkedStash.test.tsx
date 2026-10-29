// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import useStash from './profiles/useStash';
import useGraphEditor from './useGraphEditor';
import { findStashEntry, putStashEntry } from './profiles/stashModel';
import { snapshotGraphEntry } from './profiles/workspace';
import { applyStashedProfile } from './profiles/graph';

vi.mock('./graph/examples', async () => {
  const { createTrafficExample } = await import('./graph/example');
  const { enableDefaults } = await import('./graph/defaults');
  return { createProxyStarter: () => enableDefaults(createTrafficExample()) };
});
vi.mock('./useProtectedSlot', () => ({
  default: () => ({ loading: false, ready: true, error: '', status: 'session' }),
}));
let root: Root, store: ReturnType<typeof useStash>, editor: ReturnType<typeof useGraphEditor>;
function Harness() {
  store = useStash();
  editor = useGraphEditor(store.ready ? store.stash : undefined, store);
  return null;
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
});
it('adds manual entries for every graph outbound, edits shared copies, and undoes graph and Stash together', async () => {
  await act(() => editor.addNode('socks-outbound', { x: 1200, y: 100 }));
  const node = editor.selectedNodes[0],
    link = node.data.stashLink!,
    before = findStashEntry(store.stash, link)!;
  expect(before.manual).toBe(true);
  expect(link.groupId).toBe('wayrill:default');
  await act(() =>
    editor.updateNode(node.id, {
      settings: { ...node.data.settings, address: 'shared.example.net', port: 1080 },
      label: 'Shared',
    }),
  );
  const entry = findStashEntry(store.stash, link)!;
  await act(() =>
    editor.change((g) => applyStashedProfile(g, entry, { x: 1600, y: 100 }, undefined, link)),
  );
  const copy = editor.selectedNodes[0],
    tag = copy.data.settings.tag;
  await act(() => editor.updateNode(node.id, { label: 'Both copies' }));
  expect(editor.graph.nodes.find((n) => n.id === copy.id)?.data.label).toBe('Both copies');
  expect(editor.graph.nodes.find((n) => n.id === copy.id)?.data.settings.tag).toBe(tag);
  await act(() => editor.undo());
  expect(findStashEntry(store.stash, link)?.name).toBe('Shared');
  expect(editor.graph.nodes.find((n) => n.id === copy.id)?.data.label).toBe('Shared');
  await act(() => editor.redo());
  expect(findStashEntry(store.stash, link)?.name).toBe('Both copies');
});
it('rejects a failed library commit before publishing the graph, preserving both snapshots', async () => {
  const node = editor.graph.nodes.find((n) => n.data.stashLink)!;
  const entry = snapshotGraphEntry(editor.graph, node);
  await act(() =>
    store.update((s) => ({
      ...s,
      groups: Array.from({ length: 500 }, (_, i) => ({
        ...s.groups[0],
        id: String(i),
        name: String(i),
        entries: i === 0 ? s.groups[0].entries : [],
      })),
    })),
  );
  // Existing nodes were detached, and a new Default group would exceed the group budget.
  const graph = editor.graph,
    stash = store.stash;
  expect(() => editor.addNode(entry.draft!.kind, { x: 1500, y: 500 })).toThrow(/500/);
  expect(editor.graph).toBe(graph);
  expect(store.stash).toBe(stash);
});

it('does not lose initial manual entries when development StrictMode replays synchronization effects', async () => {
  await act(() => root.unmount());
  root = createRoot(document.createElement('div'));
  await act(() =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  const outbounds = editor.graph.nodes.filter((n) => n.data.kind.endsWith('-outbound'));
  expect(outbounds.length).toBeGreaterThan(0);
  for (const node of outbounds) {
    expect(node.data.stashLink).toBeTruthy();
    expect(findStashEntry(store.stash, node.data.stashLink!)).toBeTruthy();
  }
  expect(store.stash.groups[0].entries.length).toBe(outbounds.length);
  expect(editor.canUndo).toBe(false);
});

it('keeps untouched settings from a concurrent refresh of the same outbound', async () => {
  const node = editor.graph.nodes.find((n) => n.data.kind === 'vless-outbound')!;
  const link = node.data.stashLink!,
    entry = findStashEntry(store.stash, link)!;
  await act(() => editor.beginFieldEdit());
  await act(() => editor.updateNode(node.id, { label: 'My name' }));
  await act(() =>
    store.update((s) =>
      putStashEntry(
        s,
        {
          ...entry,
          draft: {
            ...entry.draft!,
            settings: { ...entry.draft!.settings, address: 'refreshed.example.net' },
          },
        },
        link,
        entry,
      ),
    ),
  );
  await act(() => editor.endFieldEdit());
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data.settings.address).toBe(
    'refreshed.example.net',
  );
  expect(findStashEntry(store.stash, link)?.draft?.settings.address).toBe('refreshed.example.net');
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data.label).toBe('My name');
  await act(() => editor.undo());
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data.settings.address).toBe(
    'refreshed.example.net',
  );
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data.label).toBe(node.data.label);
});
