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
it('allows leaving a slow read but guards closing while Windows settings change', async () => {
  let finishRead!: (value: SystemCaptureSnapshot) => void;
  const read = new Promise<SystemCaptureSnapshot>((resolve) => {
    finishRead = resolve;
  });
  vi.mocked(serviceCall).mockReturnValueOnce(read);
  const close = vi.fn();
  await act(async () =>
    root.render(
      <SystemCaptureSettings
        graph={graph}
        compiled={compiled}
        onApply={vi.fn()}
        onClose={close}
        onRuntimeRefresh={async () => {}}
      />,
    ),
  );
  const dialog = host.querySelector('dialog')!;
  const escape = () => {
    const event = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(button('Close').disabled).toBe(false);
  expect(escape()).toBe(false);
  await act(async () => button('Close').click());
  expect(close).toHaveBeenCalledOnce();
  await act(async () => finishRead(structuredClone(snapshot)));

  let finishChange!: () => void;
  const change = new Promise<void>((resolve) => {
    finishChange = resolve;
  });
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.clear') await change;
    if (method === 'system.capture.get') return structuredClone(snapshot);
    return {};
  });
  await act(async () => button('Clear').click());
  expect(button('Close').disabled).toBe(true);
  expect(escape()).toBe(true);
  await act(async () => button('Close').click());
  expect(close).toHaveBeenCalledOnce();
  await act(async () => finishChange());
  expect(button('Close').disabled).toBe(false);
  expect(escape()).toBe(false);
});
it('keeps the parent closable during a slow embedded loopback read', async () => {
  await render();
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'windows.loopback.get') return pending;
    return { interfaces: [], processes: [], services: [], packages: [] };
  });
  await act(async () => button('Loopback').click());
  expect(host.textContent).toContain('Loading permissions');
  expect(button('Close').disabled).toBe(false);
  const event = new Event('cancel', { cancelable: true });
  host.querySelector('dialog')!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  await act(async () => finish({ version: 'loopback-v', packages: [], unmatched: [] }));
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
it('disables assignments to edited listeners while preserving clear and restore access', async () => {
  const changed = structuredClone(compiled);
  (changed.config.inbounds as { port: number }[])[1].port = 3081;
  await render(changed);
  await select('Proxy inbound', 'local-http');
  expect(button('Set').disabled).toBe(true);
  expect(button('Clear').disabled).toBe(false);
  expect(host.textContent).toContain('Apply the selected graph input first.');
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
it('offers PAC/discovery only where the native backend supports them', async () => {
  await render();
  await act(async () => button('WinHTTP').click());
  const option = [...host.querySelectorAll<HTMLOptionElement>('option[value="automatic"]')].find(
    (o) => !o.closest('[hidden]'),
  )!;
  expect(option.disabled).toBe(true);
  await scope('winhttpUser');
  expect(button('Set').disabled).toBe(true);
});
it('only offers the manual bypass list in WinHTTP graph-input mode', async () => {
  snapshot.rows.find((row) => row.channel === 'winhttpMachine')!.advancedSupported = true;
  await render();
  await act(async () => button('WinHTTP').click());
  await scope('winhttpMachine');
  const visibleBypass = () =>
    [...host.querySelectorAll('input[aria-label="Proxy bypass"]')].filter(
      (i) => !i.closest('[hidden]'),
    );
  expect(visibleBypass()).toHaveLength(1);
  await select('Proxy mode', 'automatic');
  expect(visibleBypass()).toHaveLength(0);
  await select('Proxy mode', 'proxy');
  expect(visibleBypass()).toHaveLength(1);
});
it('stops packet capture without issuing core.stop or a settings mutation', async () => {
  snapshot.capture.state = 'running';
  snapshot.capture.inputs = ['capture-one'];
  await render();
  await act(async () => button('WinDivert').click());
  await act(async () => button('Stop capture').click());
  expect(serviceCall).toHaveBeenCalledWith('capture.stop', {});
  expect(vi.mocked(serviceCall).mock.calls.some(([method]) => method === 'core.stop')).toBe(false);
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
it('opening settings and changing tabs never registers a driver or captures packets', async () => {
  await render();
  await act(async () => button('WinDivert').click());
  await act(async () => button('Loopback').click());
  expect(
    vi
      .mocked(serviceCall)
      .mock.calls.every(([method]) =>
        ['system.capture.get', 'windows.catalog', 'windows.loopback.get'].includes(method),
      ),
  ).toBe(true);
});
it('shows external conflicts and keeps fresh clear/restore actions available', async () => {
  snapshot.rows[0].conflict = true;
  snapshot.rows[0].managed = true;
  await render();
  expect(button('Set').disabled).toBe(true);
  expect(button('Restore previous').disabled).toBe(false);
  expect(button('Keep external settings')).toBeTruthy();
  await act(async () => button('Keep external settings').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.keepExternal', {
    channel: 'wininet',
    expectedVersion: 'wininet-v',
  });
});

it('does not show a successful settings change as a success on another tab or scope', async () => {
  await render();
  await act(async () => button('Environment').click());
  await act(async () => button('Clear').click());
  expect(host.querySelector('.system-capture-feedback')?.textContent).toContain(
    'Settings cleared.',
  );
  await select('Environment scope', 'envMachine');
  expect(host.querySelector('.system-capture-feedback')?.textContent).not.toContain(
    'Settings cleared.',
  );
  await act(async () => button('WinDivert').click());
  expect(host.querySelector('.system-capture-feedback')?.textContent).not.toContain(
    'Settings cleared.',
  );
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

it('inspects an unavailable WinHTTP scope without changing Windows settings', async () => {
  vi.mocked(serviceCall).mockImplementation(async (method) => {
    if (method === 'system.capture.get') return structuredClone(snapshot);
    if (method === 'system.capture.diagnose')
      return {
        channel: 'winhttpUser',
        advanced: { stdout: 'unfamiliar output', exitCode: 0 },
        parseError: { code: 'SETTINGS_FORMAT', message: 'Unfamiliar' },
      };
    return {};
  });
  await render();
  await act(async () => button('WinHTTP').click());
  await scope('winhttpUser');
  expect(button('Set').disabled).toBe(true);
  expect(button('Inspect WinHTTP').disabled).toBe(false);
  await act(async () => button('Inspect WinHTTP').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.diagnose', { channel: 'winhttpUser' });
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WinHTTP diagnostics"]')?.value,
  ).toContain('unfamiliar output');
  expect(
    vi
      .mocked(serviceCall)
      .mock.calls.every(([method]) =>
        ['system.capture.get', 'system.capture.diagnose'].includes(method),
      ),
  ).toBe(true);
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
it('inspects the legacy machine scope and exposes locale-independent native values', async () => {
  vi.mocked(serviceCall).mockImplementation(async (method) =>
    method === 'system.capture.get'
      ? structuredClone(snapshot)
      : {
          legacy: { kind: 'winhttp', access: 3, proxy: 'legacy.example:8080', bypass: '<local>' },
          legacyError: null,
        },
  );
  await render();
  await act(async () => button('WinHTTP').click());
  await act(async () => button('Inspect WinHTTP').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.diagnose', { channel: 'winhttpLegacy' });
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WinHTTP diagnostics"]')!.value,
  ).toContain('legacy.example:8080');
});

it('leaves other capture channels usable when Windows proxy state is unavailable', async () => {
  const row = snapshot.rows.find((r) => r.channel === 'wininet')!;
  row.supported = false;
  row.error = { message: 'Windows proxy state could not be read.' };
  await render();
  expect(host.textContent).toContain(row.error.message);
  expect(button('Clear').disabled).toBe(true);
  await act(async () => button('Environment').click());
  expect(button('Clear').disabled).toBe(false);
  await act(async () => button('Clear').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.clear', {
    channel: 'envUser',
    expectedVersion: 'envUser-v',
  });
});
it('session instructions show the effective merged environment in either scope', async () => {
  snapshot.rows.find((r) => r.channel === 'envUser')!.values = {
    http_proxy: 'http://user.example:8080',
  };
  snapshot.rows.find((r) => r.channel === 'envMachine')!.values = {
    http_proxy: 'http://system.example:8081',
    https_proxy: 'http://system.example:8082',
  };
  await render();
  await act(async () => button('Environment').click());
  expect(host.textContent).toContain('inherited from system');
  const first = host.querySelector('pre')!.textContent;
  expect(first).toContain("$env:http_proxy = 'http://user.example:8080'");
  expect(first).toContain("$env:https_proxy = 'http://system.example:8082'");
  await select('Environment scope', 'envMachine');
  expect(host.textContent).toContain('User override: http://user.example:8080');
  expect(host.querySelector('pre')!.textContent).toBe(first);
});

it('automatic Windows proxy mode does not offer an inactive manual bypass field', async () => {
  await render();
  await select('Proxy mode', 'automatic');
  const visible = [...host.querySelectorAll('input[aria-label="Proxy bypass"]')].filter(
    (i) => !i.closest('[hidden]'),
  );
  expect(visible).toHaveLength(0);
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
it('shows policy scope changes as recoverable conflicts instead of redirecting the lease', async () => {
  Object.assign(snapshot.rows[0], {
    scope: 'machine',
    managed: true,
    conflict: true,
    scopeConflict: true,
  });
  await render();
  expect(host.textContent).toContain('Windows changed the proxy scope.');
  expect(host.textContent).toContain('All users · default LAN');
  expect(button('Set').disabled).toBe(true);
  expect(button('Clear').disabled).toBe(true);
  expect(button('Restore previous').disabled).toBe(true);
  await act(async () => button('Keep external settings').click());
  expect(serviceCall).toHaveBeenCalledWith('system.capture.keepExternal', {
    channel: 'wininet',
    expectedVersion: 'wininet-v',
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
it('allows switching back to recover an assignment deactivated by external policy', async () => {
  Object.assign(snapshot.rows[0], {
    scope: 'machine',
    scopeSwitchSupported: true,
    managed: true,
    scopeConflict: true,
    conflict: true,
  });
  await render();
  expect(host.textContent).toContain('Changing scope restores the previous Wayrill assignment.');
  expect(button('Clear').disabled).toBe(true);
  await select('Windows proxy scope', 'user');
  expect(serviceCall).toHaveBeenCalledWith('system.capture.setScope', {
    scope: 'user',
    expectedVersion: 'wininet-v',
  });
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
