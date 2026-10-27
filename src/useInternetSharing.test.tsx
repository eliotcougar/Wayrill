// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useInternetSharing from './useInternetSharing';
import { serviceCall } from './serviceClient';
import type { SharingInspection } from './graph/internetSharing';
vi.mock('./serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (error: { message: string }) => error.message,
}));
let root: Root, latest: ReturnType<typeof useInternetSharing>;
const absent: SharingInspection = {
  version: 'none',
  managed: false,
  recoveryPending: false,
  lastError: null,
  connections: [],
  pair: null,
  supported: false,
};
const busy = { code: 'BUSY', message: 'The service is busy.', retryable: true };
function Harness({ revision = 1 }: { revision?: number }) {
  latest = useInternetSharing(revision);
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.mocked(serviceCall).mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
});
it('retries busy inspection without inventing a sharing error, and accepts an absent ICS pair', async () => {
  vi.mocked(serviceCall).mockRejectedValueOnce(busy).mockResolvedValueOnce(absent);
  await act(() => root.render(<Harness />));
  expect(latest.error).toBeUndefined();
  expect(latest.value).toBeUndefined();
  expect(latest.busy).toBe(true);
  await act(() => vi.advanceTimersByTime(250));
  expect(latest.value).toEqual(absent);
  expect(latest.busy).toBe(false);
  expect(serviceCall).toHaveBeenCalledTimes(2);
});
it('preserves the last inspection during busy refresh, backs off, and cancels retry on unmount', async () => {
  vi.mocked(serviceCall).mockResolvedValueOnce(absent).mockRejectedValue(busy);
  await act(() => root.render(<Harness />));
  await act(() => latest.refresh());
  expect(latest.value).toEqual(absent);
  expect(latest.error).toBeUndefined();
  await act(() => vi.advanceTimersByTime(250));
  expect(serviceCall).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTime(499));
  expect(serviceCall).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTime(1));
  expect(serviceCall).toHaveBeenCalledTimes(4);
  await act(() => root.render(null));
  await act(() => vi.advanceTimersByTime(60000));
  expect(serviceCall).toHaveBeenCalledTimes(4);
});
it('discards obsolete reads and does not keep retrying permanent inspection errors', async () => {
  let resolve!: (value: SharingInspection) => void;
  vi.mocked(serviceCall)
    .mockImplementationOnce(
      () =>
        new Promise<SharingInspection>((finish) => {
          resolve = finish;
        }),
    )
    .mockResolvedValueOnce(absent);
  await act(() => root.render(<Harness />));
  await act(() => root.render(<Harness revision={2} />));
  await act(() => resolve({ ...absent, version: 'obsolete' }));
  expect(latest.value?.version).toBe('none');
  vi.mocked(serviceCall).mockRejectedValueOnce({
    code: 'ACCESS_DENIED',
    message: 'Cannot inspect sharing.',
  });
  await act(() => latest.refresh());
  expect(latest.error).toBe('Cannot inspect sharing.');
  expect(latest.value).toBeUndefined();
  expect(latest.busy).toBe(false);
  await act(() => vi.advanceTimersByTime(60000));
  expect(serviceCall).toHaveBeenCalledTimes(3);
});
