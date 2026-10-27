// @vitest-environment jsdom
import { TRAFFIC_SORTING_KEY } from '../trafficSorting';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TrafficPanel from './TrafficPanel';
import useTrafficHistory from '../useTrafficHistory';
import type { RuntimeController } from '../useRuntime';
import type { TrafficPoint, TrafficSnapshot } from '../traffic';
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
it('renders live rates, exact totals, the chart and separate outbound rows', async () => {
  await act(async () =>
    root.render(
      <TrafficPanel
        runtime={runtime()}
        history={{ points: [traffic.lastSample!], error: '', refresh: vi.fn() }}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain('1.0 KiB/s');
  expect(host.textContent).toContain('2.0 KiB/s');
  expect(host.textContent).toContain('Accumulated');
  expect(host.querySelector('[title="12345 bytes"]')).not.toBeNull();
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Outbounds')!.click(),
  );
  expect(host.textContent).toContain('Chained outbounds');
  expect(host.textContent).toContain('direct');
  expect(host.textContent).not.toContain('client');
});
it('keeps totals and hides stale rates while disconnected', async () => {
  await act(async () =>
    root.render(
      <TrafficPanel
        runtime={runtime(traffic, false)}
        history={{ points: [], error: '', refresh: vi.fn() }}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain('Service offline');
  expect(host.textContent).not.toContain('1.0 KiB/s');
  expect(host.textContent).toContain('12.1 KiB');
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
it('pages large outbound sets and rejects a delayed page from a previous generation', async () => {
  const large = {
    ...traffic,
    endpointsTruncated: true,
    endpointCounts: { inbound: 1, outbound: 5000 },
  };
  const r = (generation: number) => ({
    ...runtime({ ...large, generation }),
    capabilities: ['xray.statistics', 'xray.statistics.pages'],
  });
  const history = { points: [], error: '', refresh: vi.fn() };
  let finishOld: (v: unknown) => void = () => {};
  vi.mocked(serviceCall).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  await act(async () =>
    root.render(<TrafficPanel runtime={r(1)} history={history} onClose={vi.fn()} />),
  );
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Outbounds')!.click(),
  );
  const page = (generation: number, offset = 0) => ({
    generation,
    revision: 7,
    sampleId: 2,
    scope: 'outbound',
    offset,
    total: 5000,
    endpoints: [{ ...traffic.endpoints[1], tag: `new-${offset}` }],
  });
  vi.mocked(serviceCall).mockResolvedValueOnce(page(2));
  await act(async () => {
    root.render(<TrafficPanel runtime={r(2)} history={history} onClose={vi.fn()} />);
    await Promise.resolve();
  });
  await act(async () => {
    finishOld({ ...page(1), endpoints: [{ ...traffic.endpoints[1], tag: 'stale' }] });
    await Promise.resolve();
  });
  expect(host.textContent).toContain('new-0');
  expect(host.textContent).not.toContain('stale');
  expect(host.textContent).toContain(`1–100 of ${(5000).toLocaleString()}`);
  vi.mocked(serviceCall).mockResolvedValueOnce(page(2, 100));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.click();
    await Promise.resolve();
  });
  expect(vi.mocked(serviceCall).mock.calls.at(-1)).toEqual([
    'traffic.endpoints',
    { scope: 'outbound', offset: 100, limit: 100 },
  ]);
  expect(host.textContent).toContain(`101–200 of ${(5000).toLocaleString()}`);
  expect(host.textContent).toContain('new-100');
});

const click = async (label: string) =>
  act(async () => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  });
it('freezes exact counters and history, keeps runtime status current, and resumes a new service session', async () => {
  const h = { points: [traffic.lastSample!], error: '', refresh: vi.fn() };
  const render = (r: RuntimeController, points = h.points) =>
    act(async () =>
      root.render(<TrafficPanel runtime={r} history={{ ...h, points }} onClose={vi.fn()} />),
    );
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
  await render(
    { ...runtime(next, false), snapshot: { ...runtime(next).snapshot!, instanceId: 'two' } },
    [next.lastSample],
  );
  expect(host.textContent).toContain('Display paused at');
  expect(host.textContent).toContain('Service offline');
  expect(host.textContent).toContain('session changed');
  expect(host.querySelector('[title="12345 bytes"]')).not.toBeNull();
  expect(host.querySelector('[title="999999 bytes"]')).toBeNull();
  expect(host.querySelector('figure')!.innerHTML).toBe(heldChart);
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe('Resume display');
  expect(host.querySelector('[role="tab"][aria-disabled="true"]')).not.toBeNull();
  await render(runtime(next), [next.lastSample]);
  await click('Resume display');
  expect(host.querySelector('[title="999999 bytes"]')).not.toBeNull();
  expect(host.textContent).toContain('4.0 KiB/s');
  expect(host.textContent).toContain('core session 3');
});
it('holds an endpoint page, cancels in-flight page updates and resumes the current sample', async () => {
  const large = {
    ...traffic,
    endpointsTruncated: true,
    endpointCounts: { inbound: 1, outbound: 5000 },
  };
  const r = (sampleId: number) => ({
    ...runtime({ ...large, sampleId }),
    capabilities: ['xray.statistics', 'xray.statistics.pages'],
  });
  const h = { points: [], error: '', refresh: vi.fn() };
  const render = (sampleId: number) =>
    act(async () =>
      root.render(<TrafficPanel runtime={r(sampleId)} history={h} onClose={vi.fn()} />),
    );
  const page = (sampleId: number, tag: string) => ({
    generation: 2,
    revision: 7,
    sampleId,
    scope: 'outbound',
    offset: 0,
    total: 5000,
    endpoints: [{ ...traffic.endpoints[1], tag }],
  });
  vi.mocked(serviceCall).mockResolvedValueOnce(page(2, 'held'));
  await render(2);
  await click('Outbounds');
  let finish: (v: unknown) => void = () => {};
  vi.mocked(serviceCall).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(3);
  await click('Pause display');
  await act(async () => {
    finish(page(3, 'late'));
    await Promise.resolve();
  });
  expect(host.textContent).toContain('held');
  expect(host.querySelector('tbody')!.textContent).not.toContain('late');
  await render(4);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.disabled).toBe(
    true,
  );
  vi.mocked(serviceCall).mockResolvedValueOnce(page(4, 'current'));
  await click('Resume display');
  expect(host.textContent).toContain('current');
  expect(host.textContent).not.toContain('held');
});
it('distinguishes measured idle, unmeasured baseline and monitor failure from a running core', async () => {
  const render = (t: TrafficSnapshot) =>
    act(async () =>
      root.render(
        <TrafficPanel
          runtime={runtime(t)}
          history={{ points: [], error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
  await render({ ...traffic, uploadPerSecond: 0, downloadPerSecond: 0 });
  expect(host.querySelector('.traffic-rate')!.textContent).toBe('0.0 KiB/s');
  expect(host.textContent).toContain('Live · every 2 seconds');
  await render({ ...traffic, uploadPerSecond: null, downloadPerSecond: null });
  expect(host.textContent).toContain('Collecting · waiting for next sample');
  expect(host.querySelector('.traffic-rate')!.textContent).toBe('—');
  await render({ ...traffic, state: 'unavailable', lastSample: null });
  expect(host.textContent).toContain('Core running · Counters unavailable');
  expect(host.textContent).not.toContain('Live · every');
  await click('Outbounds');
  expect(host.textContent).not.toContain('Start the applied graph');
});
it('does not fabricate zero-byte titles when statistics are absent', async () => {
  const r = { ...runtime(), snapshot: { ...runtime().snapshot!, traffic: undefined } };
  await act(async () =>
    root.render(
      <TrafficPanel
        runtime={r}
        history={{ points: [], error: '', refresh: vi.fn() }}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector('[title="0 bytes"]')).toBeNull();
  expect(host.querySelector('[title="No measurement"]')).not.toBeNull();
});
it('provides a compact rate summary without a per-sample table', async () => {
  const points = Array.from({ length: 300 }, (_, i) => ({
    ...traffic.lastSample!,
    sampleId: i + 1,
    elapsedMs: (i + 1) * 2000,
    uploadPerSecond: i === 299 ? null : 0,
    downloadPerSecond: 0,
  }));
  const render = (samples: TrafficPoint[] = points) =>
    act(async () =>
      root.render(
        <TrafficPanel
          runtime={runtime()}
          history={{ points: samples, error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
  await render();
  expect(host.textContent).not.toContain('Window summary');
  expect(host.textContent).not.toContain('What totals include');
  expect(host.querySelector('table')).toBeNull();
  expect(host.querySelector('svg')).not.toBeNull();
});

it('uses applied endpoint labels and freezes them while paused, falling back on revision mismatch', async () => {
  const state = {
    ...runtime(),
    savedRevision: 7,
    savedDisplayNames: {
      inbound: { client: 'Local applications' },
      outbound: { direct: 'Work server' },
    },
  };
  const render = async () =>
    act(async () =>
      root.render(
        <TrafficPanel
          runtime={state}
          history={{ points: [], error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
  await render();
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Outbounds')!.click(),
  );
  expect(host.querySelector('tbody th')?.textContent).toBe('Work server');
  expect(host.querySelector('tbody th')?.getAttribute('title')).toBe('direct');
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Pause display')!.click(),
  );
  state.savedDisplayNames.outbound.direct = 'Changed applied name';
  await render();
  expect(host.querySelector('tbody th')?.textContent).toBe('Work server');
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume display')!.click(),
  );
  expect(host.querySelector('tbody th')?.textContent).toBe('Changed applied name');
  state.savedRevision = 8;
  await render();
  expect(host.querySelector('tbody th')?.textContent).toBe('direct');
});

it('resets all counters through the service and resumes a paused display', async () => {
  const run = vi.fn().mockResolvedValue({}),
    refresh = vi.fn();
  const r = { ...runtime(), capabilities: ['xray.statistics', 'xray.statistics.reset'], run };
  await act(async () =>
    root.render(
      <TrafficPanel
        runtime={r}
        history={{ points: [traffic.lastSample!], error: '', refresh }}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Pause display')!.click(),
  );
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reset counters')!.click();
    await Promise.resolve();
  });
  expect(run).toHaveBeenCalledWith('traffic.reset');
  expect(refresh).toHaveBeenCalled();
  expect(host.textContent).not.toContain('Resume display');
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

it.each(['inbound', 'outbound'] as const)(
  'sorts %s names, totals and rates with accessible sort state',
  async (scope) => {
    const records = [
      { tag: 'a', uploadBytes: '9007199254740993', uploadPerSecond: null },
      { tag: 'b', uploadBytes: '9007199254740992', uploadPerSecond: 2000 },
      { tag: 'c', uploadBytes: '340282366920938463463374607431768211455', uploadPerSecond: 0 },
    ].map((row) => ({ ...traffic.endpoints[0], ...row, scope }));
    const r = {
      ...runtime({ ...traffic, endpoints: records }),
      savedRevision: 7,
      savedDisplayNames: {
        inbound: { a: 'Zulu', b: 'Alpha', c: 'Beta' },
        outbound: { a: 'Zulu', b: 'Alpha', c: 'Beta' },
      },
    };
    await act(async () =>
      root.render(
        <TrafficPanel
          runtime={r}
          history={{ points: [], error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
    await click(scope === 'inbound' ? 'Traffic sources' : 'Outbounds');
    const shown = () => [...host.querySelectorAll('tbody th')].map((row) => row.textContent);
    expect(shown()).toEqual(['Alpha', 'Beta', 'Zulu']);
    expect(host.querySelector('thead th')!.getAttribute('aria-sort')).toBe('ascending');
    await click('Uploaded');
    expect(shown()).toEqual(['Beta', 'Zulu', 'Alpha']);
    expect(host.querySelectorAll('thead th')[3].getAttribute('aria-sort')).toBe('descending');
    expect(host.querySelector('thead th')!.getAttribute('aria-sort')).toBe('none');
    await click('Uploaded');
    expect(shown()).toEqual(['Alpha', 'Zulu', 'Beta']);
    expect(host.querySelectorAll('thead th')[3].getAttribute('aria-sort')).toBe('ascending');
    await click('Upload rate');
    expect(shown()).toEqual(['Alpha', 'Beta', 'Zulu']);
    await click('Pause display');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('thead button')].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  },
);

it('remembers independent source/outbound sorting when statistics are reopened', async () => {
  const render = () =>
    act(async () =>
      root.render(
        <TrafficPanel
          runtime={runtime()}
          history={{ points: [], error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
  await render();
  await click('Traffic sources');
  await click('Downloaded');
  await click('Outbounds');
  await click('Outbound');
  expect(host.querySelector('thead th')!.getAttribute('aria-sort')).toBe('descending');
  await act(async () => root.render(null));
  await render();
  await click('Traffic sources');
  expect(host.querySelectorAll('thead th')[4].getAttribute('aria-sort')).toBe('descending');
  await click('Outbounds');
  expect(host.querySelector('thead th')!.getAttribute('aria-sort')).toBe('descending');
});

it('retains a cached large page and blocks global sorting while the service is offline', async () => {
  const large = {
    ...traffic,
    endpointsTruncated: true,
    endpointCounts: { inbound: 1, outbound: 5000 },
  };
  const r = {
    ...runtime(large),
    capabilities: ['xray.statistics', 'xray.statistics.pages', 'xray.statistics.sorting'],
  };
  vi.mocked(serviceCall).mockResolvedValue({
    generation: 2,
    revision: 7,
    sampleId: 2,
    scope: 'outbound',
    offset: 0,
    total: 5000,
    endpoints: [{ ...traffic.endpoints[1], tag: 'cached' }],
  });
  const render = (connected: boolean) =>
    act(async () =>
      root.render(
        <TrafficPanel
          runtime={{ ...r, connected }}
          history={{ points: [], error: '', refresh: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
  await render(true);
  await click('Outbounds');
  expect(host.textContent).toContain('cached');
  await render(false);
  const requests = vi.mocked(serviceCall).mock.calls.length;
  const sortButton = [...host.querySelectorAll<HTMLButtonElement>('thead button')].find(
    (button) => button.textContent === 'Uploaded',
  )!;
  expect(sortButton.disabled).toBe(true);
  await act(async () => sortButton.click());
  expect(host.textContent).toContain('cached');
  expect(vi.mocked(serviceCall).mock.calls.length).toBe(requests);
});
