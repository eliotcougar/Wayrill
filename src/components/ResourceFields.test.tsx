// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import ResourceFields from './ResourceFields';
import { factoryResources, resourceFiles } from '../graph/resources';
import { serviceCall } from '../serviceClient';
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  errorText: (e: Error) => e.message,
  serviceCall: vi.fn(),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.mocked(serviceCall).mockReset();
  container = document.createElement('div');
  root = createRoot(container);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLElement.prototype.showPopover = function () {
    this.dataset.open = 'true';
  };
  HTMLElement.prototype.hidePopover = function () {
    delete this.dataset.open;
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it('keeps at most one status poll in flight and stops polling on close', async () => {
  let resolve!: (v: unknown) => void;
  vi.mocked(serviceCall).mockImplementation(
    () =>
      new Promise<any>((yes) => {
        resolve = yes;
      }),
  );
  await act(async () =>
    root.render(<ResourceFields value={factoryResources()} onChange={() => {}} />),
  );
  await act(async () => vi.advanceTimersByTime(15000));
  expect(serviceCall).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ busy: false, files: [] }));
  await act(async () => vi.advanceTimersByTime(3000));
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTime(10000));
  expect(serviceCall).toHaveBeenCalledTimes(2);
});
it('updates every URL source in one batch and rejects duplicate clicks before rerender', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(serviceCall).mockImplementation((method) =>
    method === 'resources.update'
      ? new Promise<any>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ busy: false, files: [] }),
  );
  const value = factoryResources();
  value.files.push({
    id: 'disk',
    name: 'disk.dat',
    kind: 'geosite',
    url: '',
    enabled: false,
    autoUpdate: false,
    intervalHours: 24,
    throughWayrill: false,
  });
  value.files.push({
    id: 'extra',
    name: 'extra.dat',
    kind: 'geoip',
    url: 'https://example.org/geoip.dat',
    enabled: false,
    autoUpdate: false,
    intervalHours: 48,
    throughWayrill: true,
  });
  await act(() => root.render(<ResourceFields value={value} onChange={vi.fn()} />));
  const updates = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent === 'Update now',
  );
  expect(updates).toHaveLength(1);
  await act(() => {
    updates[0].click();
    updates[0].click();
  });
  expect(
    vi.mocked(serviceCall).mock.calls.filter(([method]) => method === 'resources.update'),
  ).toHaveLength(1);
  expect(serviceCall).toHaveBeenCalledWith('resources.update', {
    files: resourceFiles({ ...value, files: value.files.filter((file) => file.url) }),
  });
  await act(() => finish({ busy: true, files: [] }));
});
it('does not let an older poll overwrite an acknowledged update', async () => {
  let poll!: (v: unknown) => void;
  vi.mocked(serviceCall).mockImplementation((method) =>
    method === 'resources.update'
      ? Promise.resolve({ busy: true, files: [] })
      : new Promise<any>((yes) => {
          poll = yes;
        }),
  );
  await act(async () =>
    root.render(<ResourceFields value={factoryResources()} onChange={() => {}} />),
  );
  const stale = poll;
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Update now')!
      .click(),
  );
  await act(async () => stale({ busy: false, files: [] }));
  expect(container.textContent).toContain('Updating…');
});

it('shows a failed automatic filter refresh with its diagnostic and retry action', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    busy: false,
    files: [],
    restartRequired: true,
    reloadError: { message: 'Resource runtime refresh failed.' },
  });
  await act(async () =>
    root.render(<ResourceFields value={factoryResources()} onChange={() => {}} />),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Resource runtime refresh failed. Apply to retry.',
  );
});
