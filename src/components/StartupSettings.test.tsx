// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import StartupSettings from './StartupSettings';
import type { RuntimeController } from '../useRuntime';
import type { ServiceSnapshot } from '../serviceClient';
let root: Root, host: HTMLDivElement, runtime: RuntimeController;
const close = vi.fn();
const apply = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Apply'))!;
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const render = () => act(() => root.render(<StartupSettings runtime={runtime} onClose={close} />));
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  close.mockClear();
  runtime = {
    desktop: true,
    connected: true,
    busy: false,
    capabilities: ['service.startup'],
    run: vi.fn().mockResolvedValue({}),
    snapshot: {
      config: { present: true, revision: 7, sha256: null },
      startup: {
        enabled: false,
        runtimeAccount: 'LocalService',
        lastAttemptMs: null,
        lastError: null,
      },
    } as ServiceSnapshot,
  } as unknown as RuntimeController;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('requires a deliberate change and sends the current applied revision', async () => {
  await render();
  expect(apply().disabled).toBe(true);
  await act(async () => checkbox().click());
  expect(apply().disabled).toBe(false);
  await act(async () => apply().click());
  expect(runtime.run).toHaveBeenCalledExactlyOnceWith('startup.set', {
    enabled: true,
    expectedRevision: 7,
  });
});
it('requires an applied configuration to enable startup but permits disabling without one', async () => {
  runtime.snapshot!.config.present = false;
  await render();
  await act(async () => checkbox().click());
  expect(apply().disabled).toBe(true);
  expect(host.textContent).toContain('Apply a working configuration first');
  runtime.snapshot!.startup!.enabled = true;
  await render();
  await act(async () => checkbox().click());
  expect(apply().disabled).toBe(false);
  await act(async () => apply().click());
  expect(runtime.run).toHaveBeenCalledWith('startup.set', {
    enabled: false,
    expectedRevision: 7,
  });
});
it('closing a draft does not change startup or stop routing', async () => {
  await render();
  await act(async () => checkbox().click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close startup settings"]')!.click(),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(runtime.run).not.toHaveBeenCalled();
});
it.each(['header', 'footer', 'escape'])(
  'allows closing with %s during a service operation',
  async (action) => {
    runtime.busy = true;
    await render();
    expect(checkbox().disabled).toBe(true);
    expect(apply().disabled).toBe(true);
    const header = host.querySelector<HTMLButtonElement>('[aria-label="Close startup settings"]')!;
    const footer = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Close',
    )!;
    expect(header.disabled).toBe(false);
    expect(footer.disabled).toBe(false);
    await act(async () => {
      if (action === 'escape') {
        host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      } else {
        (action === 'header' ? header : footer).click();
      }
    });
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.run).not.toHaveBeenCalled();
  },
);
it('keeps rejected changes visible and reports service failures', async () => {
  vi.mocked(runtime.run).mockRejectedValue({
    code: 'BOOT_CONFIG_INVALID',
    message: 'Certificate is inaccessible.',
  });
  await render();
  await act(async () => checkbox().click());
  await act(async () => apply().click());
  expect(checkbox().checked).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Certificate is inaccessible',
  );
});
it('tracks accepted service changes and prevents mutations when disconnected or busy', async () => {
  await render();
  runtime.snapshot!.startup!.enabled = true;
  await render();
  expect(checkbox().checked).toBe(true);
  runtime.busy = true;
  await render();
  expect(checkbox().disabled).toBe(true);
  expect(apply().disabled).toBe(true);
  runtime.busy = false;
  runtime.connected = false;
  await render();
  expect(checkbox().disabled).toBe(true);
  expect(host.textContent).toContain('Connect to the current Wayrill service');
});
it('distinguishes a deferred automatic retry from a completed startup failure', async () => {
  runtime.snapshot!.startup!.waitingForNetwork = true;
  runtime.snapshot!.startup!.lastError = {
    code: 'ICS_ADAPTER_MISSING',
    message: 'Original adapter not loaded.',
    retryable: true,
  };
  await render();
  expect(host.textContent).toContain('Retrying automatically');
  expect(host.textContent).toContain('Original adapter not loaded');
  runtime.snapshot!.startup!.waitingForNetwork = false;
  await render();
  expect(host.textContent).not.toContain('Retrying automatically');
  expect(host.textContent).toContain('Original adapter not loaded');
});
