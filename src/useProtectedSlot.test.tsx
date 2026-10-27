// @vitest-environment jsdom
import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useProtectedSlot from './useProtectedSlot';

const mock = vi.hoisted(() => ({ available: true, read: vi.fn(), write: vi.fn() }));
vi.mock('./protectedStorage', () => ({
  protectedStorageAvailable: () => mock.available,
  protectedRead: mock.read,
  protectedWrite: mock.write,
}));

let root: Root, container: HTMLDivElement, storage: ReturnType<typeof useProtectedSlot>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function Harness({ text, load }: { text: string; load: (text: string | null) => void }) {
  const serialize = useCallback(() => text, [text]);
  storage = useProtectedSlot('workspace', serialize, load);
  return <span>{storage.status}</span>;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mock.available = true;
  mock.read.mockReset();
  mock.write.mockReset();
  mock.write.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('protected document lifecycle', () => {
  it('never writes the initial example before protected data has loaded', async () => {
    const load = vi.fn(),
      pending = deferred<string | null>();
    mock.read.mockReturnValue(pending.promise);
    await act(() => root.render(<Harness text="initial example" load={load} />));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(storage.loading).toBe(true);
    expect(mock.write).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve('saved document');
    });
    expect(load).toHaveBeenCalledWith('saved document');
    expect(storage.ready).toBe(true);
  });
  it('blocks automatic overwrite after a decryption or parse failure', async () => {
    mock.read.mockResolvedValue('broken document');
    const load = () => {
      throw new Error('fictional parse failure');
    };
    await act(() => root.render(<Harness text="replacement" load={load} />));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(storage.ready).toBe(false);
    expect(storage.loading).toBe(false);
    expect(storage.error).toContain('parse failure');
    expect(mock.write).not.toHaveBeenCalled();
  });
  it('keeps the newest save status when an old write finishes later', async () => {
    mock.read.mockResolvedValue(null);
    const first = deferred<void>(),
      second = deferred<void>();
    mock.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const load = vi.fn();
    await act(() => root.render(<Harness text="old" load={load} />));
    await act(() => vi.advanceTimersByTimeAsync(350));
    await act(() => root.render(<Harness text="new" load={load} />));
    await act(() => vi.advanceTimersByTimeAsync(350));
    await act(async () => {
      first.resolve();
    });
    expect(storage.status).toBe('saving');
    await act(async () => {
      second.resolve();
    });
    expect(storage.status).toBe('saved');
  });
  it('keeps browser work in memory without accessing native storage', async () => {
    mock.available = false;
    const load = vi.fn();
    await act(() => root.render(<Harness text="new graph" load={load} />));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(storage.status).toBe('session');
    expect(storage.ready).toBe(true);
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

it('defers serialization until the latest debounced save and catches a serialization failure', async () => {
  mock.read.mockResolvedValue(null);
  const load = vi.fn(),
    serialize = vi.fn(() => {
      throw new Error('cannot serialize draft');
    });
  function Lazy() {
    storage = useProtectedSlot('workspace', serialize, load);
    return null;
  }
  await act(() => root.render(<Lazy />));
  expect(serialize).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(350));
  expect(serialize).toHaveBeenCalledOnce();
  expect(storage.status).toBe('unavailable');
  expect(storage.error).toContain('cannot serialize draft');
  expect(mock.write).not.toHaveBeenCalled();
});
