// @vitest-environment jsdom
import { TRAFFIC_SORTING_KEY } from '../trafficSorting';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TrafficMonitor from './TrafficPanel';
import useTrafficHistory from '../useTrafficHistory';
import type { RuntimeController } from '../useRuntime';
import type { TrafficSnapshot } from '../traffic';
import { serviceCall } from '../serviceClient';
vi.mock('../serviceClient', () => ({ serviceCall: vi.fn(), errorText: (e: unknown) => String(e) }));
let root: Root, host: HTMLDivElement;
const traffic: TrafficSnapshot = {
  state: 'collecting',
  generation: 2,
  revision: 7,
  sampleIntervalMs: 2000,
  sampleId: 2,
  lastSample: {
    sampleId: 2,
    timestampMs: Date.now(),
    elapsedMs: 4000,
    uploadPerSecond: 1024,
    downloadPerSecond: 2048,
  },
  uploadBytes: '12345',
  downloadBytes: '40000',
  accumulatedUploadBytes: '100000',
  accumulatedDownloadBytes: '200000',
  uploadPerSecond: 1024,
  downloadPerSecond: 2048,
  endpoints: [
    {
      scope: 'inbound',
      tag: 'client',
      uploadBytes: '12345',
      downloadBytes: '40000',
      uploadPerSecond: 1024,
      downloadPerSecond: 2048,
    },
    {
      scope: 'outbound',
      tag: 'direct',
      uploadBytes: '12345',
      downloadBytes: '40000',
      uploadPerSecond: 1024,
      downloadPerSecond: 2048,
    },
  ],
  error: null,
};
const runtime = (t = traffic, connected = true) =>
  ({
    desktop: true,
    connected,
    capabilities: ['xray.statistics'],
    snapshot: { instanceId: 'one', traffic: t, core: { state: 'running' } },
  }) as RuntimeController;
