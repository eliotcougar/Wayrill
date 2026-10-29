// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useGraphAnalysis from './useGraphAnalysis';
import { emptyAnalysis } from './graph/analysis';
import { importXrayConfig } from './graph/xrayImport';
import type { GraphState } from './graph/types';
class FakeWorker {
  static instances: FakeWorker[] = [];
  static fails = false;
  messages: { id: number; graph: GraphState }[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    if (FakeWorker.fails) throw new Error('Unavailable');
    FakeWorker.instances.push(this);
  }
  postMessage(message: { id: number; graph: GraphState }) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: number, warning: string) {
    this.onmessage?.(
      new MessageEvent('message', {
        data: {
          id,
          result: { ...emptyAnalysis(), issues: [{ severity: 'warning', message: warning }] },
        },
      }),
    );
  }
}
let root: Root, graph: GraphState, latest: ReturnType<typeof useGraphAnalysis>;
function Harness() {
  latest = useGraphAnalysis(graph);
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.instances = [];
  FakeWorker.fails = false;
  graph = importXrayConfig(
    JSON.stringify({
      outbounds: Array.from({ length: 502 }, (_, i) => ({
        tag: `candidate-${i}`,
        protocol: 'freedom',
      })),
      routing: { balancers: [{ tag: 'pool', selector: ['candidate-'] }] },
    }),
  );
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('never exposes an older analysis for a newly edited draft', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0],
    first = worker.messages[0];
  graph = { ...graph, name: 'Changed' };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  expect(worker.terminated).toBe(true);
  const current = FakeWorker.instances[1],
    second = current.messages[0];
  await act(async () => worker.reply(first.id, 'Old issue'));
  expect(latest.pending).toBe(true);
  expect(latest.issues).toEqual([]);
  expect(latest.compilation).toBeNull();
  await act(async () => current.reply(second.id, 'Current issue'));
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].message).toBe('Current issue');
  graph = { ...graph, name: 'Changed again' };
  await act(async () => root.render(<Harness />));
  expect(latest.pending).toBe(true);
  expect(latest.issues).toEqual([]);
});
it('collapses rapid edits, terminates owned workers and ignores late timed-out results', async () => {
  await act(async () => root.render(<Harness />));
  for (const name of ['A', 'B', 'C']) {
    graph = { ...graph, name };
    await act(async () => root.render(<Harness />));
  }
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0];
  expect(worker.messages).toHaveLength(1);
  expect(worker.messages[0].graph.name).toBe('C');
  await act(async () => vi.advanceTimersByTime(60000));
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].severity).toBe('error');
  expect(worker.terminated).toBe(true);
  await act(async () => worker.reply(worker.messages[0].id, 'Late success'));
  expect(latest.issues[0].message).toMatch(/timed out/);
  graph = { ...graph, name: 'Retry after timeout' };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const retry = FakeWorker.instances[1];
  await act(async () => retry.reply(retry.messages[0].id, 'Recovered'));
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].message).toBe('Recovered');
  await act(async () => root.render(null));
  expect(retry.terminated).toBe(true);
});
it('reports worker startup failures for every subsequent draft instead of hanging or enabling run controls', async () => {
  FakeWorker.fails = true;
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].severity).toBe('error');
  graph = { ...graph, name: 'Edited after failure' };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  expect(latest.pending).toBe(false);
  expect(latest.compilation).toBeNull();
  FakeWorker.fails = false;
  graph = { ...graph, name: 'Recovered worker creation' };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0];
  await act(async () => worker.reply(worker.messages[0].id, 'Recovered'));
  expect(latest.issues[0].message).toBe('Recovered');
});

it('retires a crashed worker and recovers on the next draft', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0];
  await act(async () => worker.onerror?.());
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].message).toMatch(/failed/);
  expect(worker.terminated).toBe(true);
  graph = { ...graph, name: 'Retry after crash' };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const retry = FakeWorker.instances[1];
  await act(async () => retry.reply(retry.messages[0].id, 'Recovered'));
  expect(latest.pending).toBe(false);
  expect(latest.issues[0].message).toBe('Recovered');
});
