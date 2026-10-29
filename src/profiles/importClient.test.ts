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
