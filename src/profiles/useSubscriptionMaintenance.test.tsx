// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useSubscriptionMaintenance from './useSubscriptionMaintenance';
import { importProfiles, type Stash } from './import';
import type { SubscriptionStatus } from './serviceSubscriptions';
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  context: vi.fn(),
  wait: vi.fn(),
  progress: vi.fn(),
}));
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: mocks.call,
  errorText: (e: Error) => e.message,
  mutationOutcomeUnknown: (e: { code: string }) => e.code === 'TIMEOUT',
}));
vi.mock('../protectedStorage', () => ({ protectedWrite: mocks.write }));
vi.mock('./serviceSubscriptions', () => ({
  refreshServiceStash: mocks.refresh,
  sendSubscriptionContext: mocks.context,
  waitSubscriptionJob: mocks.wait,
  readSubscriptionProgress: mocks.progress,
}));
let root: Root, latest: ReturnType<typeof useSubscriptionMaintenance>, stash: Stash;
const graph = { name: 'Subscriptions', nodes: [], edges: [] };
const store = {
  get: () => stash,
  getBase: () => 'acknowledged service snapshot',
  update: (fn: (s: Stash) => Stash) => (stash = fn(stash)),
  importText: vi.fn(),
};
const serviceStatus: SubscriptionStatus = {
  version: 3,
  initialized: true,
  error: null,
  busy: false,
  automatic: false,
  statuses: {},
  appliedRevision: null,
  appliedSourceHash: null,
};
function Harness({
  ready = true,
  status = serviceStatus,
}: {
  ready?: boolean;
  status?: SubscriptionStatus;
}) {
  latest = useSubscriptionMaintenance(
    store,
    graph,
    ready,
    false,
    'https://test.example',
    '',
    status,
  );
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue(undefined);
  mocks.call.mockImplementation(async (method: string) =>
    method === 'subscriptions.status'
      ? { version: 3, statuses: {}, error: null }
      : method === 'subscriptions.prepareRun'
        ? { job: 42 }
        : {},
  );
  stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://192.0.2.1:1080#Example').groups,
  };
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it('flushes edited settings before requesting a service refresh and reloads its result', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => latest.run(stash.groups[0].id, 'refresh'));
  expect(mocks.write).toHaveBeenCalledWith('stash', expect.any(String), store.getBase());
  expect(mocks.call).toHaveBeenCalledWith('subscriptions.run', {
    job: 42,
    groupId: stash.groups[0].id,
    operation: 'refresh',
  });
  expect(mocks.wait).toHaveBeenCalledWith(42, undefined);
  expect(mocks.refresh).toHaveBeenCalledWith(3);
});
it('queues overlapping edits and releases the next one after a failed edit', async () => {
  await act(async () => root.render(<Harness />));
  let fail!: (error: Error) => void;
  const first = latest.withForeground(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const rejected = expect(first).rejects.toThrow('Import failed');
  const secondAction = vi.fn(() => 42);
  let second!: Promise<number>;
  await act(async () => {
    second = latest.withForeground(secondAction);
    await Promise.resolve();
  });
  expect(latest.foregroundBusy).toBe(true);
  expect(secondAction).not.toHaveBeenCalled();
  await act(async () => {
    fail(new Error('Import failed'));
    await rejected;
    expect(await second).toBe(42);
  });
  expect(secondAction).toHaveBeenCalledOnce();
  expect(latest.foregroundBusy).toBe(false);
});
it('cancels the exact job when a start reply is lost and lets it finish when the view closes', async () => {
  await act(async () => root.render(<Harness />));
  for (const viewClosed of [false, true]) {
    let finish!: () => void;
    let loseReply!: (error: unknown) => void;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.call.mockImplementation(async (method: string) => {
      if (method === 'subscriptions.prepareRun') return { job: 42 };
      if (method === 'subscriptions.status') return { version: 3, statuses: {}, error: null };
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        loseReply = reject;
        started();
      });
    });
    const signal = new AbortController();
    const cancelled = Object.assign(new Error('Subscription cancelled'), { code: 'CANCELLED' });
    if (!viewClosed) mocks.wait.mockRejectedValueOnce(cancelled);
    const running = latest.run(stash.groups[0].id, 'refresh', undefined, signal.signal);
    const result = viewClosed
      ? expect(running).resolves.toBeUndefined()
      : expect(running).rejects.toBe(cancelled);
    await starting;
    signal.abort(new DOMException('Closed', viewClosed ? 'ViewClosed' : 'AbortError'));
    if (viewClosed) {
      expect(mocks.progress).not.toHaveBeenCalled();
      finish();
    } else {
      expect(mocks.progress).toHaveBeenCalledExactlyOnceWith('subscriptions.cancel', { job: 42 });
      loseReply({ code: 'TIMEOUT' });
    }
    await result;
    expect(mocks.wait).toHaveBeenLastCalledWith(42, undefined);
    mocks.progress.mockClear();
  }
});
