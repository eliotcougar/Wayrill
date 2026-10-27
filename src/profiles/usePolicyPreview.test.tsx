// @vitest-environment jsdom
import { policyPreviewView } from './policyPreviewView';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import usePolicyPreview from './usePolicyPreview';
import { calculatePolicyPreview, type PolicyPreviewInput } from './policyPreview';
import { createPolicyExample } from '../graph/policyExample';
import { emptyPolicySources, readPolicySources, subscriptionSource } from '../graph/policySources';
import { importProfiles, type Stash } from './import';
let root: Root, container: HTMLDivElement;
class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Record<string, unknown>[] = [];
  terminated = false;
  listeners = new Set<(event: MessageEvent) => void>();
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: unknown, result: unknown) {
    const context = this.messages[0].context as { graph: import('../graph/types').GraphState };
    this.onmessage?.(
      new MessageEvent('message', {
        data: {
          id,
          result: policyPreviewView(
            context.graph,
            result as ReturnType<typeof calculatePolicyPreview>,
            { search: '', page: 0 },
          ),
        },
      }),
    );
  }
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.instances = [];
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const fixture = () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const group = importProfiles(
    'vless://public@a.example.net:443?security=tls#Public',
    'Large fixture',
  ).groups[0];
  group.entries = Array.from({ length: 501 }, (_, i) => ({ ...group.entries[0], id: String(i) }));
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,

    groups: [group],
  };
  const input: PolicyPreviewInput = {
    settings: { ...node.data.settings, selection: 'subscription' },
    sources: { ...emptyPolicySources(), subscriptions: [subscriptionSource(group)] },
    observer: graph.nodes.find((n) => n.data.kind === 'observatory')!,
    corePreview: false,
  };
  return { graph, node, stash, input };
};
it('keeps Apply blocked while pending and ignores late replies from an older filter', async () => {
  const f = fixture();
  let input = f.input,
    latest: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, f.stash, input, true);
    return <button disabled={latest.pending || !!latest.error}>Apply</button>;
  }
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('button')!.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0],
    first = worker.messages.at(-1)!;
  input = {
    ...input,
    sources: {
      ...input.sources,
      subscriptions: input.sources.subscriptions.map((s) => ({
        ...s,
        filter: { ...s.filter, name: 'Public' },
      })),
    },
  };
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const second = worker.messages.at(-1)!;
  const result = calculatePolicyPreview(f.graph, f.node, f.stash, input);
  await act(async () => worker.reply(first.id, result));
  expect(latest!.pending).toBe(true);
  await act(async () => worker.reply(second.id, result));
  expect(latest!.pending).toBe(false);
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect((second.input as PolicyPreviewInput).sources.subscriptions[0].entries).toEqual([]);
});
it('invalidates a completed preview when the stash context changes even if input is identical', async () => {
  const f = fixture();
  let stash = f.stash,
    latest: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, stash, f.input, true);
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  const first = FakeWorker.instances[0];
  await act(async () =>
    first.reply(first.messages.at(-1)!.id, calculatePolicyPreview(f.graph, f.node, stash, f.input)),
  );
  expect(latest!.pending).toBe(false);
  stash = { ...stash, groups: stash.groups.map((g) => ({ ...g, name: 'Renamed' })) };
  await act(async () => root.render(<Harness />));
  expect(first.terminated).toBe(true);
  expect(latest!.pending).toBe(true);
  const second = FakeWorker.instances[1];
  await act(async () => vi.advanceTimersByTime(100));
  await act(async () =>
    second.reply(
      second.messages.at(-1)!.id,
      calculatePolicyPreview(f.graph, f.node, stash, f.input),
    ),
  );
  expect(latest!.pending).toBe(false);
  expect(latest!.result!.subscriptions[0].name).toBe('Renamed');
});
it('collapses rapid edits into one request and terminates the worker on close', async () => {
  const f = fixture();
  let input = f.input;
  function Harness() {
    usePolicyPreview(f.graph, f.node, f.stash, input, true);
    return null;
  }
  await act(async () => root.render(<Harness />));
  for (const name of ['E', 'EU', 'EU Tokyo']) {
    input = {
      ...input,
      sources: {
        ...input.sources,
        subscriptions: input.sources.subscriptions.map((s) => ({
          ...s,
          filter: { ...s.filter, name },
        })),
      },
    };
    await act(async () => root.render(<Harness />));
  }
  await act(async () => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0];
  expect(worker.messages).toHaveLength(2);
  expect(
    (worker.messages[1].input as PolicyPreviewInput).sources.subscriptions[0].filter.name,
  ).toBe('EU Tokyo');
  await act(async () => root.render(null));
  expect(worker.terminated).toBe(true);
});
it('turns a worker failure or timeout into a blocking error', async () => {
  const f = fixture();
  let latest: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, f.stash, f.input, true);
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(60000));
  expect(latest!.pending).toBe(false);
  expect(latest!.error).toMatch(/timed out/);
});
it('keeps small drafts synchronous and preserves manual snapshots independently of refresh', async () => {
  const f = fixture(),
    stash = { ...f.stash, groups: [] };
  let latest: ReturnType<typeof usePolicyPreview>;
  const input = {
    ...f.input,
    settings: f.node.data.settings,
    sources: readPolicySources(f.node.data),
  };
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, stash, input, true);
    return null;
  }
  await act(async () => root.render(<Harness />));
  expect(FakeWorker.instances).toHaveLength(0);
  expect(latest!.result!.summary.total).toBe(2);
  expect(latest!.pending).toBe(false);
});

