// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createProxyStarter } from '../graph/examples';
import { parseGraph, toDocument } from '../graph/model';
import type { GraphState } from '../graph/types';
import useGraphEditor from '../useGraphEditor';
import useManagedPoolGraph from './useManagedPoolGraph';

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('../protectedStorage', () => ({
  protectedStorageAvailable: () => true,
  protectedRead: async (key: string) => vault.get(key) ?? null,
  protectedWrite: async (key: string, value: string) => {
    vault.set(key, value);
  },
}));

it('opens the enrolled graph, rebases edits across a closed editor, and parks a conflicting draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const local = createProxyStarter();
  local.name = 'My standalone graph';
  const first: GraphState = {
    ...createProxyStarter(),
    poolId: 'a'.repeat(32),
    name: 'First delivery',
  };
  let editor!: ReturnType<typeof useGraphEditor>;
  const notify = vi.fn();
  function Harness({ applied, hash }: { applied: GraphState; hash: string }) {
    editor = useGraphEditor(undefined, undefined, false, local);
    useManagedPoolGraph(editor, applied, hash, true, notify);
    return null;
  }
  let root = createRoot(document.createElement('div'));
  const render = (applied: GraphState, hash: string) =>
    act(async () => root.render(<Harness applied={applied} hash={hash} />));
  try {
    await render(first, 'one');
    expect(editor.graph.name).toBe('First delivery');
    expect(parseGraph(vault.get('pool-previous')!).name).toBe(local.name);
    await act(() => editor.change((graph) => ({ ...graph, name: 'My pending title' })));
    vault.set('workspace', editor.serializeForClose());
    await act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    const second = structuredClone(first);
    second.nodes[0].data.settings.port = 24137;
    await render(second, 'two');
    expect(editor.graph.name).toBe('My pending title');
    expect(editor.graph.nodes[0].data.settings.port).toBe(24137);
    expect(notify).not.toHaveBeenCalled();
    await render({ ...second, name: 'Published title' }, 'three');
    expect(editor.graph.name).toBe('Published title');
    expect(parseGraph(vault.get('pool-previous')!).name).toBe('My pending title');
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Export previous local graph'),
    );
    expect(JSON.parse(editor.serialize())).not.toHaveProperty('poolBaseHash');
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    vault.clear();
  }
});

it('preserves edits across an interruption before autosave and migrates the legacy baseline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const first = { ...createProxyStarter(), poolId: 'a'.repeat(32) };
  const draft = { ...first, name: 'Local title' };
  vault.set('workspace', JSON.stringify({ ...toDocument(draft), poolBaseHash: 'first' }));
  vault.set('pool-base', JSON.stringify({ ...toDocument(first), poolBaseHash: 'first' }));
  const second = structuredClone(first);
  second.nodes[0].data.settings.port = 24137;
  const third = structuredClone(second);
  third.nodes[0].data.settings.port = 24138;
  const notify = vi.fn();
  let editor!: ReturnType<typeof useGraphEditor>;
  function Harness({ applied, hash }: { applied: GraphState; hash: string }) {
    editor = useGraphEditor();
    useManagedPoolGraph(editor, applied, hash, true, notify);
    return null;
  }
  let root = createRoot(document.createElement('div'));
  const render = (applied: GraphState, hash: string) =>
    act(() => root.render(<Harness applied={applied} hash={hash} />));
  const reopen = async (applied: GraphState, hash: string) => {
    await act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await render(applied, hash);
  };
  try {
    await render(second, 'second');
    expect(editor.graph.name).toBe(draft.name);
    expect(editor.graph.nodes[0].data.settings.port).toBe(24137);
    // Close without flushing, as when the process is interrupted during the debounce.
    await reopen(second, 'second');
    expect(editor.graph.name).toBe(draft.name);
    expect(editor.graph.nodes[0].data.settings.port).toBe(24137);
    await act(() => vi.advanceTimersByTimeAsync(350));
    vault.delete('pool-base');
    await reopen(third, 'third');
    expect(editor.graph.name).toBe(draft.name);
    expect(editor.graph.nodes[0].data.settings.port).toBe(24138);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vault.clear();
  }
});
