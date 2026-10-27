import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseImport } from './importClient';
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  terminate() {
    this.terminated = true;
  }
}
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('terminates a cancelled import and clears its handlers and timeout', async () => {
  const controller = new AbortController();
  const result = parseImport('public fixture', 'Public', false, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  const worker = FakeWorker.instances[0];
  controller.abort();
  await rejected;
  expect(worker.terminated).toBe(true);
  expect(worker.onmessage).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not start a worker for an already cancelled import', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(parseImport('', '', false, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(FakeWorker.instances).toHaveLength(0);
});
it('cleans up both successful strict-stash parsing and a failed worker dispatch', async () => {
  const parsed = parseImport('public fixture', 'Public', true);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledWith({
    text: 'public fixture',
    name: 'Public',
    stashOnly: true,
  });
  const fixture = { groups: [], duplicates: 0, rejected: 0, problems: [] };
  worker.onmessage!(new MessageEvent('message', { data: { result: fixture } }));
  expect(await parsed).toBe(fixture);
  expect(worker.terminated).toBe(true);
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      constructor() {
        super();
        this.postMessage.mockImplementation(() => {
          throw new Error('Cannot clone');
        });
      }
    },
  );
  await expect(parseImport('', '')).rejects.toThrow('Cannot clone');
  expect(FakeWorker.instances[1].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
