// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useClosePersistence from './useClosePersistence';
const mock = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  close: undefined as undefined | (() => void),
  destroy: vi.fn(),
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
    destroy: mock.destroy,
  }),
}));
vi.mock('./protectedStorage', () => ({
  protectedStorageAvailable: () => true,
  protectedWrite: mock.write,
}));
let root: Root;
function Harness({
  workspace,
  stash,
  ready = true,
  error,
  base = () => 'stash-base',
}: {
  workspace: () => string;
  stash: () => string;
  ready?: boolean;
  error: (text: string) => void;
  base?: () => string;
}) {
  const close = useClosePersistence(workspace, ready, stash, ready, error, base);
  return <button onClick={close}>Close Wayrill</button>;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.invoke.mockReset().mockResolvedValue(undefined);
  mock.close = undefined;
  mock.write.mockReset().mockResolvedValue(undefined);
  mock.destroy.mockReset().mockResolvedValue(undefined);
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
  await act(() => root.render(<Harness workspace={() => 'old'} stash={stash} error={error} />));
  await act(() => {
    mock.close!();
  });
  expect(mock.destroy).not.toHaveBeenCalled();
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
  expect(mock.destroy).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});
it('preserves an unreadable vault on close instead of replacing it with an example', async () => {
  const workspace = vi.fn(() => 'example'),
    stash = vi.fn(() => 'empty');
  await act(() =>
    root.render(<Harness workspace={workspace} stash={stash} ready={false} error={vi.fn()} />),
  );
  await act(() => mock.close!());
  expect(mock.write).not.toHaveBeenCalled();
  expect(workspace).not.toHaveBeenCalled();
  expect(stash).not.toHaveBeenCalled();
  expect(mock.destroy).toHaveBeenCalledOnce();
});
it('keeps the window open after write failure and permits a fresh close attempt', async () => {
  const error = vi.fn(),
    workspace = () => 'graph',
    stash = () => 'stash';
  mock.write.mockRejectedValueOnce(new Error('disk full'));
  await act(() => root.render(<Harness workspace={workspace} stash={stash} error={error} />));
  await act(() => mock.close!());
  expect(mock.destroy).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  expect(mock.invoke).toHaveBeenCalledWith('desktop_close_cancel', { message: 'disk full' });
  await act(() => mock.close!());
  expect(mock.destroy).toHaveBeenCalledOnce();
});

it('registers saved-exit handling before telling native startup it is ready', async () => {
  await act(() =>
    root.render(<Harness workspace={() => 'graph'} stash={() => 'stash'} error={vi.fn()} />),
  );
  expect(mock.close).toBeTypeOf('function');
  expect(mock.invoke).toHaveBeenCalledWith('desktop_ready');
  expect(mock.write).not.toHaveBeenCalled();
  expect(mock.destroy).not.toHaveBeenCalled();
});

it('coalesces duplicate exit events during a pending save', async () => {
  let finish!: () => void;
  mock.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(() =>
    root.render(<Harness workspace={() => 'graph'} stash={() => 'stash'} error={vi.fn()} />),
  );
  await act(() => {
    mock.close!();
  });
  await act(() => mock.close!());
  expect(mock.write).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(mock.destroy).toHaveBeenCalledOnce();
});
