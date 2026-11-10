// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TimezoneSettings from './TimezoneSettings';
import { serviceCall } from '../serviceClient';

vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (error: Error) => error.message,
}));
let root: Root, host: HTMLDivElement;
const snapshot = {
  browsers: [
    {
      id: 'chrome',
      path: 'C:\\Chrome\\chrome.exe',
      revision: 3,
      policy: { mode: 'manual', zone: 'Asia/Tokyo' },
      startup: false,
    },
  ],
};
const click = (text: string) =>
  act(async () => {
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === text || item.getAttribute('aria-label') === text,
    );
    expect(button).toBeTruthy();
    button!.click();
  });
const field = (label: string) =>
  [...host.querySelectorAll<HTMLLabelElement>('.timezone-browser-editor label')]
    .find((item) => item.querySelector('span')?.textContent === label)!
    .querySelector<HTMLSelectElement>('select')!;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(serviceCall).mockReset().mockResolvedValue(snapshot);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
it('keeps a stale edit available and requires refresh instead of overwriting a newer Companion policy', async () => {
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  await click('Edit');
  vi.mocked(serviceCall).mockRejectedValueOnce(
    new Error('Browser timezone changed. Refresh and try again.'),
  );
  await click('Save');
  expect(serviceCall).toHaveBeenLastCalledWith('browserTimezone.set', {
    id: 'chrome',
    expectedRevision: 3,
    startup: false,
    policy: { mode: 'manual', zone: 'Asia/Tokyo' },
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Browser timezone changed');
  expect(field('Mode').value).toBe('manual');
  vi.mocked(serviceCall).mockResolvedValueOnce(snapshot);
  await click('Refresh browser timezones');
  expect(host.querySelector('.timezone-browser-editor')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('saves startup initialization without changing the selected zone', async () => {
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  await click('Edit');
  await act(() => {
    field('Initialization').value = 'startup';
    field('Initialization').dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Save');
  expect(serviceCall).toHaveBeenLastCalledWith('browserTimezone.set', {
    id: 'chrome',
    expectedRevision: 3,
    startup: true,
    policy: { mode: 'manual', zone: 'Asia/Tokyo' },
  });
});
it('preserves the revision opened by the editor while background polls observe a newer policy', async () => {
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
    await click('Edit');
    vi.mocked(serviceCall).mockResolvedValue({
      browsers: [{ ...snapshot.browsers[0], revision: 4, policy: { mode: 'manual', zone: 'UTC' } }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await click('Save');
    expect(serviceCall).toHaveBeenLastCalledWith('browserTimezone.set', {
      id: 'chrome',
      expectedRevision: 3,
      policy: { mode: 'manual', zone: 'Asia/Tokyo' },
      startup: false,
    });
  } finally {
    vi.useRealTimers();
  }
});
it('can retry an unavailable service without closing or disabling the dialog', async () => {
  vi.mocked(serviceCall).mockRejectedValueOnce(new Error('Service unavailable'));
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Service unavailable');
  await click('Refresh browser timezones');
  expect(host.textContent).toContain('Asia/Tokyo');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('clears a transient inventory error on the next successful poll', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(serviceCall).mockRejectedValueOnce(new Error('Service restarting'));
    await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Service restarting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(host.textContent).toContain('Asia/Tokyo');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it('does not save a completed lookup when the dialog closes during revision validation', async () => {
  let release!: (value: { revision: number }) => void;
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'timezone.probeStart') return { job: 7, revision: 9 };
    if (method === 'outbounds.testGet')
      return { busy: false, results: [{ timezone: 'UTC', ip: '192.0.2.1' }] };
    if (method === 'config.get')
      return new Promise((resolve) => {
        release = resolve;
      });
    return snapshot;
  });
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  await click('Edit');
  await act(() => {
    field('Mode').value = 'main';
    field('Mode').dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Save');
  expect(serviceCall).toHaveBeenCalledWith('config.get');
  await act(() => root.render(null));
  await act(async () => release({ revision: 9 }));
  expect(
    vi.mocked(serviceCall).mock.calls.some(([method]) => method === 'browserTimezone.set'),
  ).toBe(false);
});
it('keeps the exact outbound selected by the newer editor after a delayed Stash read', async () => {
  const custom = (id: string, groupId: string, entryId: string) => ({
    ...snapshot.browsers[0],
    id,
    path: `${id}.exe`,
    policy: { mode: 'custom', zone: 'UTC', selection: { groupId, entryId, version: 7 } },
  });
  const items = [
    { groupId: 'g/a', entryId: 'b', name: 'A' },
    { groupId: 'g', entryId: 'a/b', name: 'B' },
  ];
  const page = {
    version: 7,
    groupId: null,
    groups: [
      { id: 'g/a', name: 'Group A' },
      { id: 'g', name: 'Group B' },
    ],
    items,
    more: false,
  };
  type Reply = typeof page & { selected: (typeof items)[number] };
  const pending: ((value: Reply) => void)[] = [];
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'subscriptions.timezoneChoices')
      return new Promise((resolve) => pending.push(resolve));
    return { browsers: [custom('a', 'g/a', 'b'), custom('b', 'g', 'a/b')] };
  });
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  await click('Edit');
  await act(() =>
    host
      .querySelectorAll<HTMLButtonElement>('.timezone-browser-heading .secondary-button')[1]
      .click(),
  );
  await act(async () => pending[1]({ ...page, selected: items[1] }));
  const selected = () => field('Stash outbound');
  expect(selected()?.selectedOptions[0]?.textContent).toBe('Group B · B');
  await act(async () => pending[0]({ ...page, selected: items[0] }));
  expect(selected()?.selectedOptions[0]?.textContent).toBe('Group B · B');
});

it('ignores a Stash read failure after canceling the editor', async () => {
  let rejectRead!: (reason: Error) => void;
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'subscriptions.timezoneChoices')
      return new Promise((_, reject) => {
        rejectRead = reject;
      });
    return snapshot;
  });
  await act(async () => root.render(<TimezoneSettings onClose={() => {}} />));
  await click('Edit');
  await act(() => {
    field('Mode').value = 'custom';
    field('Mode').dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(serviceCall).toHaveBeenCalledWith('subscriptions.timezoneChoices', { query: '' });
  await click('Cancel');
  await act(async () => rejectRead(new Error('Stash unavailable')));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
