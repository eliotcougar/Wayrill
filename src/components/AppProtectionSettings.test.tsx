// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import AppProtectionSettings, { type ProtectionSnapshot } from './AppProtectionSettings';
import { serviceCall } from '../serviceClient';
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (e: unknown) => String(e),
}));
vi.mock('./useWindowsCatalog', () => ({
  useWindowsCatalog: () => ({
    loading: false,
    error: '',
    refresh: vi.fn(),
    catalog: {
      packages: [{ family: 'Example.App_publisher', name: 'Example' }],
      processes: [
        { pid: 1, name: 'app.exe', path: 'C:\\Apps\\app.exe' },
        { pid: 2, name: 'helper.exe', path: 'C:\\Apps\\helper.exe' },
        { pid: 3, name: 'helper.exe', path: 'C:\\Apps\\helper.exe' },
      ],
    },
  }),
}));
let root: Root, host: HTMLDivElement, snapshot: ProtectionSnapshot;
const busy = vi.fn(),
  refresh = vi.fn().mockResolvedValue(undefined);
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  snapshot = {
    version: 'v1',
    config: { enabled: true, applications: [{ kind: 'executable', value: 'C:\\Apps\\app.exe' }] },
    phase: 'idle',
    blocked: false,
    error: null,
  };
  vi.mocked(serviceCall).mockImplementation(async (method, params) => {
    if (method === 'appProtection.set') {
      snapshot = {
        ...snapshot,
        version: 'v2',
        config: params!.config as ProtectionSnapshot['config'],
      };
    }
    return structuredClone(snapshot);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<AppProtectionSettings onBusyChange={busy} onRuntimeRefresh={refresh} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
it('adds exact helper paths, hides selected apps, and deduplicates running instances', async () => {
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="Choose protected application from this PC"]',
  )!;
  expect([...select.options].map((o) => o.value)).toEqual(['', 'C:\\Apps\\helper.exe']);
  await act(async () => {
    select.value = 'C:\\Apps\\helper.exe';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.options.length).toBe(1);
  await act(async () => button('Save').click());
  expect(serviceCall).toHaveBeenCalledWith('appProtection.set', {
    expectedVersion: 'v1',
    config: {
      enabled: true,
      applications: [
        { kind: 'executable', value: 'C:\\Apps\\app.exe' },
        { kind: 'executable', value: 'C:\\Apps\\helper.exe' },
      ],
    },
  });
  expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
});
it('follows automatic executable updates in a clean editor without overwriting local edits', async () => {
  snapshot = {
    ...snapshot,
    version: 'new-version',
    config: {
      ...snapshot.config,
      applications: [{ kind: 'executable', value: 'C:\\Apps\\app-2.0.0\\app.exe' }],
    },
  };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('C:\\Apps\\app-2.0.0\\app.exe');
  expect(host.textContent).not.toContain('Settings changed elsewhere');
  await act(async () => button('Save').click());
  expect(serviceCall).toHaveBeenCalledWith(
    'appProtection.set',
    expect.objectContaining({ expectedVersion: 'new-version' }),
  );
});
it('ignores an old polling reply after saving a new protection version', async () => {
  const old = structuredClone(snapshot);
  let finishPoll!: (value: ProtectionSnapshot) => void;
  const poll = new Promise<ProtectionSnapshot>((resolve) => {
    finishPoll = resolve;
  });
  vi.mocked(serviceCall).mockImplementation(async (method) =>
    method === 'appProtection.get' ? poll : { ...snapshot, version: 'v2' },
  );
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  await act(async () => button('Save').click());
  expect(button('Save').disabled).toBe(false);
  await act(async () => finishPoll(old));
  expect(host.textContent).not.toContain('Settings changed elsewhere');
  expect(button('Save').disabled).toBe(false);
});
