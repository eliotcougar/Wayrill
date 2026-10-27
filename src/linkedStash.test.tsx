// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import useStash from './profiles/useStash';
import useGraphEditor from './useGraphEditor';
import { findStashEntry, putStashEntry, lockStashEntry } from './profiles/stashModel';
import { snapshotGraphEntry } from './profiles/workspace';
import { parseStash } from './profiles/import';
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
it('commits a field edit as one transaction and flushes the pending shared entry before closing', async () => {
  const node = editor.graph.nodes.find((n) => n.data.stashLink)!,
    link = node.data.stashLink!,
    previous = findStashEntry(store.stash, link)!;
  await act(() => editor.beginFieldEdit());
  await act(() => editor.updateNode(node.id, { label: 'One' }));
  await act(() => editor.updateNode(node.id, { label: 'Two' }));
  expect(findStashEntry(store.stash, link)).toBe(previous);
  await act(() => editor.serializeForClose());
  expect(findStashEntry(store.stash, link)?.name).toBe('Two');
  expect(
    parseStash(editor.serializeStashForClose())
      .groups.flatMap((g) => g.entries)
      .find((e) => e.id === link.entryId)?.name,
  ).toBe('Two');
  await act(() => editor.undo());
  expect(findStashEntry(store.stash, link)?.name).toBe(previous.name);
  await act(() => editor.redo());
  expect(findStashEntry(store.stash, link)?.name).toBe('Two');
});
it.each([false, true])(
  'deletes the selected graph copy with optional Stash removal (%s), retaining other copies and restoring both on Undo',
  async (remove) => {
    const node = editor.graph.nodes.find((n) => n.data.stashLink)!,
      link = node.data.stashLink!,
      entry = findStashEntry(store.stash, link)!;
    await act(() =>
      editor.change((g) => applyStashedProfile(g, entry, { x: 1500, y: 700 }, undefined, link)),
    );
    const copy = editor.selectedNodes[0];
    await act(() => editor.selectNode(node.id));
    await act(() => editor.removeSelected(remove));
    expect(editor.graph.nodes.some((n) => n.id === node.id)).toBe(false);
    expect(!!findStashEntry(store.stash, link)).toBe(!remove);
    expect(!!editor.graph.nodes.find((n) => n.id === copy.id)?.data.stashLink).toBe(!remove);
    await act(() => editor.undo());
    expect(findStashEntry(store.stash, link)).toBe(entry);
    expect(editor.graph.nodes.find((n) => n.id === copy.id)?.data.stashLink).toEqual(link);
  },
);
it('duplicates an outbound into a new manual definition and does not alter the original shared entry', async () => {
  const node = editor.graph.nodes.find((n) => n.data.stashLink)!,
    link = node.data.stashLink!,
    entry = findStashEntry(store.stash, link)!;
  await act(() => editor.selectNode(node.id));
  await act(() => editor.duplicateSelected());
  const copy = editor.selectedNodes[0];
  expect(copy.data.stashLink).not.toEqual(link);
  await act(() => editor.updateNode(copy.id, { label: 'Separate' }));
  expect(findStashEntry(store.stash, link)).toBe(entry);
});
it('updates a graph immediately after a library edit in the same batch without overwriting the new library value', async () => {
  const node = editor.graph.nodes.find((n) => n.data.stashLink)!,
    link = node.data.stashLink!,
    entry = findStashEntry(store.stash, link)!;
  await act(() => {
    store.update((s) => putStashEntry(s, { ...entry, name: 'Library edit' }, link, entry));
    editor.selectNode(node.id);
  });
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data.label).toBe('Library edit');
  expect(findStashEntry(store.stash, link)?.name).toBe('Library edit');
  await act(() => editor.undo());
  expect(findStashEntry(store.stash, link)?.name).toBe(entry.name);
});
it('records a Stash lock as one undoable library change without changing graph settings', async () => {
  const node = editor.graph.nodes.find((n) => n.data.stashLink)!,
    link = node.data.stashLink!,
    before = node.data;
  await act(() => store.update((s) => lockStashEntry(s, link)));
  expect(editor.graph.nodes.find((n) => n.id === node.id)?.data).toBe(before);
  await act(() => editor.undo());
  expect(findStashEntry(store.stash, link)?.locked).toBeFalsy();
  await act(() => editor.redo());
  expect(findStashEntry(store.stash, link)?.locked).toBe(true);
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

it('retains a background library change while committing a pending graph field edit', async () => {
  const nodes = editor.graph.nodes.filter((n) => n.data.stashLink);
  const edited = nodes[0],
    refreshed = nodes[1];
  const link = refreshed.data.stashLink!,
    entry = findStashEntry(store.stash, link)!;
  await act(() => editor.beginFieldEdit());
  await act(() => editor.updateNode(edited.id, { label: 'My draft' }));
  await act(() =>
    store.update((s) => putStashEntry(s, { ...entry, name: 'Background refresh' }, link, entry)),
  );
  await act(() => editor.endFieldEdit());
  expect(findStashEntry(store.stash, link)?.name).toBe('Background refresh');
  expect(editor.graph.nodes.find((n) => n.id === refreshed.id)?.data.label).toBe(
    'Background refresh',
  );
  expect(editor.graph.nodes.find((n) => n.id === edited.id)?.data.label).toBe('My draft');
  await act(() => editor.undo());
  expect(editor.graph.nodes.find((n) => n.id === edited.id)?.data.label).toBe(edited.data.label);
  expect(findStashEntry(store.stash, link)?.name).toBe('Background refresh');
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
