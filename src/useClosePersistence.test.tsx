// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useClosePersistence from './useClosePersistence';
const mock = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  close: undefined as undefined | ((event: { payload: number }) => void),
  write: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    listen: async (event: string, callback: typeof mock.close) => {
      expect(event).toBe('wayrill-desktop-exit');
      mock.close = callback;
      return mock.unsubscribe;
    },
  }),
}));
vi.mock('./protectedStorage', () => ({
  backupRestorePending: () => false,
  protectedStorageAvailable: () => true,
  protectedWrite: mock.write,
}));
let root: Root;
const close = (attempt: number) => mock.close!({ payload: attempt });
const completion = (attempt: number, error: string | null = null) =>
  ['desktop_close_complete', { attempt, error }] as const;
function Harness({
  workspace,
  stash,
  ready = true,
  error,
  base = () => 'stash-base',
  handoff,
}: {
  workspace: () => string;
  stash: () => string;
  ready?: boolean;
  error: (text: string) => void;
  base?: () => string;
  handoff?: (frozen: boolean) => void;
}) {
  const close = useClosePersistence(workspace, ready, stash, ready, error, base, handoff);
  return <button onClick={close}>Close Wayrill</button>;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.invoke.mockReset().mockResolvedValue(true);
  mock.close = undefined;
  mock.write.mockReset().mockResolvedValue(undefined);
  mock.unsubscribe.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
});

it('flushes an edit made during a pending close write before destroying the window', async () => {
  let finish!: () => void;
  mock.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const error = vi.fn(),
    stash = () => 'stash';
  mock.invoke.mockImplementation(async (command) => {
    if (command === 'desktop_ready') close(1);
    return true;
  });
  await act(() => root.render(<Harness workspace={() => 'old'} stash={stash} error={error} />));
  expect(mock.write).toHaveBeenCalledTimes(1);
  await act(() => {
    close(1);
  });
  expect(mock.invoke.mock.calls).not.toContainEqual(completion(1));
  await act(() => root.render(<Harness workspace={() => 'new'} stash={stash} error={error} />));
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(mock.write.mock.calls).toEqual([
    ['workspace', 'old'],
    ['stash', 'stash', 'stash-base'],
    ['workspace', 'new'],
    ['stash', 'stash', 'stash-base'],
  ]);
  expect(mock.invoke.mock.calls).toContainEqual(completion(1));
  expect(error).not.toHaveBeenCalled();
});
it('preserves an unreadable vault on close instead of replacing it with an example', async () => {
  const workspace = vi.fn(() => 'example'),
    stash = vi.fn(() => 'empty');
  await act(() =>
    root.render(<Harness workspace={workspace} stash={stash} ready={false} error={vi.fn()} />),
  );
  await act(() => close(1));
  expect(mock.write).not.toHaveBeenCalled();
  expect(workspace).not.toHaveBeenCalled();
  expect(stash).not.toHaveBeenCalled();
  expect(mock.invoke.mock.calls).toContainEqual(completion(1));
});
it('keeps the window open after write failure and permits a fresh close attempt', async () => {
  const error = vi.fn(),
    workspace = () => 'graph',
    stash = () => 'stash';
  mock.write.mockRejectedValueOnce(new Error('disk full'));
  await act(() => root.render(<Harness workspace={workspace} stash={stash} error={error} />));
  await act(() => close(1));
  expect(mock.invoke.mock.calls).not.toContainEqual(completion(1));
  expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  expect(mock.invoke.mock.calls).toContainEqual(completion(1, 'disk full'));
  await act(() => close(2));
  await act(() => close(1));
  expect(mock.invoke.mock.calls).toContainEqual(completion(2));
  expect(
    mock.invoke.mock.calls.filter(([command]) => command === 'desktop_close_complete'),
  ).toHaveLength(2);
});

it('freezes edits before native close and unlocks the draft if destruction fails', async () => {
  let text = 'graph';
  let frozen = false;
  let reject!: (error: Error) => void;
  const error = vi.fn();
  const handoff = vi.fn((value: boolean) => {
    frozen = value;
    // Focus changes during the freeze can finish an existing text edit.
    if (value) text = 'last edit';
  });
  mock.invoke.mockImplementation(async (command) => {
    if (command !== 'desktop_close_complete') return true;
    expect(frozen).toBe(true);
    expect(mock.write).toHaveBeenCalledWith('workspace', 'last edit');
    return new Promise<never>((_, fail) => (reject = fail));
  });
  await act(() =>
    root.render(
      <Harness workspace={() => text} stash={() => 'stash'} error={error} handoff={handoff} />,
    ),
  );
  await act(() => close(1));
  expect(frozen).toBe(true);
  await act(() => reject(new Error('The window is still open')));
  expect(frozen).toBe(false);
  expect(handoff.mock.calls).toEqual([[true], [false]]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('The window is still open'));
});
