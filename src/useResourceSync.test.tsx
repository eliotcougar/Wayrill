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
  vi.mocked(serviceCall)
    .mockRejectedValueOnce({ code: 'TIMEOUT', message: 'Reply lost' })
    .mockResolvedValue({});
  await act(() => root.render(<Fixture graph={null} />));
  expect(serviceCall).not.toHaveBeenCalled();

  await act(() => root.render(<Fixture graph={graph} />));
  await act(() => vi.advanceTimersByTimeAsync(250));
  await act(() => root.render(<Fixture graph={graph} instanceId="replacement" />));
  expect(serviceCall).toHaveBeenCalledTimes(3);
  for (const [method, schedule] of vi.mocked(serviceCall).mock.calls) {
    expect(method).toBe('resources.configure');
    expect(schedule).toMatchObject({ reloadAfterAutoUpdates: false });
  }
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
});
it('retries busy configuration and cancellation releases the queue for the next graph', async () => {
  const graph = createTrafficExample();
  graph.defaults = { ...factoryDefaults(), resources: factoryResources() };
  vi.mocked(serviceCall).mockRejectedValueOnce({ code: 'BUSY' }).mockResolvedValue({});
  await act(() => root.render(<Fixture graph={graph} />));
  expect(serviceCall).toHaveBeenCalledTimes(1);
  const next = structuredClone(graph);
  next.defaults!.resources!.reloadAfterAutoUpdates = false;
  await act(() => root.render(<Fixture graph={next} />));
  expect(serviceCall).toHaveBeenCalledTimes(2);
  expect(vi.mocked(serviceCall).mock.lastCall?.[1]).toMatchObject({
    reloadAfterAutoUpdates: false,
  });
  await act(() => vi.advanceTimersByTime(10000));
  expect(serviceCall).toHaveBeenCalledTimes(2);
});
