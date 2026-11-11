// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import useTrafficEndpoints from './useTrafficEndpoints';
import { serviceCall } from './serviceClient';
import type { RuntimeController } from './useRuntime';
import type { TrafficEndpointPage, TrafficSnapshot, TrafficSort } from './traffic';
vi.mock('./serviceClient', () => ({ serviceCall: vi.fn(), errorText: (e: unknown) => String(e) }));
let root: Root, latest: ReturnType<typeof useTrafficEndpoints>;
const controller = (sampleId: number, state: TrafficSnapshot['state']) =>
  ({
    connected: true,
    capabilities: ['xray.statistics.pages'],
    snapshot: {
      instanceId: 'instance',
      traffic: {
        state,
        generation: 1,
        revision: 2,
        sampleId,
        endpointsTruncated: true,
        endpointCounts: { inbound: 0, outbound: 5000 },
        endpoints: [],
      },
    },
  }) as unknown as RuntimeController;
function Probe({
  sample,
  paused = false,
  sort,
  state = 'collecting',
}: {
  sample: number;
  paused?: boolean;
  sort?: TrafficSort;
  state?: TrafficSnapshot['state'];
}) {
  latest = useTrafficEndpoints(controller(sample, state), 'outbound', paused, sort);
  return null;
}
const page = (sampleId: number): TrafficEndpointPage => ({
  generation: 1,
  revision: 2,
  sampleId,
  scope: 'outbound',
  offset: 0,
  total: 5000,
  endpoints: [
    {
      scope: 'outbound',
      tag: 'sample-' + sampleId,
      uploadBytes: '1',
      downloadBytes: '2',
      uploadPerSecond: 1,
      downloadPerSecond: 2,
    },
  ],
});
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(serviceCall).mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it('keeps a slow endpoint request alive across samples and coalesces the next refresh', async () => {
  const pending: ((page: TrafficEndpointPage) => void)[] = [];
  vi.mocked(serviceCall).mockImplementation(
    () => new Promise((resolve) => pending.push(resolve as (typeof pending)[number])),
  );
  await act(async () => root.render(<Probe sample={1} />));
  await act(async () => root.render(<Probe sample={2} />));
  await act(async () => root.render(<Probe sample={3} />));
  expect(serviceCall).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending[0](page(1));
    await Promise.resolve();
  });
  expect(latest.rows[0].tag).toBe('sample-1');
  expect(latest.fresh).toBe(false);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending[1](page(3));
    await Promise.resolve();
  });
  expect(latest.rows[0].tag).toBe('sample-3');
  expect(latest.fresh).toBe(true);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<Probe sample={4} />));
  expect(serviceCall).toHaveBeenCalledTimes(3);
  await act(async () => root.render(<Probe sample={5} paused />));
  await act(async () => {
    pending[2](page(4));
    await Promise.resolve();
  });
  expect(latest.rows[0].tag).toBe('sample-3');
  expect(serviceCall).toHaveBeenCalledTimes(3);
});

it('coalesces rapid page and sort changes while a previous page is still loading', async () => {
  const pending: ((page: TrafficEndpointPage) => void)[] = [];
  vi.mocked(serviceCall)
    .mockResolvedValueOnce(page(1))
    .mockImplementation(
      () => new Promise((resolve) => pending.push(resolve as (typeof pending)[number])),
    );
  await act(async () => root.render(<Probe sample={1} />));
  await act(async () => latest.setOffset(100));
  expect(latest.offset).toBe(100);
  await act(async () => latest.setOffset(200));
  await act(async () =>
    root.render(<Probe sample={1} sort={{ column: 'uploadBytes', direction: 'asc' }} />),
  );
  await act(async () =>
    root.render(<Probe sample={1} sort={{ column: 'downloadBytes', direction: 'desc' }} />),
  );
  expect(latest.offset).toBe(0);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending[0]({ ...page(1), offset: 100, endpoints: [{ ...page(1).endpoints[0], tag: 'late' }] });
  });
  expect(latest.rows).toEqual([]);
  expect(serviceCall).toHaveBeenCalledTimes(3);
  expect(vi.mocked(serviceCall).mock.calls.at(-1)).toEqual([
    'traffic.endpoints',
    { scope: 'outbound', offset: 0, limit: 100, sortBy: 'downloadBytes', direction: 'desc' },
  ]);
  await act(async () => {
    pending[1]({
      ...page(1),
      sortBy: 'downloadBytes',
      direction: 'desc',
      endpoints: [{ ...page(1).endpoints[0], tag: 'sorted' }],
    });
    await Promise.resolve();
  });
  expect(latest.rows[0].tag).toBe('sorted');
  await act(async () => root.render(<Probe sample={1} />));
  expect(latest.offset).toBe(0);
  expect(vi.mocked(serviceCall).mock.calls.at(-1)).toEqual([
    'traffic.endpoints',
    { scope: 'outbound', offset: 0, limit: 100 },
  ]);
});

it('refreshes rate-sorted rows when collection stops without a new sample', async () => {
  const sort = { column: 'downloadPerSecond', direction: 'desc' } as const;
  const live = { ...page(1), sortBy: sort.column, direction: sort.direction };
  vi.mocked(serviceCall)
    .mockResolvedValueOnce(live)
    .mockResolvedValueOnce({
      ...live,
      endpoints: [{ ...live.endpoints[0], tag: 'alphabetical', downloadPerSecond: null }],
    });
  await act(async () => root.render(<Probe sample={1} sort={sort} />));
  expect(latest.rows[0].tag).toBe('sample-1');
  await act(async () => root.render(<Probe sample={1} sort={sort} state="stopped" />));
  expect(latest.rows[0].tag).toBe('alphabetical');
});
