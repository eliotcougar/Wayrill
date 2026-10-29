// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import SystemCaptureSettings from './SystemCaptureSettings';
import { serviceCall } from '../serviceClient';
import { factoryDefaults } from '../graph/defaults';
import { localDirectExample } from '../serviceClient';
import type { SystemCaptureSnapshot } from '../systemCapture';
import type { RuntimeCompilation } from '../graph/runtime';
vi.mock('../serviceClient', async () => ({
  ...(await vi.importActual('../serviceClient')),
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (e: unknown) => String(e),
}));
let root: Root, host: HTMLDivElement, snapshot: SystemCaptureSnapshot;
const compiled: RuntimeCompilation = {
  config: localDirectExample,
  summary: {
    graphName: 'QA',
    listeners: [],
    outboundCount: 2,
    trafficRuleCount: 0,
    dnsServerCount: 0,
  },
  warnings: [],
};
const graph = { name: 'QA', nodes: [], edges: [], defaults: factoryDefaults() };
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => !b.closest('[hidden]') && b.textContent === text,
  )!;
const scope = async (channel: string) =>
  act(async () =>
    host
      .querySelector<HTMLInputElement>(`input[name="winhttp-scope"][value="${channel}"]`)!
      .click(),
  );
const select = async (label: string, value: string) =>
  act(async () => {
    const input = [
      ...host.querySelectorAll<HTMLSelectElement>(`select[aria-label="${label}"]`),
    ].find((s) => !s.closest('[hidden]'))!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  snapshot = {
    running: true,
    revision: 3,
    inputs: [
      { tag: 'local-http', label: 'Browser', port: 2081, http: true, socks: false },
      { tag: 'local-socks', label: 'Tools', port: 2080, http: true, socks: true },
    ],
    captureInputs: ['capture-one'],
    capture: { state: 'stopped', inputs: [], availability: { state: 'available', message: null } },
    driver: { registered: true, state: 'running', owned: true, version: 'driver-v' },
    rows: [
      'wininet',
      'envUser',
      'envMachine',
      'winhttpLegacy',
      'winhttpMachine',
      'winhttpUser',
    ].map((channel) => ({
      channel: channel as never,
      supported: channel !== 'winhttpUser',
      advancedSupported: channel === 'wininet',
      version: `${channel}-v`,
      managed: false,
      values: { enabled: false, server: '', bypass: '', pacUrl: '', autoDetect: false },
    })),
  };
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.get') return structuredClone(snapshot);
    if (method === 'windows.catalog')
      return { interfaces: [], processes: [], services: [], packages: [] };
    if (method === 'windows.loopback.get')
      return { version: 'loopback-v', packages: [], unmatched: [] };
    return {};
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
const render = async (value: RuntimeCompilation | null = compiled) =>
  act(async () =>
    root.render(
      <SystemCaptureSettings
        graph={graph}
        compiled={value}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onRuntimeRefresh={async () => {}}
      />,
    ),
  );
it('points Windows to a chosen applied input with a fresh settings version', async () => {
  await render();
  expect(host.textContent).toContain('This user · default LAN');
  await select('Proxy inbound', 'local-http');
  await act(async () => button('Set').click());
  expect(serviceCall).toHaveBeenCalledWith(
    'system.capture.set',
    expect.objectContaining({
      channel: 'wininet',
      inputTag: 'local-http',
      expectedVersion: 'wininet-v',
    }),
  );
});
it('admits only one settings action while an earlier action is pending', async () => {
  await render();
  await select('Proxy inbound', 'local-http');
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.set') await pending;
    if (method === 'system.capture.get') return structuredClone(snapshot);
    return {};
  });
  await act(async () => {
    button('Set').click();
    button('Clear').click();
  });
  expect(
    vi
      .mocked(serviceCall)
      .mock.calls.filter(([method]) =>
        ['system.capture.set', 'system.capture.clear'].includes(method),
      ),
  ).toHaveLength(1);
  await act(async () => finish());
  expect(button('Clear').disabled).toBe(false);
  await act(async () => button('Clear').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.clear', {
    channel: 'wininet',
    expectedVersion: 'wininet-v',
  });
});
it('keeps user and machine environment scopes distinct', async () => {
  await render();
  await act(async () => button('Environment').click());
  await select('Environment scope', 'envMachine');
  await select('Proxy inbound', 'local-http');
  await act(async () => button('Set').click());
  expect(serviceCall).toHaveBeenCalledWith(
    'system.capture.set',
    expect.objectContaining({
      channel: 'envMachine',
      expectedVersion: 'envMachine-v',
      http: true,
      https: true,
    }),
  );
});
it('keeps foreign driver removal disabled even after the maintenance acknowledgement', async () => {
  snapshot.driver.owned = false;
  await render();
  await act(async () => button('WinDivert').click());
  const check = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Other WinDivert'))!
    .querySelector<HTMLInputElement>('input')!;
  await act(async () => check.click());
  expect(button('Uninstall driver').disabled).toBe(true);
});
it('distinguishes a confirmed change from a subsequent status refresh failure and never repeats it', async () => {
  await render();
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.get') throw new Error('readback unavailable');
    return {};
  });
  await act(async () => button('Clear').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Change applied; status refresh failed.',
  );
  expect(
    vi.mocked(serviceCall).mock.calls.filter(([method]) => method === 'system.capture.clear'),
  ).toHaveLength(1);
});
it('reports an uncertain mutation outcome without automatically retrying the mutation', async () => {
  await render();
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.clear')
      throw { code: 'DISCONNECTED', message: 'connection closed' };
    return structuredClone(snapshot);
  });
  await act(async () => button('Clear').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not confirm the change.',
  );
  expect(
    vi.mocked(serviceCall).mock.calls.filter(([method]) => method === 'system.capture.clear'),
  ).toHaveLength(1);
});

