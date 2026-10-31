// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useCompanionRuleRequest from './useCompanionRuleRequest';
import type { CompanionRuleRequest } from './companionRules';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
let root: Root, host: HTMLDivElement, result: ReturnType<typeof useCompanionRuleRequest>;
let wake: () => void;
let queue: CompanionRuleRequest[];
function Harness({ ready = true }: { ready?: boolean }) {
  result = useCompanionRuleRequest(ready);
  return result.request && <dialog open>{result.request.host}</dialog>;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  queue = [
    { host: 'one.test', filterIds: ['filter'] },
    { host: 'two.test', filterIds: [] },
  ];
  mocks.invoke.mockImplementation(async (_name, args) => {
    if (args?.completed?.host === queue[0]?.host) queue.shift();
    return queue[0] ?? null;
  });
  mocks.listen.mockImplementation(async (_name, callback) => {
    wake = callback;
    return () => {};
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('keeps queued requests across StrictMode, waits for an unsaved editor, and drains only on dismissal', async () => {
  const editor = document.createElement('dialog');
  editor.open = true;
  editor.textContent = 'Unsaved draft';
  document.body.append(editor);
  await act(() =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  await act(async () => {
    wake();
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.request).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(editor.open).toBe(true);
  editor.remove();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(result.request?.host).toBe('one.test');
  expect(queue).toHaveLength(2);
  await act(() => wake());
  expect(queue).toHaveLength(2);
  await act(() => result.close());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(result.request?.host).toBe('two.test');
  expect(queue).toHaveLength(1);
  await act(() => result.close());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(result.request).toBeNull();
  expect(queue).toHaveLength(0);
});

it('defers while storage or activation blocks editing and preserves a request across remount', async () => {
  await act(() => root.render(<Harness ready={false} />));
  await act(() => wake());
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(() => root.render(<Harness />));
  expect(result.request?.host).toBe('one.test');
  await act(() => root.render(null));
  await act(() => root.render(<Harness />));
  expect(result.request?.host).toBe('one.test');
  expect(queue).toHaveLength(2);
});

it.each(['editor', 'activation'])(
  'rechecks %s readiness when a delayed native reply arrives',
  async (blocker) => {
    let reply!: (request: CompanionRuleRequest) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));
    await act(() => root.render(<Harness />));
    const editor = document.createElement('dialog');
    if (blocker === 'editor') {
      editor.open = true;
      document.body.append(editor);
    } else await act(() => root.render(<Harness ready={false} />));
    try {
      await act(() => reply(queue[0]));
      expect(result.request).toBeNull();
      await act(() => root.render(<Harness ready={false} />));
      editor.remove();
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(result.request).toBeNull();
      await act(() => root.render(<Harness />));
      expect(result.request?.host).toBe('one.test');
    } finally {
      editor.remove();
    }
  },
);

it('acknowledges a dismissal once while the next request waits in the queue', async () => {
  await act(() => root.render(<Harness />));
  let acknowledge!: () => void;
  mocks.invoke.mockImplementation((_name, args) => {
    if (!args?.completed) return Promise.resolve(queue[0] ?? null);
    return new Promise((resolve) => {
      acknowledge = () => {
        queue.shift();
        resolve(queue[0] ?? null);
      };
    });
  });
  await act(() => {
    result.close();
    result.close();
  });
  expect(mocks.invoke.mock.calls.filter(([, args]) => args?.completed)).toHaveLength(1);
  expect(result.request?.host).toBe('one.test');
  await act(() => acknowledge());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(result.request?.host).toBe('two.test');
});
