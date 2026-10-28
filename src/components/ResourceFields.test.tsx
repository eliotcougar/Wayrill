// @vitest-environment jsdom
import { act, useState } from 'react';
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
function Fixture() {
  const [value, change] = useState(factoryResources());
  return <ResourceFields value={value} onChange={change} />;
}
const action = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
it('selects one default of each kind without changing independent update settings', async () => {
  vi.mocked(serviceCall).mockResolvedValue({ busy: false, files: [] });
  await act(() => root.render(<Fixture />));
  const site = container.querySelector('[aria-label="GeoSite files"]')!;
  expect(site.querySelector('strong[title="geosite.dat"]')?.parentElement?.textContent).toContain(
    'XTLS',
  );
  expect(
    site.querySelector('strong[title="ru-geosite.dat"]')?.parentElement?.textContent,
  ).toContain('RunetFreedom');
  await act(() => action('Default ru-geosite.dat').click());
  expect(site.querySelectorAll('tbody tr')).toHaveLength(4);
  expect(action('Default geosite.dat').getAttribute('aria-pressed')).toBe('false');
  expect(action('Default ru-geosite.dat').getAttribute('aria-pressed')).toBe('true');
  expect(action('Default geoip.dat').getAttribute('aria-pressed')).toBe('true');
  await act(() => action('Auto-update ru-geosite.dat').click());
  expect(action('Auto-update ru-geosite.dat').getAttribute('aria-pressed')).toBe('true');
  expect(action('Auto-update geoip.dat').getAttribute('aria-pressed')).toBe('false');
  await act(() => action('Default ru-geosite.dat').click());
  expect(action('Default ru-geosite.dat').getAttribute('aria-pressed')).toBe('false');
  expect(vi.mocked(serviceCall).mock.calls.every(([method]) => method === 'resources.status')).toBe(
    true,
  );
});
it('keeps the full URL preset list while a custom URL is being edited and cancels new rows atomically', async () => {
  vi.mocked(serviceCall).mockResolvedValue({ busy: false, files: [] });
  await act(() => root.render(<Fixture />));
  await act(() => action('Add GeoSite file').click());
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'https://manual.example/site.dat',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => action('Presets for Resource URL').click());
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(5);
  expect(input.value).toBe('https://manual.example/site.dat');
  await act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click(),
  );
  expect(container.querySelectorAll('.resource-table tbody tr')).toHaveLength(8);
  expect(container.querySelector('dialog')).toBeNull();
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

it('shows installed size before its update time, independently of a failed refresh', async () => {
  const updatedAtMs = Date.UTC(2026, 9, 27, 10, 0, 0);
  vi.mocked(serviceCall).mockResolvedValue({
    busy: false,
    files: [
      {
        file: 'geosite.dat',
        present: true,
        bytes: 18 * 1024 * 1024,
        updatedAtMs,
        lastError: 'Download failed.',
      },
      { file: 'geoip.dat', present: false, bytes: null, updatedAtMs: 0 },
    ],
  });
  await act(() => root.render(<Fixture />));
  const row = container.querySelector('strong[title="geosite.dat"]')!.closest('tr')!;
  const metadata = row.querySelector('.resource-file-meta')!;
  expect([...metadata.querySelectorAll('span')].map((span) => span.textContent)).toEqual([
    '18.0 MiB',
    `Updated ${new Date(updatedAtMs).toLocaleString()}`,
  ]);
  expect(row.querySelector('.error')?.textContent).toBe('Download failed.');
  const missing = container.querySelector('strong[title="geoip.dat"]')!.closest('tr')!;
  expect(missing.querySelector('.resource-file-meta')?.textContent).toBe('Not installed');
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

it('distinguishes a scheduled retry from a rejected resource generation', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    busy: false,
    files: [],
    restartRequired: true,
    reloadError: { message: 'Checkpoint temporarily unavailable.', retryable: true },
  });
  await act(async () =>
    root.render(<ResourceFields value={factoryResources()} onChange={() => {}} />),
  );
  const message = container.querySelector('[role="alert"]')?.textContent;
  expect(message).toContain('Checkpoint temporarily unavailable. Retrying automatically.');
  expect(message).not.toContain('Apply to retry');
});

it('shows missing groups as inactive warnings and clears them after recovery', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    busy: false,
    files: [],
    skippedSelectorCount: 1,
    skippedSelectors: [{ selector: 'geosite:office', context: 'Traffic rule 2 · domain' }],
  });
  await act(async () =>
    root.render(<ResourceFields value={factoryResources()} onChange={() => {}} />),
  );
  expect(container.textContent).toContain('1 unavailable geodata entry skipped');
  expect(container.textContent).toContain('geosite:office');
  expect(container.textContent).toContain('Rules with no remaining matches are disabled.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  vi.mocked(serviceCall).mockResolvedValue({
    busy: false,
    files: [],
    skippedSelectorCount: 0,
    skippedSelectors: [],
  });
  await act(async () => vi.advanceTimersByTime(3000));
  expect(container.textContent).not.toContain('unavailable geodata');
});
