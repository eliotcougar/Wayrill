import { afterEach, expect, it, vi } from 'vitest';
import { EdgeRoutingClient } from './edgeRoutingClient';
const geometry = { edges: [], nodes: [] };
class WorkerStub {
  onmessage?: (event: { data: { id: number; paths: []; error?: string } }) => void;
  onerror?: (event: { preventDefault: () => void }) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
}
afterEach(() => vi.useRealTimers());
it('coalesces pending layouts, recovers from timeout and disposes scheduled work', () => {
  vi.useFakeTimers();
  const workers: WorkerStub[] = [];
  const client = new EdgeRoutingClient(() => {
    const w = new WorkerStub();
    workers.push(w);
    return w as unknown as Worker;
  }, 1000);
  const first = vi.fn(),
    stale = vi.fn(),
    latest = vi.fn();
  client.request(geometry, first);
  vi.advanceTimersByTime(80);
  client.request(geometry, stale);
  client.request(geometry, latest);
  vi.advanceTimersByTime(80);
  expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(920);
  expect(first.mock.calls[0][1]).toContain('timed out');
  expect(stale).not.toHaveBeenCalled();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  // A terminated worker can still have a queued browser event. Its handlers
  // must not fail the replacement transaction.
  workers[0].onerror?.({ preventDefault: vi.fn() });
  workers[0].onmessageerror?.();
  expect(latest).not.toHaveBeenCalled();
  expect(workers[1].terminate).not.toHaveBeenCalled();
  const id = workers[1].postMessage.mock.calls[0][0].id;
  workers[1].onmessage?.({ data: { id, paths: [] } });
  expect(latest).toHaveBeenCalledOnce();
  client.request(geometry, vi.fn());
  client.dispose();
  vi.runAllTimers();
  expect(workers[1].postMessage).toHaveBeenCalledOnce();
  expect(workers[1].terminate).toHaveBeenCalledOnce();
});
it('ignores stale replies and retries after a worker failure', () => {
  vi.useFakeTimers();
  const workers: WorkerStub[] = [];
  const client = new EdgeRoutingClient(() => {
    const worker = new WorkerStub();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const complete = vi.fn();
  client.request(geometry, complete);
  vi.advanceTimersByTime(80);
  const worker = workers[0];
  worker.onmessage?.({ data: { id: 999, paths: [] } });
  expect(complete).not.toHaveBeenCalled();
  worker.onerror?.({ preventDefault: vi.fn() });
  expect(complete.mock.calls[0][1]).toContain('failed');
  client.request(geometry, complete);
  vi.advanceTimersByTime(80);
  expect(workers).toHaveLength(2);
  const replacement = workers[1];
  replacement.onmessage?.({ data: { id: replacement.postMessage.mock.calls[0][0].id, paths: [] } });
  expect(complete).toHaveBeenCalledTimes(2);
  client.dispose();
});

it('continues routing during uninterrupted pointer movement rather than debouncing until release', () => {
  vi.useFakeTimers();
  const worker = new WorkerStub();
  const client = new EdgeRoutingClient(() => worker as unknown as Worker);
  const completed = vi.fn();
  let replied = 0;
  for (let frame = 0; frame < 50; frame++) {
    client.request(
      { edges: [], nodes: [{ id: 'moving', x: frame, y: 0, width: 100, height: 80 }] },
      completed,
    );
    vi.advanceTimersByTime(10);
    const message = worker.postMessage.mock.calls.at(-1)?.[0];
    if (message && message.id !== replied) {
      replied = message.id;
      worker.onmessage?.({ data: { id: message.id, paths: [] } });
    }
  }
  expect(worker.postMessage.mock.calls.length).toBeGreaterThanOrEqual(20);
  expect(worker.postMessage.mock.calls.length).toBeLessThanOrEqual(32);
  vi.advanceTimersByTime(16);
  expect(worker.postMessage.mock.calls.at(-1)?.[0].nodes[0].x).toBe(49);
  client.dispose();
});

it('retains only the newest pending frame while a slow transaction runs', () => {
  vi.useFakeTimers();
  const worker = new WorkerStub();
  const client = new EdgeRoutingClient(() => worker as unknown as Worker);
  const complete = vi.fn();
  client.request(geometry, complete);
  vi.advanceTimersByTime(16);
  for (let frame = 0; frame < 100; frame++) {
    client.request(
      { edges: [], nodes: [{ id: 'moving', x: frame, y: 0, width: 100, height: 80 }] },
      complete,
    );
    vi.advanceTimersByTime(10);
  }
  expect(worker.postMessage).toHaveBeenCalledOnce();
  worker.onmessage?.({ data: { id: worker.postMessage.mock.calls[0][0].id, paths: [] } });
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.postMessage.mock.calls[1][0].nodes[0].x).toBe(99);
  worker.onmessage?.({ data: { id: worker.postMessage.mock.calls[1][0].id, paths: [] } });
  expect(complete).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(500);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  client.dispose();
});
