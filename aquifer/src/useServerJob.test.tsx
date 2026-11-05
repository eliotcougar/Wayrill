// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActionRequest, RemoteClient, ServerJob } from './remoteClient';
import { useServerJob } from './useServerJob';

const session = 'Example';
const storageKey = 'wayrill.remote.job.' + session;
const hour = 60 * 60 * 1000;
const request: ActionRequest = { id: 'a'.repeat(32), action: 'refreshApt' };
let host: HTMLDivElement, root: Root;
let client: RemoteClient;
let onFinished = vi.fn<() => void>();
let operation: ReturnType<typeof useServerJob>;

function progress(state: ServerJob['state'], age = 0): ServerJob {
  return {
    ...request,
    version: 1,
    state,
    stage: state === 'running' ? 'Downloading' : 'Completed',
    percent: state === 'running' ? 50 : 100,
    message: '',
    logs: ['Package output'],
    createdAt: (Date.now() - 2 * hour) / 1000,
    updatedAt: (Date.now() - age) / 1000,
    bootId: 'boot',
  };
}
function Harness() {
  operation = useServerJob(client, session, onFinished);
  return <>{operation.job?.stage}</>;
}
async function mount() {
  await act(async () => root.render(<Harness />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  localStorage.clear();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = { startAction: vi.fn(), pollAction: vi.fn() } as unknown as RemoteClient;
  onFinished = vi.fn<() => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('expires a completed result after one hour, including its saved pointer', async () => {
  await mount();
  vi.mocked(client.startAction).mockImplementation(async (_session, next) => ({
    ...progress('succeeded'),
    id: next.id,
  }));
  await act(async () => operation.start({ action: 'refreshApt' }));
  expect(operation.job?.state).toBe('succeeded');
  expect(JSON.parse(localStorage.getItem(storageKey)!).expiresAt).toBe(Date.now() + hour);
  await act(async () => vi.advanceTimersByTimeAsync(hour - 1));
  expect(operation.job?.state).toBe('succeeded');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(operation.request).toBeNull();
  expect(operation.job).toBeNull();
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(onFinished).toHaveBeenCalledTimes(1);
});

it('does not reconnect to a locally expired result', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ ...request, expiresAt: Date.now() - 1 }));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(operation.request).toBeNull();
  expect(operation.active).toBe(false);
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(client.pollAction).not.toHaveBeenCalled();
  expect(client.startAction).not.toHaveBeenCalled();
});

it.each(['succeeded', 'failed', 'interrupted'] as const)(
  'releases an old %s result saved by a previous app without redisplaying it',
  async (state) => {
    localStorage.setItem(storageKey, JSON.stringify(request));
    vi.mocked(client.pollAction).mockResolvedValue(progress(state, hour + 1000));
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(operation.request).toBeNull();
    expect(operation.job).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(onFinished).not.toHaveBeenCalled();
    expect(client.startAction).not.toHaveBeenCalled();
  },
);

it('keeps monitoring a running job even when its last progress is older than one hour', async () => {
  localStorage.setItem(storageKey, JSON.stringify(request));
  vi.mocked(client.pollAction).mockResolvedValue(progress('running', 3 * hour));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(operation.job?.state).toBe('running');
  expect(operation.active).toBe(true);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(request);
  expect(client.startAction).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
});

it('retains a recent result only for the remaining hour after server completion', async () => {
  localStorage.setItem(storageKey, JSON.stringify(request));
  vi.mocked(client.pollAction).mockResolvedValue(progress('failed', hour / 2));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(operation.job?.state).toBe('failed');
  await act(async () => vi.advanceTimersByTimeAsync(hour / 2 - 1000));
  expect(operation.request).toBeNull();
  expect(client.startAction).not.toHaveBeenCalled();
});

it('strips local expiry metadata before retrying a request', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ ...request, expiresAt: Date.now() + hour }));
  vi.mocked(client.startAction).mockResolvedValue(progress('running'));
  await mount();
  await act(async () => operation.retryRequest());
  expect(client.startAction).toHaveBeenCalledWith(session, request);
  expect(localStorage.getItem(storageKey)).not.toContain('expiresAt');
});