beforeEach(() => {
  localStorage.removeItem(TRAFFIC_SORTING_KEY);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(serviceCall).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('rejects delayed history from a previous core generation and preserves newer event samples', async () => {
  let resolveOld: (value: unknown) => void = () => {};
  vi.mocked(serviceCall).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  function Probe({ r }: { r: RuntimeController }) {
    const h = useTrafficHistory(r);
    return <span>{h.points.map((p) => p.sampleId).join(',')}</span>;
  }
  await act(async () =>
    root.render(
      <Probe
        r={runtime({
          ...traffic,
          generation: 1,
          sampleId: 5,
          lastSample: { ...traffic.lastSample!, sampleId: 5 },
        })}
      />,
    ),
  );
  vi.mocked(serviceCall).mockResolvedValueOnce({
    generation: 2,
    revision: 7,
    points: [{ ...traffic.lastSample!, sampleId: 1 }],
  });
  await act(async () => {
    root.render(<Probe r={runtime()} />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveOld({ generation: 1, revision: 7, points: [{ ...traffic.lastSample!, sampleId: 99 }] });
    await Promise.resolve();
  });
  expect(host.textContent).toBe('1,2');
});

const click = async (label: string) =>
  act(async () => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  });
it('keeps the chart history when the window is reopened after the service disconnects', async () => {
  const first = {
    ...traffic.lastSample!,
    sampleId: 1,
    elapsedMs: 2000,
    intervalMs: 2000,
  };
  vi.mocked(serviceCall).mockResolvedValue({ generation: 2, revision: 7, points: [first] });
  const render = (r: RuntimeController, open: boolean) =>
    act(async () => root.render(<TrafficMonitor runtime={r} open={open} onClose={vi.fn()} />));
  await render(runtime(), true);
  const path = () => host.querySelector('.traffic-down')?.getAttribute('d');
  const original = path();
  expect(original).toContain('H');
  await render(runtime(), false);
  expect(host.querySelector('dialog')).toBeNull();
  await render(runtime(traffic, false), true);
  expect(host.textContent).toContain('Service offline');
  expect(path()).toBe(original);
});

it('shows why a large endpoint table is empty before and after reconnecting', async () => {
  const waiting: TrafficSnapshot = {
    ...traffic,
    sampleId: 0,
    lastSample: null,
    endpoints: [],
    endpointsTruncated: true,
    endpointCounts: { inbound: 1, outbound: 500 },
  };
  vi.mocked(serviceCall).mockImplementation(async (method) =>
    method === 'traffic.history'
      ? { generation: 2, revision: 7, points: [] }
      : {
          generation: 2,
          revision: 7,
          sampleId: 0,
          scope: 'outbound',
          offset: 0,
          total: 0,
          endpoints: [],
        },
  );
  const render = (connected: boolean) =>
    act(async () =>
      root.render(
        <TrafficMonitor
          runtime={{
            ...runtime(waiting, connected),
            capabilities: ['xray.statistics', 'xray.statistics.pages'],
          }}
          open
          onClose={vi.fn()}
        />,
      ),
    );
  await render(false);
  await click('Outbounds');
  expect(host.textContent).toContain(
    'Endpoint counters are unavailable while the service is offline.',
  );
  expect(serviceCall).not.toHaveBeenCalled();
  await render(true);
  expect(serviceCall).toHaveBeenCalledWith('traffic.endpoints', {
    scope: 'outbound',
    offset: 0,
    limit: 100,
  });
  expect(host.textContent).toContain('No endpoint counters available for this session.');
  expect(host.textContent).not.toContain('Loading endpoint counters');
});

it('freezes exact counters and history, keeps runtime status current, and resumes a new service session', async () => {
  vi.mocked(serviceCall).mockImplementation(async () => ({
    generation: 2,
    revision: 7,
    points: [],
  }));
  const render = (r: RuntimeController) =>
    act(async () => root.render(<TrafficMonitor runtime={r} open onClose={vi.fn()} />));
  await render(runtime());
  await click('Pause display');
  const heldChart = host.querySelector('figure')!.innerHTML;
  const next = {
    ...traffic,
    generation: 3,
    revision: 9,
    uploadBytes: '999999',
    uploadPerSecond: 4096,
    lastSample: { ...traffic.lastSample!, sampleId: 3, uploadPerSecond: 4096 },
  };
  await render({
    ...runtime(next, false),
    snapshot: { ...runtime(next).snapshot!, instanceId: 'two' },
  });
  expect(host.textContent).toContain('Display paused at');
  expect(host.textContent).toContain('Service offline');
  expect(host.textContent).toContain('session changed');
  expect(host.querySelector('[title="12345 bytes"]')).not.toBeNull();
  expect(host.querySelector('[title="999999 bytes"]')).toBeNull();
  expect(host.querySelector('figure')!.innerHTML).toBe(heldChart);
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe('Resume display');
  expect(host.querySelector('[role="tab"][aria-disabled="true"]')).not.toBeNull();
  await render(runtime(next));
  await click('Resume display');
  expect(host.querySelector('[title="999999 bytes"]')).not.toBeNull();
  expect(host.textContent).toContain('4.0 KiB/s');
  expect(host.textContent).toContain('core session 3');
});
it('rejects a delayed history response from before Reset counters in the same core generation', async () => {
  let old: ((v: unknown) => void) | undefined;
  vi.mocked(serviceCall)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue({ generation: 2, revision: 7, counterEpoch: 1, points: [] });
  function Probe({ epoch }: { epoch: number }) {
    const h = useTrafficHistory(
      runtime({ ...traffic, counterEpoch: epoch, lastSample: epoch ? null : traffic.lastSample }),
    );
    return <span>{h.points.map((p) => p.sampleId).join(',')}</span>;
  }
  await act(async () => root.render(<Probe epoch={0} />));
  await act(async () => root.render(<Probe epoch={1} />));
  await act(async () => {
    old!({
      generation: 2,
      revision: 7,
      counterEpoch: 0,
      points: [{ ...traffic.lastSample!, sampleId: 99 }],
    });
    await Promise.resolve();
  });
  expect(host.textContent).toBe('');
});
