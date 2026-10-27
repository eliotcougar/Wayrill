// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useQuickSwitch from './useQuickSwitch';
import { makeNode } from './graph/catalog';
import { importProfiles, type Stash } from './profiles/import';
import type { GraphState, StashLink } from './graph/types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  remove: vi.fn(),
  show: vi.fn(),
  unminimize: vi.fn(),
  focus: vi.fn(),
}));
vi.mock('./protectedStorage', () => ({ protectedStorageAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    listen: mocks.listen,
    show: mocks.show,
    unminimize: mocks.unminimize,
    setFocus: mocks.focus,
  }),
}));
let root: Root, host: HTMLDivElement;
let graph: GraphState, stash: Stash;
let select: (event: { payload: { nodeId: string; choice: StashLink | null } }) => void;
const replace = vi.fn(),
  browse = vi.fn(),
  error = vi.fn();
function Harness({ enabled = true }: { enabled?: boolean }) {
  useQuickSwitch({ graph, stash, enabled, onReplace: replace, onBrowse: browse, onError: error });
  return null;
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (_event, callback) => {
    select = callback;
    return mocks.remove;
  });
  mocks.show.mockResolvedValue(undefined);
  mocks.unminimize.mockResolvedValue(undefined);
  mocks.focus.mockResolvedValue(undefined);
  replace.mockResolvedValue(undefined);
  graph = {
    name: 'Switch',
    mainOutboundId: 'main',
    nodes: [
      makeNode('direct-outbound', { x: 0, y: 0 }, 'main'),
      makeNode('block-outbound', { x: 300, y: 0 }, 'other'),
    ],
    edges: [],
  };
  stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://test.example:1080#Favorite').groups,
  };
  stash.groups[0].entries[0].starred = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  await settle();
  host.remove();
});
const choice = () => ({ groupId: stash.groups[0].id, entryId: stash.groups[0].entries[0].id });

it('publishes only after registering the listener, replaces while hidden, and opens Stash only on request', async () => {
  await act(() => root.render(<Harness />));
  await settle();
  expect(mocks.listen).toHaveBeenCalledWith('wayrill-tray-replace', expect.any(Function));
  expect(mocks.invoke).toHaveBeenLastCalledWith('tray_quick_switch', {
    view: expect.objectContaining({
      nodeId: 'main',
      enabled: true,
      entries: [expect.objectContaining(choice())],
    }),
  });
  await act(() => select({ payload: { nodeId: 'main', choice: choice() } }));
  await settle();
  expect(replace).toHaveBeenCalledExactlyOnceWith('main', choice());
  expect(mocks.show).not.toHaveBeenCalled();
  await act(() => select({ payload: { nodeId: 'main', choice: null } }));
  expect(browse).toHaveBeenCalledExactlyOnceWith('main');
});

it('rejects stale targets and overlapping switches, and never invokes replacement while blocked', async () => {
  await act(() => root.render(<Harness />));
  let finish!: () => void;
  replace.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(() => {
    select({ payload: { nodeId: 'main', choice: choice() } });
    select({ payload: { nodeId: 'main', choice: choice() } });
  });
  expect(replace).toHaveBeenCalledOnce();
  await act(() => finish());
  graph = { ...graph, mainOutboundId: 'other' };
  await act(() => root.render(<Harness />));
  await act(() => select({ payload: { nodeId: 'main', choice: choice() } }));
  expect(replace).toHaveBeenCalledOnce();
  await act(() => root.render(<Harness enabled={false} />));
  await act(() => select({ payload: { nodeId: 'other', choice: choice() } }));
  expect(replace).toHaveBeenCalledOnce();
  await settle();
  expect(mocks.invoke).toHaveBeenLastCalledWith('tray_quick_switch', {
    view: expect.objectContaining({ nodeId: 'other', enabled: false }),
  });
});

it('reports a failed switch, restores the window for inspection, and permits another attempt', async () => {
  await act(() => root.render(<Harness />));
  replace.mockRejectedValueOnce(new Error('Previous route restored.'));
  await act(() => select({ payload: { nodeId: 'main', choice: choice() } }));
  await settle();
  expect(error).toHaveBeenCalledWith('Previous route restored.');
  expect(mocks.show).toHaveBeenCalledOnce();
  expect(mocks.focus).toHaveBeenCalledOnce();
  await act(() => select({ payload: { nodeId: 'main', choice: choice() } }));
  await settle();
  expect(replace).toHaveBeenCalledTimes(2);
});