it('shows active legacy settings beside disabled advanced scopes and clears only legacy', async () => {
  const legacy = snapshot.rows.find((r) => r.channel === 'winhttpLegacy')!;
  legacy.values = {
    enabled: true,
    server: 'http=127.0.0.1:10808;https=127.0.0.1:10808',
    bypass: 'localhost;127.*',
    pacUrl: '',
    autoDetect: false,
  };
  const user = snapshot.rows.find((r) => r.channel === 'winhttpUser')!;
  user.supported = user.advancedSupported = true;
  snapshot.rows.find((r) => r.channel === 'winhttpMachine')!.advancedSupported = true;
  const advancedBefore = structuredClone(
    snapshot.rows.filter((r) => ['winhttpMachine', 'winhttpUser'].includes(r.channel)),
  );
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.clear') {
      legacy.values = { enabled: false, server: '', bypass: '', pacUrl: '', autoDetect: false };
      legacy.version = 'legacy-cleared';
    }
    return structuredClone(snapshot);
  });
  await render();
  await act(async () => button('WinHTTP').click());
  const selected = host.querySelector<HTMLInputElement>('input[name="winhttp-scope"]:checked')!;
  expect(selected.value).toBe('winhttpLegacy');
  expect(selected.closest('label')!.textContent).toContain('On');
  expect(host.querySelector('input[value="winhttpUser"]')!.closest('label')!.textContent).toContain(
    'Off',
  );
  expect(host.textContent).toContain('http=127.0.0.1:10808;https=127.0.0.1:10808');
  await act(async () => button('Clear').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.clear', {
    channel: 'winhttpLegacy',
    expectedVersion: 'winhttpLegacy-v',
  });
  expect(selected.closest('label')!.textContent).toContain('Off');
  expect(
    snapshot.rows.filter((r) => ['winhttpMachine', 'winhttpUser'].includes(r.channel)),
  ).toEqual(advancedBefore);
});
it('clearing the user advanced scope leaves an active legacy proxy visible', async () => {
  snapshot.rows.find((r) => r.channel === 'winhttpLegacy')!.values = {
    enabled: true,
    server: 'legacy.example:8080',
  };
  snapshot.rows.find((r) => r.channel === 'winhttpUser')!.supported = true;
  await render();
  await act(async () => button('WinHTTP').click());
  await scope('winhttpUser');
  await act(async () => button('Clear').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.clear', {
    channel: 'winhttpUser',
    expectedVersion: 'winhttpUser-v',
  });
  expect(
    host.querySelector('input[value="winhttpLegacy"]')!.closest('label')!.textContent,
  ).toContain('On');
});

it('allows machine-wide Windows proxy actions with the exact version shown', async () => {
  snapshot.rows[0].scope = 'machine';
  await render();
  expect(host.textContent).toContain('All users · default LAN');
  expect(button('Clear').disabled).toBe(false);
  await select('Proxy inbound', 'local-http');
  await act(async () => button('Set').click());
  expect(serviceCall).toHaveBeenCalledWith(
    'system.capture.set',
    expect.objectContaining({
      channel: 'wininet',
      expectedVersion: 'wininet-v',
      inputTag: 'local-http',
    }),
  );
  snapshot.rows[0].managed = true;
  snapshot.rows[0].version = 'machine-managed';
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Refresh system capture settings"]')!
      .click(),
  );
  expect(host.textContent).toContain('All users · default LAN');
  await act(async () => button('Restore previous').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.restore', {
    channel: 'wininet',
    expectedVersion: 'machine-managed',
  });
});

it('applies a selected Windows proxy scope directly and refreshes the actual scope', async () => {
  Object.assign(snapshot.rows[0], { scope: 'user', scopeSwitchSupported: true });
  const original = vi.mocked(serviceCall).getMockImplementation()!;
  vi.mocked(serviceCall).mockImplementation(async (method, params) => {
    if (method === 'system.capture.setScope') {
      Object.assign(snapshot.rows[0], { scope: params?.scope, version: 'new-scope-v' });
      return {};
    }
    return original(method, params);
  });
  await render();
  await select('Windows proxy scope', 'machine');
  expect(serviceCall).toHaveBeenCalledWith('system.capture.setScope', {
    scope: 'machine',
    expectedVersion: 'wininet-v',
  });
  expect(host.textContent).toContain('All users · default LAN');
  expect(
    host.querySelector<HTMLSelectElement>('select[aria-label="Windows proxy scope"]')!.value,
  ).toBe('machine');
});
it('blocks proxy actions while the selected scope is being changed', async () => {
  Object.assign(snapshot.rows[0], { scope: 'user', scopeSwitchSupported: true });
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = vi.mocked(serviceCall).getMockImplementation()!;
  vi.mocked(serviceCall).mockImplementation(async (method, params) => {
    if (method === 'system.capture.setScope') await pending;
    return original(method, params);
  });
  await render();
  await select('Windows proxy scope', 'machine');
  expect(button('Set').disabled).toBe(true);
  expect(button('Clear').disabled).toBe(true);
  expect(
    host.querySelector<HTMLSelectElement>('select[aria-label="Windows proxy scope"]')!.disabled,
  ).toBe(true);
  await act(async () => {
    finish();
  });
});
