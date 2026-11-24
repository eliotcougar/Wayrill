// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useResourceSync from './useResourceSync';
import { createTrafficExample } from './graph/example';
import { factoryResources } from './graph/resources';
import { factoryDefaults } from './graph/defaults';
import { serviceCall } from './serviceClient';
import type { GraphState } from './graph/types';
vi.mock('./serviceClient', async (original) => ({
  ...(await original<typeof import('./serviceClient')>()),
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (error: Error) => error.message,
}));
let root: Root;
function Fixture({
  graph,
  instanceId = 'first',
}: {
  graph: GraphState | null;
  instanceId?: string;
}) {
  useResourceSync(graph, instanceId);
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.mocked(serviceCall).mockReset();
  root = createRoot(document.createElement('div'));
});
it('waits for the saved workspace and resends its schedule after a lost reply or service replacement', async () => {
  const graph = createTrafficExample();
  graph.defaults = { ...factoryDefaults(), resources: factoryResources() };
  graph.defaults.resources!.reloadAfterAutoUpdates = false;
  let instanceId = 'first';
  let revision = 0;
  const configure = vi
    .fn()
    .mockRejectedValueOnce({ code: 'TIMEOUT', message: 'Reply lost' })
    .mockResolvedValue({});
  vi.mocked(serviceCall).mockImplementation(async (method, params) =>
    method === 'resources.scheduleVersion'
      ? { instanceId, revision: ++revision }
      : configure(params),
  );
  await act(() => root.render(<Fixture graph={null} />));
  expect(serviceCall).not.toHaveBeenCalled();

  await act(() => root.render(<Fixture graph={graph} />));
  await act(() => vi.advanceTimersByTimeAsync(250));
  instanceId = 'replacement';
  await act(() => root.render(<Fixture graph={graph} instanceId={instanceId} />));
  expect(configure.mock.calls.map(([params]) => params.base)).toEqual([
    { instanceId: 'first', revision: 1 },
    { instanceId: 'first', revision: 2 },
    { instanceId: 'replacement', revision: 3 },
  ]);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
});
it('retries busy configuration and cancellation releases the queue for the next graph', async () => {
  const graph = createTrafficExample();
  graph.defaults = { ...factoryDefaults(), resources: factoryResources() };
  const configure = vi.fn().mockRejectedValueOnce({ code: 'BUSY' }).mockResolvedValue({});
  vi.mocked(serviceCall).mockImplementation(async (method, params) =>
    method === 'resources.scheduleVersion'
      ? { instanceId: 'first', revision: 0 }
      : configure(params),
  );
  await act(() => root.render(<Fixture graph={graph} />));
  expect(configure).toHaveBeenCalledTimes(1);
  const next = structuredClone(graph);
  next.defaults!.resources!.reloadAfterAutoUpdates = false;
  await act(() => root.render(<Fixture graph={next} />));
  expect(configure).toHaveBeenCalledTimes(2);
  expect(configure.mock.lastCall?.[0]).toMatchObject({
    schedule: { reloadAfterAutoUpdates: false },
  });
  await act(() => vi.advanceTimersByTime(10000));
  expect(configure).toHaveBeenCalledTimes(2);
});
