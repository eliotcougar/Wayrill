// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import CompanionSettings from './CompanionSettings';
import type { CompanionStatus } from '../companionClient';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
let root: Root, host: HTMLDivElement;
const close = vi.fn();
const copy = vi.fn();
const stableId = 'hkhklldpeeeofokflocodjhfifcbpicc';
const customId = 'a'.repeat(32);
const status = (patch: Partial<CompanionStatus> = {}): CompanionStatus => ({
  extensionId: stableId,
  version: '0.2.0',
  extensionPath: 'C:\\测试\\Wayrill\\Service\\companion-extension',
  hostPath: 'C:\\测试\\Wayrill\\Service\\wayrill-companion.exe',
  available: true,
  registered: false,
  origins: [],
  issues: [],
  browsers: [
    { id: 'edge', name: 'Microsoft Edge', installed: true },
    { id: 'opera', name: 'Opera', installed: true },
    { id: 'brave', name: 'Brave', installed: false },
  ],
  ...patch,
});
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  )!;
const render = () => act(async () => root.render(<CompanionSettings onClose={close} />));
const click = (label: string) => act(async () => button(label).click());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copy },
  });
  vi.mocked(invoke).mockResolvedValue(status());
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

it('registers independently of routing, serializes rapid actions, and always lets the user close', async () => {
  const registration = deferred<CompanionStatus>();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'companion_status') return status();
    if (command === 'companion_register') return registration.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  await render();
  expect(host.textContent).toContain('Bridge not registered');
  await act(async () => {
    button('Enable bridge').click();
    button('Enable bridge').click();
  });
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === 'companion_register'),
  ).toEqual([['companion_register', {}]]);
  expect(button('Enable bridge').disabled).toBe(true);
  expect(button('Disconnect all browsers').disabled).toBe(true);
  expect(button('Done').disabled).toBe(false);
  await click('Done');
  expect(close).toHaveBeenCalledOnce();
  await act(async () => registration.resolve(status({ registered: true, origins: [stableId] })));
  expect(host.textContent).toContain('Bridge registered');
  expect(button('Repair bridge').disabled).toBe(false);
  expect(vi.mocked(invoke).mock.calls.every(([command]) => command.startsWith('companion_'))).toBe(
    true,
  );
});

it('can remove stale registrations without old files or IDs and recover from a failed removal', async () => {
  let removals = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'companion_status')
      return status({
        available: false,
        registered: true,
        hostPath: '',
        extensionPath: '',
        origins: [customId],
        issues: ['Old manifest is unavailable.'],
      });
    if (command === 'companion_unregister') {
      if (++removals === 1) throw new Error('Registry temporarily unavailable.');
      return status({ available: false });
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  await render();
  expect(button('Use bundled copy').disabled).toBe(true);
  expect(button('Disconnect all browsers').disabled).toBe(false);
  await click('Disconnect all browsers');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Registry temporarily unavailable',
  );
  expect(button('Disconnect all browsers').disabled).toBe(false);
  await click('Disconnect all browsers');
  expect(host.textContent).toContain('Bridge not registered');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === 'companion_unregister'),
  ).toEqual([['companion_unregister'], ['companion_unregister']]);
});

it('opens the selected browser, copies the real folder, and explicitly authorizes an older copy', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'companion_status') return status();
    if (command === 'companion_register')
      return status({
        registered: true,
        origins: [stableId, (args as { extensionId: string }).extensionId],
      });
    if (command === 'companion_open') return;
    throw new Error(`Unexpected command: ${command}`);
  });
  await render();
  const browser = host.querySelector('select')!;
  await act(async () => {
    browser.value = 'opera';
    browser.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Open extensions');
  expect(invoke).toHaveBeenLastCalledWith('companion_open', {
    target: 'browser',
    browser: 'opera',
  });
  await act(async () => {
    browser.value = 'brave';
    browser.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Open extensions').disabled).toBe(true);
  await click('Open folder');
  expect(invoke).toHaveBeenLastCalledWith('companion_open', { target: 'folder' });
  await click('Copy extension folder');
  expect(copy).toHaveBeenCalledWith(status().extensionPath);
  expect(host.textContent).toContain('Extension folder copied.');
  copy.mockRejectedValueOnce(new Error('Clipboard permission denied.'));
  await click('Copy extension folder');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Clipboard permission denied',
  );
  const details = host.querySelector('details')!;
  details.open = true;
  const id = details.querySelector('input')!;
  expect(button('Connect copy').disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      id,
      ` ${customId} `,
    );
    id.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Connect copy').disabled).toBe(false);
  await click('Connect copy');
  expect(invoke).toHaveBeenLastCalledWith('companion_register', { extensionId: customId });
  expect(host.textContent).toContain(customId);
  expect(host.textContent).toContain('resets authorizations for older and custom copies');
});
