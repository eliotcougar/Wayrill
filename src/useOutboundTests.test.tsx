// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import useOutboundTests from './useOutboundTests';
import { serviceCall } from './serviceClient';
import { makeNode } from './graph/catalog';
import type { GraphState } from './graph/types';
import type { Stash } from './profiles/import';
import { createTestPlan, type TestPlanInput } from './outboundTestPlan';
import { createPolicyExample } from './graph/policyExample';
import OutboundTestResults from './components/OutboundTestResults';
vi.mock('./profiles/serviceSubscriptions', () => ({}));
vi.mock('./serviceClient', () => ({
  serviceCall: vi.fn(),
  desktopServiceAvailable: () => true,
  errorText: (e: unknown) => String(e),
}));
let root: Root, host: HTMLDivElement, latest: ReturnType<typeof useOutboundTests>;
const graph: GraphState = {
  name: 'test',
  nodes: [makeNode('direct-outbound', { x: 0, y: 0 }, 'direct')],
  edges: [],
};
const stash: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
const workers: FakeWorker[] = [];
class FakeWorker {
  static failSend = false;
  static realPlans = false;
  prepared?: ReturnType<typeof createTestPlan>;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(message: { input?: unknown; ids?: string[] }) {
    if (FakeWorker.failSend) throw new DOMException('Cannot clone draft', 'DataCloneError');
    if (message.input && FakeWorker.realPlans)
      this.prepared = createTestPlan(message.input as TestPlanInput);
    const reply = this.prepared
      ? message.input
        ? { plan: this.prepared.plan }
        : { batch: this.prepared.batch(message.ids ?? []) }
      : message.input
        ? {
            plan: {
              rows: [
                {
                  key: 'node:direct',
                  name: 'Direct',
                  kind: 'direct-outbound',
                  targets: ['test-1'],
                },
              ],
              targets: [{ id: 'test-1', name: 'Direct' }],
            },
          }
        : {
            batch: [
              {
                id: 'test-1',
                outboundTag: 'direct',
                config: { outbounds: [{ tag: 'direct', protocol: 'freedom' }] },
              },
            ],
          };
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: reply } as MessageEvent);
    });
  }
  terminate() {
    this.terminated = true;
  }
}
function Probe({ g = graph, show = false }: { g?: GraphState; show?: boolean }) {
  latest = useOutboundTests(g, stash);
  return show && latest.open ? <OutboundTestResults tests={latest} /> : null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('Worker', FakeWorker);
  localStorage.clear();
  vi.mocked(serviceCall).mockReset();
  workers.length = 0;
  FakeWorker.failSend = false;
  FakeWorker.realPlans = false;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
it('retests both measurements in-place and keeps the dialog, other results and individual members', async () => {
  FakeWorker.realPlans = true;
  let round = 0;
  vi.mocked(serviceCall).mockImplementation(async (_method, params) => ({
    job: ++round,
    busy: false,
    cancelled: false,
    results: (params!.targets as { id: string }[]).map((target) => ({
      id: target.id,
      latencyMs: 10 * round,
      ip: '203.0.113.1',
      country: 'FI',
      error: null,
      countryError: null,
      ...(params!.mode === 'speed'
        ? { speed: { bytesPerSecond: round * 1_000_000, bytes: 5_000_000, elapsedMs: 5000 } }
        : { udp: { reachable: true, error: null } }),
    })),
  }));
  await act(() => root.render(<Probe g={createPolicyExample()} show />));
  await act(() => latest.start());
  const dialog = host.querySelector('dialog')!;
  const clicked = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const latency = latest.records.latency.results;
  await act(() => clicked('Speed test Test policy group').click());
  expect(host.querySelector('dialog')).toBe(dialog);
  expect(latest.records.latency.results).toBe(latency);
  expect(latest.speedSummaries.get('node:test-group')?.text).toBe('16.00 Mbit/s');
  expect(host.textContent).toContain('Avg 10 ms');
  expect(host.textContent).toContain('16.00 Mbit/s');
  const groupSpeed = latest.records.speed.results;
  await act(() => clicked('Test delay / UDP for Test destination A').click());
  expect(latest.records.speed.results).toBe(groupSpeed);
  expect(latest.summaries.get('node:test-first')?.text).toBe('30 ms');
  expect(latest.summaries.get('node:test-second')?.text).toBe('10 ms');
  await act(() => {
    const select = host.querySelector('select')!;
    select.value = 'unique';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Both the two latency members and the speed-tested policy route remain visible.
  expect(host.querySelectorAll('[role="row"]')).toHaveLength(4);
  await act(() => clicked('Speed test Test destination B').click());
  const request = vi.mocked(serviceCall).mock.calls.at(-1)![1]!;
  expect(request.targets).toHaveLength(1);
  const config = (request.targets as { config: { outbounds: { protocol: string }[] } }[])[0].config;
  expect(config.outbounds.map((o) => o.protocol)).toEqual(['freedom']);
  expect(latest.speedSummaries.get('node:test-group')?.text).toBe('16.00 Mbit/s');
  expect(latest.speedSummaries.get('node:test-second')?.text).toBe('32.00 Mbit/s');
  expect(latest.records.latency.results.size).toBe(2);
  expect(host.querySelector('dialog')).toBe(dialog);
});
it('cleans up a failed worker submission immediately and permits a later test', async () => {
  vi.useFakeTimers();
  await act(() => root.render(<Probe />));
  FakeWorker.failSend = true;
  await act(() => latest.start());
  expect(latest.error).toContain('Cannot clone draft');
  expect(latest.busy).toBe(false);
  expect(workers[0].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(serviceCall).not.toHaveBeenCalled();
  FakeWorker.failSend = false;
  vi.mocked(serviceCall).mockResolvedValue({
    job: 4,
    busy: false,
    results: [],
    cancelled: false,
  });
  await act(async () => {
    const running = latest.start();
    await vi.runAllTimersAsync();
    await running;
  });
  expect(latest.error).toBe('');
  expect(latest.busy).toBe(false);
  expect(workers[1].terminated).toBe(true);
  expect(serviceCall).toHaveBeenCalledWith('outbounds.testStart', expect.anything());
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('uses isolated service jobs and retains results during node movement', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    job: 1,
    busy: false,
    cancelled: false,
    results: [
      {
        id: 'test-1',
        latencyMs: 25,
        ip: '203.0.113.1',
        country: 'FI',
        error: null,
        countryError: null,
      },
    ],
  });
  await act(() => root.render(<Probe />));
  await act(() =>
    latest.settings.save({
      ...latest.settings.value,
      testUrl: 'https://test.example/health',
      countryUrl: '',
    }),
  );
  await act(() => latest.start());
  expect(serviceCall).toHaveBeenCalledWith(
    'outbounds.testStart',
    expect.objectContaining({
      testUrl: 'https://test.example/health',
      countryUrl: '',
    }),
  );
  expect(latest.summaries.get('node:direct')).toMatchObject({
    text: '25 ms',
    title: '203.0.113.1 · FI',
  });
  await act(() =>
    root.render(
      <Probe
        g={{
          ...graph,
          nodes: graph.nodes.map((n) => ({ ...n, position: { x: 50, y: 60 } })),
        }}
      />,
    ),
  );
  expect(latest.results.size).toBe(1);
  expect(workers[0].terminated).toBe(true);
  await act(() =>
    root.render(
      <Probe
        g={{
          ...graph,
          nodes: graph.nodes.map((n) => ({
            ...n,
            data: {
              ...n.data,
              settings: { ...n.data.settings, redirect: '127.0.0.1:8000' },
            },
          })),
        }}
      />,
    ),
  );
  expect(latest.results.size).toBe(0);
});
it.each(['latency', 'speed'] as const)(
  'cancels the owned %s job and cannot publish a late completed result',
  async (mode) => {
    let finish: ((v: unknown) => void) | undefined;
    vi.mocked(serviceCall).mockImplementation((method) =>
      method === 'outbounds.testStart'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ job: 3, busy: false, results: [] }),
    );
    await act(() => root.render(<Probe />));
    let pending: Promise<void>;
    await act(async () => {
      pending = latest.start(undefined, undefined, mode);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(finish).toBeDefined();
    await act(() => latest.cancel());
    await act(async () => {
      finish!({
        job: 3,
        busy: false,
        results: [{ id: 'test-1', latencyMs: 999 }],
        cancelled: false,
      });
      await pending!;
    });
    expect(serviceCall).toHaveBeenCalledWith('outbounds.testCancel', {
      job: 3,
    });
    expect(latest.results.size).toBe(0);
    expect(latest.busy).toBe(false);
  },
);
it('retains independent latency/speed results and opens the requested result set', async () => {
  vi.mocked(serviceCall).mockImplementation(async (method, params) => ({
    job: 12,
    busy: false,
    cancelled: false,
    results:
      method === 'outbounds.testStart'
        ? [
            {
              id: 'test-1',
              latencyMs: params?.mode === 'speed' ? null : 25,
              ip: null,
              country: null,
              error: null,
              countryError: null,
              ...(params?.mode === 'speed'
                ? {
                    speed: {
                      bytesPerSecond: 1_000_000,
                      bytes: 5_000_000,
                      elapsedMs: 5000,
                    },
                  }
                : {}),
            },
          ]
        : [],
  }));
  await act(() => root.render(<Probe />));
  await act(() =>
    latest.settings.save({
      ...latest.settings.value,
      speedUrl: 'https://download.example/custom.bin',
    }),
  );
  await act(() => latest.start());
  await act(() => latest.start(undefined, ['direct'], 'speed'));
  expect(serviceCall).toHaveBeenCalledWith(
    'outbounds.testStart',
    expect.objectContaining({
      mode: 'speed',
      speedUrl: 'https://download.example/custom.bin',
    }),
  );
  expect(latest.speedSummaries.get('node:direct')?.text).toBe('8.00 Mbit/s');
  expect(latest.summaries.get('node:direct')?.text).toBe('25 ms');
  await act(() => latest.show('latency'));
  expect(latest.results.get('test-1')?.latencyMs).toBe(25);
  await act(() => latest.show('speed'));
  expect(latest.results.get('test-1')?.speed?.bytes).toBe(5_000_000);
  await act(() => root.render(<Probe g={{ ...graph, nodes: [] }} />));
  expect(latest.summaries.size).toBe(0);
  expect(latest.speedSummaries.size).toBe(0);
});
it('adds the speed default to existing settings and validates manually entered download URLs', async () => {
  localStorage.setItem(
    'wayrill.outboundTest.settings',
    JSON.stringify({ testUrl: 'https://probe.example/custom', countryUrl: '' }),
  );
  await act(() => root.render(<Probe />));
  expect(latest.settings.value.testUrl).toBe('https://probe.example/custom');
  expect(latest.settings.value.speedUrl).toContain('speed.cloudflare.com');
  expect(() =>
    latest.settings.save({
      ...latest.settings.value,
      speedUrl: 'file:///secret',
    }),
  ).toThrow(/HTTP/);
  await act(() =>
    latest.settings.save({
      ...latest.settings.value,
      speedUrl: 'https://download.example/custom',
    }),
  );
  expect(JSON.parse(localStorage.getItem('wayrill.outboundTest.settings')!).speedUrl).toBe(
    'https://download.example/custom',
  );
});

it('requests UDP alongside latency only when enabled, with separate results and no UDP in speed jobs', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    job: 5,
    busy: false,
    results: [
      {
        id: 'test-1',
        latencyMs: 25,
        ip: null,
        country: null,
        error: null,
        countryError: null,
        udp: {
          reachable: false,
          error: 'No valid UDP reply within 5 seconds.',
        },
      },
    ],
    cancelled: false,
  });
  await act(() => root.render(<Probe />));
  expect(latest.settings.value.udpEnabled).toBe(false);
  await act(() => latest.start());
  expect(vi.mocked(serviceCall).mock.calls[0][1]).not.toHaveProperty('udpUrl');
  await act(() =>
    latest.settings.save({
      ...latest.settings.value,
      udpEnabled: true,
      udpUrl: 'dns://9.9.9.9:9953',
    }),
  );
  await act(() => latest.start());
  expect(serviceCall).toHaveBeenLastCalledWith(
    'outbounds.testStart',
    expect.objectContaining({ udpUrl: 'dns://9.9.9.9:9953' }),
  );
  expect(latest.summaries.get('node:direct')).toMatchObject({
    text: '25 ms',
    udp: { reachable: false },
  });
  expect(JSON.parse(localStorage.getItem('wayrill.outboundTest.settings')!).udpEnabled).toBe(true);
  await act(() => latest.start(undefined, undefined, 'speed'));
  expect(vi.mocked(serviceCall).mock.lastCall?.[1]).not.toHaveProperty('udpUrl');
});
it('drains a foreground job after a polling error before clearing its busy state', async () => {
  vi.useFakeTimers();
  let polled = false;
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'outbounds.testStart') return { job: 8, busy: true, results: [] };
    if (method === 'outbounds.testCancel') return { job: 8, busy: true, results: [] };
    if (!polled) {
      polled = true;
      throw new Error('Transient poll failure');
    }
    return { job: 8, busy: false, results: [] };
  });
  await act(async () => root.render(<Probe />));
  let work!: Promise<void>;
  await act(async () => {
    work = latest.start();
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(latest.error).toContain('Transient poll failure');
  expect(latest.busy).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
    await work;
  });
  expect(latest.busy).toBe(false);
  expect(workers[0].terminated).toBe(true);
});
it.each(['latency', 'speed'] as const)(
  'retains other %s results and policy summaries when retesting one server, including after preparation fails',
  async (mode) => {
    FakeWorker.realPlans = true;
    let round = 0;
    vi.mocked(serviceCall).mockImplementation(async (_method, params) => {
      round++;
      return {
        job: round,
        busy: false,
        cancelled: false,
        results: (params!.targets as { id: string }[]).map((target, index) => ({
          id: target.id,
          latencyMs: round === 1 ? 20 + index * 10 : 99,
          ip: '203.0.113.1',
          country: 'FI',
          error: null,
          countryError: null,
          ...(mode === 'speed'
            ? {
                speed: {
                  bytesPerSecond: round === 1 ? 1_000_000 + index : 9_000_000,
                  bytes: 5_000_000,
                  elapsedMs: 5000,
                },
              }
            : {
                udp: {
                  reachable: round === 1,
                  error: round === 1 ? null : 'No UDP reply.',
                },
              }),
        })),
      };
    });
    await act(() => root.render(<Probe g={createPolicyExample()} />));
    await act(() => latest.start(undefined, undefined, mode));
    const summaries = () => (mode === 'speed' ? latest.speedSummaries : latest.summaries);
    const first = summaries().get('node:test-first');
    const group = summaries().get('node:test-group');
    expect(first?.state).toBe('passed');
    expect(group?.state).toBe('passed');
    const firstTarget = latest.plan!.rows.find((row) => row.key === 'node:test-first')!.targets[0];
    const firstResult = latest.results.get(firstTarget);
    await act(() => latest.start(undefined, ['test-second'], mode));
    expect(summaries().get('node:test-first')).toEqual(first);
    expect(latest.results.get(firstTarget)).toEqual(firstResult);
    expect(latest.plan!.rows.filter((row) => !row.hidden)).toHaveLength(3);
    if (mode === 'latency') {
      expect(summaries().get('node:test-second')).toMatchObject({
        text: '99 ms',
        udp: { reachable: false },
      });
      expect(summaries().get('node:test-group')).toMatchObject({
        text: 'Avg 60 ms · 2/2 live',
        udp: { reachable: false },
      });
    } else {
      expect(summaries().get('node:test-second')?.text).toBe('72.00 Mbit/s');
      expect(summaries().get('node:test-group')).toEqual(group);
    }
    const completed = latest.results;
    FakeWorker.failSend = true;
    await act(() => latest.start(undefined, ['test-second'], mode));
    expect(latest.error).toContain('Cannot clone draft');
    expect(latest.results).toBe(completed);
    expect(summaries().get('node:test-first')).toEqual(first);
  },
);
