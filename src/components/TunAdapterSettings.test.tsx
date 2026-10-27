// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TunAdapterSettings from './TunAdapterSettings';
import { serviceCall } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import type { ServiceSnapshot } from '../serviceClient';
vi.mock('../serviceClient', () => ({
  serviceCall: vi.fn(),
  errorText: (e: unknown) => String(e),
}));
let host: HTMLDivElement, root: Root, runtime: RuntimeController;
const close = vi.fn();
const inventory = {
  reuseAdapters: true,
  recoveryPending: false,
  adapters: [
    {
      kind: 'host',
      id: 'owned-host-id',
      name: 'WayrillTUN',
      state: 'disabled',
      error: null,
      canRemove: true,
    },
  ],
};
const render = () =>
  act(async () => root.render(<TunAdapterSettings runtime={runtime} onClose={close} />));
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  vi.mocked(serviceCall).mockResolvedValue(inventory);
  runtime = {
    desktop: true,
    connected: true,
    busy: false,
    capabilities: ['windows.tun.adapters'],
    run: vi.fn().mockResolvedValue({}),
    snapshot: {
      instanceId: 'test',
      core: { state: 'stopped' },
      tun: { state: 'stopped' },
    } as ServiceSnapshot,
  } as unknown as RuntimeController;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('changes the service-global preference independently of any graph', async () => {
  await render();
  expect(button('Apply').disabled).toBe(true);
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = 'disposable';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Apply').click());
  expect(runtime.run).toHaveBeenCalledWith('tun.adapters.set', {
    reuseAdapters: false,
  });
});
it('requires confirmation and a current installation identity to remove an orphan', async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.click(),
  );
  expect(runtime.run).not.toHaveBeenCalled();
  await act(async () => button('Remove adapter').click());
  expect(runtime.run).toHaveBeenCalledWith('tun.adapters.remove', {
    kind: 'host',
    expectedId: 'owned-host-id',
  });
});
it.each(['running', 'starting', 'stopping'])(
  'prevents edits during %s but always allows closing',
  async (state) => {
    runtime.snapshot!.core.state = state;
    vi.mocked(serviceCall).mockResolvedValue({ ...inventory, recoveryPending: true });
    await render();
    expect(host.textContent).not.toContain('Finish Internet sharing recovery');
    expect(host.querySelector('select')!.disabled).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.disabled,
    ).toBe(true);
    await act(async () => button('Close').click());
    expect(close).toHaveBeenCalledOnce();
  },
);
it('keeps uncertain service failures visible without automatically retrying removal', async () => {
  vi.mocked(runtime.run).mockRejectedValue('Outcome unknown. Refresh before retrying.');
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.click(),
  );
  await act(async () => button('Remove adapter').click());
  expect(runtime.run).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Outcome unknown');
});

it('allows explicit adapter repair after a stopped failure', async () => {
  runtime.snapshot!.core.state = 'failed';
  vi.mocked(serviceCall).mockResolvedValue({
    ...inventory,
    adapters: [{ ...inventory.adapters[0], state: 'conflict', error: 'Windows GUID changed' }],
  });
  await render();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.disabled).toBe(
    false,
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.click(),
  );
  await act(async () => button('Remove adapter').click());
  expect(runtime.run).toHaveBeenCalledWith('tun.adapters.remove', {
    kind: 'host',
    expectedId: 'owned-host-id',
  });
});
it('retains removal guards while a failed core still has healthy TUN capture', async () => {
  runtime.snapshot!.core.state = 'failed';
  runtime.snapshot!.tun!.state = 'running';
  vi.mocked(serviceCall).mockResolvedValue({
    ...inventory,
    adapters: [{ ...inventory.adapters[0], state: 'running', canRemove: false }],
  });
  await render();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.disabled).toBe(
    true,
  );
});
it('never enables removal of a device with unverified ownership', async () => {
  runtime.snapshot!.core.state = 'failed';
  vi.mocked(serviceCall).mockResolvedValue({
    ...inventory,
    adapters: [{ ...inventory.adapters[0], state: 'conflict', canRemove: false }],
  });
  await render();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.disabled).toBe(
    true,
  );
});