it('sends only a page query during search and requests the complete snapshot only on Save', async () => {
  const f = fixture();
  let latest!: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, f.stash, f.input, true);
    return null;
  }
  await act(() => root.render(<Harness />));
  await act(() => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0],
    full = calculatePolicyPreview(f.graph, f.node, f.stash, f.input);
  await act(() => worker.reply(worker.messages.at(-1)!.id, full));
  await act(() => latest.setQuery({ search: 'Public', page: 0 }));
  await act(() => vi.advanceTimersByTime(100));
  const query = worker.messages.at(-1)!;
  expect(query).toMatchObject({ query: { search: 'Public', page: 0 } });
  expect(query).not.toHaveProperty('input');
  await act(() => worker.reply(query.id, full));
  let pending!: Promise<unknown>;
  await act(() => {
    pending = latest.snapshot();
  });
  expect(worker.messages.at(-1)).toEqual({ commit: query.id });
  const snapshot = { sources: full.sources, serialized: full.serialized };
  await act(() => {
    for (const listener of worker.listeners)
      listener(new MessageEvent('message', { data: { commit: query.id, snapshot } }));
  });
  expect(await pending).toEqual(snapshot);
  expect(worker.listeners.size).toBe(0);
});
it('rejects an in-flight Save when the worker context is replaced', async () => {
  const f = fixture();
  let stash = f.stash,
    latest!: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, stash, f.input, true);
    return null;
  }
  await act(() => root.render(<Harness />));
  await act(() => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0],
    full = calculatePolicyPreview(f.graph, f.node, stash, f.input);
  await act(() => worker.reply(worker.messages.at(-1)!.id, full));
  let pending!: Promise<unknown>;
  await act(() => {
    pending = latest.snapshot();
  });
  const rejected = expect(pending).rejects.toThrow(/context changed/);
  stash = { ...stash };
  await act(() => root.render(<Harness />));
  await rejected;
  expect(worker.terminated).toBe(true);
  expect(worker.listeners.size).toBe(0);
});

it('rejects Save immediately if the preview worker crashes after a completed preview', async () => {
  const f = fixture();
  let latest!: ReturnType<typeof usePolicyPreview>;
  function Harness() {
    latest = usePolicyPreview(f.graph, f.node, f.stash, f.input, true);
    return null;
  }
  await act(() => root.render(<Harness />));
  await act(() => vi.advanceTimersByTime(100));
  const worker = FakeWorker.instances[0];
  await act(() =>
    worker.reply(
      worker.messages.at(-1)!.id,
      calculatePolicyPreview(f.graph, f.node, f.stash, f.input),
    ),
  );
  let rejected: string | undefined;
  const save = latest.snapshot().catch((error: Error) => {
    rejected = error.message;
  });
  expect(worker.listeners.size).toBe(1);
  await act(() => worker.onerror?.());
  expect(rejected).toMatch(/worker failed/i);
  expect(worker.listeners.size).toBe(0);
  await save;
});
