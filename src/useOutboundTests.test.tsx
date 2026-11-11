// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import useOutboundTests from './useOutboundTests';
import { serviceCall } from './serviceClient';
import { makeNode } from './graph/catalog';
import type { GraphState } from './graph/types';
import { type Stash } from './profiles/import';
import { createTestPlan, type TestSelection } from './outboundTestPlan';
import { stageOutboundTests } from './profiles/serviceSubscriptions';
import { parseGraph } from './graph/model';
import { parseStash } from './profiles/import';
import { findStashEntry } from './profiles/stashModel';
import type { StashLink } from './graph/types';
import { createPolicyExample } from './graph/policyExample';
import OutboundTestResults from './components/OutboundTestResults';
vi.mock('./profiles/serviceSubscriptions', () => ({ stageOutboundTests: vi.fn() }));
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
function respondToTests(
  result: (id: string, round: number, index: number, mode: string) => unknown,
) {
  let round = 0;
  let reply: Record<string, unknown>;
  let batch: ReturnType<ReturnType<typeof createTestPlan>['batch']> = [];
  vi.mocked(serviceCall).mockImplementation(async (method, params) => {
    if (method !== 'outbounds.testPlanStart') {
      expect(method).toBe('outbounds.testGet');
      return reply;
    }
    round++;
    const draft = vi.mocked(stageOutboundTests).mock.lastCall![0] as {
      graph: string;
      stash: string;
      nodeIds?: string[];
      entries?: StashLink[];
      selection?: TestSelection;
    };
    const mode = (params!.settings as { mode: 'speed' | 'latency' }).mode;
    const library = parseStash(draft.stash);
    const prepared = createTestPlan({
      ...draft,
      graph: parseGraph(draft.graph),
      stash: library,
      entries: draft.entries?.map((link) => findStashEntry(library, link)!),
      mode,
    });
    const { rows, targets } = prepared.plan;
    batch = prepared.batch(targets.map(({ id }) => id));
    const status = {
      job: round,
      busy: false,
      cancelled: false,
      planReady: true,
      totalRows: rows.length,
      total: targets.length,
      completed: targets.length,
    };
    reply = {
      ...status,
      rows,
      targets,
      results: targets.map(({ id }, i) => result(id, round, i, mode)),
    };
    return { ...status, results: [] };
  });
  return () => batch;
}
function Probe({
  g = graph,
  s = stash,
  show = false,
}: {
  g?: GraphState;
  s?: Stash;
  show?: boolean;
}) {
  latest = useOutboundTests(g, s);
  return show && latest.open ? <OutboundTestResults tests={latest} /> : null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.mocked(serviceCall).mockReset();
  vi.mocked(stageOutboundTests).mockReset().mockResolvedValue('staged-test-draft');
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
it('retests both measurements in-place and keeps the dialog, other results and individual members', async () => {
  const batch = respondToTests((id, round, _index, mode) => ({
    id,
    latencyMs: 10 * round,
    ip: '203.0.113.1',
    country: 'FI',
    error: null,
    countryError: null,
    ...(mode === 'speed'
      ? { speed: { bytesPerSecond: round * 1_000_000, bytes: 5_000_000, elapsedMs: 5000 } }
      : { udp: { reachable: true, error: null } }),
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
  expect(batch()).toHaveLength(1);
  const config = batch()[0].config as { outbounds: { protocol: string }[] };
  expect(config.outbounds.map((o) => o.protocol)).toEqual(['freedom']);
  expect(latest.speedSummaries.get('node:test-group')?.text).toBe('16.00 Mbit/s');
  expect(latest.speedSummaries.get('node:test-second')?.text).toBe('32.00 Mbit/s');
  expect(latest.records.latency.results.size).toBe(2);
  expect(host.querySelector('dialog')).toBe(dialog);
});
it('cleans up a failed draft upload immediately and permits a later test', async () => {
  vi.useFakeTimers();
  await act(() => root.render(<Probe />));
  vi.mocked(stageOutboundTests).mockRejectedValueOnce(new Error('Cannot upload draft'));
  await act(() => latest.start());
  expect(latest.error).toContain('Cannot upload draft');
  expect(latest.busy).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(serviceCall).not.toHaveBeenCalled();
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
  expect(serviceCall).toHaveBeenCalledWith('outbounds.testPlanStart', expect.anything());
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(['latency', 'speed'] as const)(
  'cancels the owned %s job and cannot publish a late completed result',
  async (mode) => {
    let finish: ((v: unknown) => void) | undefined;
    vi.mocked(serviceCall).mockImplementation((method) =>
      method === 'outbounds.testPlanStart'
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

it('requests UDP alongside latency only when enabled, with separate results and no UDP in speed jobs', async () => {
  respondToTests((id) => ({
    id,
    latencyMs: 25,
    ip: null,
    country: null,
    error: null,
    countryError: null,
    udp: {
      reachable: false,
      error: 'No valid UDP reply within 5 seconds.',
    },
  }));
  await act(() => root.render(<Probe />));
  expect(latest.settings.value.udpEnabled).toBe(false);
  await act(() => latest.start());
  expect(vi.mocked(serviceCall).mock.calls[0][1]!.settings).not.toHaveProperty('udpUrl');
  await act(() =>
    latest.settings.save({
      ...latest.settings.value,
      udpEnabled: true,
      udpUrl: 'dns://9.9.9.9:9953',
    }),
  );
  await act(() => latest.start());
  expect(serviceCall).toHaveBeenCalledWith(
    'outbounds.testPlanStart',
    expect.objectContaining({
      settings: expect.objectContaining({ udpUrl: 'dns://9.9.9.9:9953' }),
    }),
  );
  expect(latest.summaries.get('node:direct')).toMatchObject({
    text: '25 ms',
    udp: { reachable: false },
  });
  expect(JSON.parse(localStorage.getItem('wayrill.outboundTest.settings')!).udpEnabled).toBe(true);
  await act(() => latest.start(undefined, undefined, 'speed'));
  const [, lastStart] = vi
    .mocked(serviceCall)
    .mock.calls.filter(([m]) => m === 'outbounds.testPlanStart')
    .at(-1)!;
  expect(lastStart!.settings).not.toHaveProperty('udpUrl');
});
it('drains a foreground job after a polling error before clearing its busy state', async () => {
  vi.useFakeTimers();
  let polled = false;
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'outbounds.testPlanStart') return { job: 8, busy: true, results: [] };
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
});

it('reads the final plan and results across multiple pages from one service job', async () => {
  const targets = Array.from({ length: 301 }, (_, i) => ({ id: `test-${i}`, name: `Server ${i}` }));
  const rows = targets.map(({ id, name }) => ({
    key: `node:${id}`,
    name,
    kind: 'outbound',
    targets: [id],
  }));
  const results = targets.map(({ id }, latencyMs) => ({ id, latencyMs }));
  const completed = {
    job: 9,
    busy: false,
    planReady: true,
    total: targets.length,
    totalRows: rows.length,
    completed: results.length,
    cancelled: false,
  };
  vi.mocked(serviceCall).mockImplementation(async (method, params) => {
    if (method === 'outbounds.testPlanStart') return { ...completed, results: [] };
    expect(method).toBe('outbounds.testGet');
    const { job, offset, rowOffset, targetOffset } = params as Record<string, number>;
    expect(job).toBe(completed.job);
    return {
      ...completed,
      results: results.slice(offset, offset + 128),
      rows: rowOffset === undefined ? undefined : rows.slice(rowOffset, rowOffset + 256),
      targets:
        targetOffset === undefined ? undefined : targets.slice(targetOffset, targetOffset + 256),
    };
  });
  await act(() => root.render(<Probe />));
  await act(() => latest.start());
  expect(latest.plan).toEqual({ targets, rows: rows.map((row) => ({ ...row, hidden: false })) });
  expect([...latest.results.keys()]).toEqual(targets.map(({ id }) => id));
  expect(latest.status).toBe('301 outbounds tested');
  expect(vi.mocked(serviceCall).mock.calls.map(([method]) => method)).toEqual([
    'outbounds.testPlanStart',
    'outbounds.testGet',
    'outbounds.testGet',
    'outbounds.testGet',
  ]);
});
it.each(['latency', 'speed'] as const)(
  'retains other %s results and policy summaries when retesting one server, including after preparation fails',
  async (mode) => {
    respondToTests((id, round, index) => ({
      id,
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
    }));
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
    vi.mocked(stageOutboundTests).mockRejectedValueOnce(new Error('Cannot upload draft'));
    await act(() => latest.start(undefined, ['test-second'], mode));
    expect(latest.error).toContain('Cannot upload draft');
    expect(latest.results).toBe(completed);
    expect(summaries().get('node:test-first')).toEqual(first);
  },
);