it('allows the service-approved host repair while sharing recovery protects its own adapter', async () => {
  runtime.snapshot!.core.state = 'failed';
  runtime.snapshot!.tun!.state = 'running'; // Retained keeper, no host packet worker.
  vi.mocked(serviceCall).mockResolvedValue({
    ...inventory,
    recoveryPending: true,
    adapters: [
      inventory.adapters[0],
      {
        ...inventory.adapters[0],
        kind: 'ics',
        id: 'owned-ics',
        name: 'Wayrill-ICS',
        state: 'running',
        canRemove: false,
      },
    ],
  });
  await render();
  expect(host.textContent).toContain('Finish Internet sharing recovery');
  expect(host.querySelector('select')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.disabled).toBe(
    false,
  );
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove Wayrill-ICS"]')!.disabled).toBe(
    true,
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove WayrillTUN"]')!.click(),
  );
  await act(async () => button('Remove adapter').click());
  expect(runtime.run).toHaveBeenCalledWith('tun.adapters.remove', {
    kind: 'host',
    expectedId: 'owned-host-id',
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('keeps the inventory and preference from the reconnected service when an old read finishes late', async () => {
  const old = deferred<typeof inventory>();
  const current = deferred<typeof inventory>();
  vi.mocked(serviceCall).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await render();
  runtime = { ...runtime, snapshot: { ...runtime.snapshot!, instanceId: 'restarted' } };
  await render();
  await act(async () =>
    current.resolve({
      ...inventory,
      reuseAdapters: false,
      adapters: [{ ...inventory.adapters[0], name: 'Current TUN', id: 'current-host-id' }],
    }),
  );
  await act(async () => old.resolve(inventory));
  expect(host.textContent).toContain('Current TUN');
  expect(host.textContent).not.toContain('WayrillTUN');
  expect(host.querySelector('select')!.value).toBe('disposable');
  expect(button('Apply').disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Current TUN"]')!.click(),
  );
  await act(async () => button('Remove adapter').click());
  expect(runtime.run).toHaveBeenCalledWith('tun.adapters.remove', {
    kind: 'host',
    expectedId: 'current-host-id',
  });
});

it('does not unlock controls or surface an old error while the current inventory is still loading', async () => {
  const old = deferred<typeof inventory>();
  const current = deferred<typeof inventory>();
  vi.mocked(serviceCall).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await render();
  runtime = { ...runtime, snapshot: { ...runtime.snapshot!, instanceId: 'restarted' } };
  await render();
  await act(async () => old.reject(new Error('Previous service disconnected')));
  expect(host.textContent).toContain('Loading adapters');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh TUN adapters"]')!.disabled,
  ).toBe(true);
  await act(async () => current.resolve(inventory));
  expect(host.textContent).not.toContain('Loading adapters');
  expect(host.querySelector('select')!.disabled).toBe(false);
});

it('requires a successful new inventory before editing after a failed reconnection refresh', async () => {
  await render();
  vi.mocked(serviceCall).mockRejectedValueOnce(new Error('Inventory unavailable'));
  runtime = { ...runtime, snapshot: { ...runtime.snapshot!, instanceId: 'restarted' } };
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Inventory unavailable');
  expect(host.textContent).not.toContain('WayrillTUN');
  expect(host.querySelector('select')!.disabled).toBe(true);
  expect(button('Apply').disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh TUN adapters"]')!.click(),
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('select')!.disabled).toBe(false);
  expect(host.textContent).toContain('WayrillTUN');
});

it('retires an in-flight read on disconnection and keeps Close usable', async () => {
  const old = deferred<typeof inventory>();
  vi.mocked(serviceCall).mockReturnValueOnce(old.promise);
  await render();
  runtime = { ...runtime, connected: false };
  await render();
  await act(async () => old.resolve(inventory));
  expect(host.textContent).not.toContain('Loading adapters');
  expect(host.textContent).not.toContain('WayrillTUN');
  expect(host.textContent).toContain('Connect to the installed Windows service');
  expect(host.querySelector('select')!.disabled).toBe(true);
  await act(async () => button('Close').click());
  expect(close).toHaveBeenCalledOnce();
});
