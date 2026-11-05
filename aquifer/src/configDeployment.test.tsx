// @vitest-environment jsdom
import { act } from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConfigDeploymentDialog from './ConfigDeploymentDialog';
import type { ConfigValidation, RemoteClient, ServerJob } from './remoteClient';

let host: HTMLDivElement, root: Root, client: RemoteClient;
let applied = vi.fn<(sha256: string) => void>(),
  close = vi.fn<() => void>();
const text = '{"password":"fictional-private-draft"}';
const validation = (): ConfigValidation => ({
  version: 1,
  id: 'b'.repeat(32),
  valid: true,
  path: '/etc/xray/config.json',
  service: 'xray.service',
  configSha256: 'c'.repeat(64),
  sourceSha256: 'a'.repeat(64),
  coreVersion: '26.10.31',
  checkedAt: Date.now() / 1000,
  expiresAt: Date.now() / 1000 + 900,
  logs: ['Configuration OK.'],
  message: 'Validated as the running service user.',
});
const progress = (id: string, state: ServerJob['state'] = 'running'): ServerJob => ({
  version: 1,
  id,
  action: 'applyConfig',
  state,
  stage: state === 'succeeded' ? 'Completed' : 'Revalidating configuration',
  percent: 15,
  message: '',
  logs: [],
  createdAt: Date.now() / 1000,
  updatedAt: Date.now() / 1000,
  bootId: 'boot',
  configResult: {
    path: '/etc/xray/config.json',
    service: 'xray.service',
    planId: 'b'.repeat(32),
    backupPath: '/private/job/config.backup',
    originalSha256: 'a'.repeat(64),
    installedSha256: 'c'.repeat(64),
    rollback: 'not-needed',
  },
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};
async function mount(changed = true) {
  await act(async () =>
    root.render(
      <ConfigDeploymentDialog
        client={client}
        sessionId="Example"
        server="Example server"
        path="/etc/xray/config.json"
        expectedSha256={'a'.repeat(64)}
        configText={text}
        services={['xray.service']}
        changed={changed}
        onApplied={applied}
        onClose={close}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash('sha256')
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  applied = vi.fn();
  close = vi.fn();
  client = {
    validateConfig: vi.fn().mockImplementation(async () => validation()),
    startAction: vi.fn().mockImplementation(async (_session, request) => progress(request.id)),
    pollAction: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  } as unknown as RemoteClient;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('requires fresh server validation and explicit confirmation; persists no draft credentials', async () => {
  await mount();
  expect(button('Apply…').disabled).toBe(true);
  await click('Validate on server');
  expect(client.validateConfig).toHaveBeenCalledWith('Example', {
    path: '/etc/xray/config.json',
    service: 'xray.service',
    expectedSha256: 'a'.repeat(64),
    configText: text,
    stage: true,
  });
  expect(button('Apply…').disabled).toBe(false);
  await click('Apply…');
  expect(client.startAction).not.toHaveBeenCalled();
  await click('Apply & restart');
  const request = vi.mocked(client.startAction).mock.calls[0][1];
  expect(request).toEqual({
    id: expect.stringMatching(/^[a-f0-9]{32}$/),
    action: 'applyConfig',
    planId: 'b'.repeat(32),
  });
  expect(localStorage.getItem('wayrill.remote.job.Example')).not.toContain(
    'fictional-private-draft',
  );
  expect(host.textContent).toContain('Revalidating configuration');
});
it('reports completion, retains the backup path and updates the loaded baseline once', async () => {
  vi.mocked(client.startAction).mockImplementation(async (_session, request) =>
    progress(request.id, 'succeeded'),
  );
  await mount();
  await click('Validate on server');
  await click('Apply…');
  await click('Apply & restart');
  expect(applied).toHaveBeenCalledExactlyOnceWith('c'.repeat(64), null);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Backup on server"]')?.value).toBe(
    '/private/job/config.backup',
  );
});
it('keeps Apply disabled for invalid and unchanged drafts', async () => {
  vi.mocked(client.validateConfig).mockImplementation(async () => ({
    ...validation(),
    id: null,
    valid: false,
    message: 'Rejected by Xray.',
  }));
  await mount();
  await click('Validate on server');
  expect(button('Apply…').disabled).toBe(true);
  expect(host.textContent).toContain('Validation failed');
  vi.mocked(client.validateConfig).mockImplementation(async () => validation());
  await mount(false);
  await click('Validate on server');
  expect(button('Apply…').disabled).toBe(true);
  expect(host.textContent).toContain('matches the loaded configuration');
});
it('expires an approval even while its confirmation is visible', async () => {
  await mount();
  await click('Validate on server');
  await click('Apply…');
  await act(async () => vi.advanceTimersByTimeAsync(900000));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(button('Apply…').disabled).toBe(true);
  expect(client.startAction).not.toHaveBeenCalled();
});
it('invalidates validation when the owning service changes', async () => {
  await mount();
  await click('Validate on server');
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Xray service"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'other.service',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Apply…').disabled).toBe(true);
  expect(host.textContent).not.toContain('Validation passed');
});
it('cancels only unfinished validation on close, and safely ignores its late result', async () => {
  let finish: (value: ConfigValidation) => void = () => {};
  vi.mocked(client.validateConfig).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await click('Validate on server');
  await act(async () => root.unmount());
  root = createRoot(host);
  expect(client.cancel).toHaveBeenCalledOnce();
  await act(async () => finish(validation()));
  expect(applied).not.toHaveBeenCalled();
});
it('reconnects to a submitted deployment without repeating it or marking an unrelated draft applied', async () => {
  localStorage.setItem(
    'wayrill.remote.job.Example',
    JSON.stringify({ id: 'd'.repeat(32), action: 'applyConfig', planId: 'b'.repeat(32) }),
  );
  vi.mocked(client.pollAction).mockResolvedValue(progress('d'.repeat(32), 'succeeded'));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(client.pollAction).toHaveBeenCalledWith('Example', 'd'.repeat(32));
  expect(client.startAction).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Completed');
});
it('closing progress preserves the running server job', async () => {
  await mount();
  await click('Validate on server');
  await click('Apply…');
  await click('Apply & restart');
  await act(async () => root.unmount());
  root = createRoot(host);
  expect(client.cancel).not.toHaveBeenCalled();
  expect(localStorage.getItem('wayrill.remote.job.Example')).toContain('applyConfig');
});

it('rejects a non-restorable companion before uploading or staging it', async () => {
  await act(async () =>
    root.render(
      <ConfigDeploymentDialog
        client={client}
        sessionId="Example"
        server="Example server"
        path="/etc/xray/config.json"
        expectedSha256={'a'.repeat(64)}
        configText={text}
        wayrillText="{}"
        services={['xray.service']}
        changed
        onApplied={applied}
        onClose={close}
      />,
    ),
  );
  await click('Validate on server');
  expect(client.validateConfig).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Unsupported Wayrill Aquifer document.');
});

it('reconciles a completed deployment on reopening only when the current draft still matches its receipt', async () => {
  const id = 'd'.repeat(32);
  const hash = createHash('sha256').update(text).digest('hex');
  localStorage.setItem(
    'wayrill.remote.job.Example',
    JSON.stringify({ id, action: 'applyConfig', planId: 'b'.repeat(32) }),
  );
  const result = progress(id, 'succeeded');
  result.configResult!.installedSha256 = hash;
  vi.mocked(client.pollAction).mockResolvedValue(result);
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(applied).toHaveBeenCalledExactlyOnceWith(hash, null);
  expect(client.startAction).not.toHaveBeenCalled();
});

it.each(['path', 'source', 'companion'] as const)(
  'does not reconcile a restored receipt with a different %s',
  async (field) => {
    const id = 'e'.repeat(32);
    localStorage.setItem(
      'wayrill.remote.job.Example',
      JSON.stringify({ id, action: 'applyConfig', planId: 'b'.repeat(32) }),
    );
    const result = progress(id, 'succeeded');
    result.configResult!.installedSha256 = createHash('sha256').update(text).digest('hex');
    if (field === 'path') result.configResult!.path = '/etc/xray/other.json';
    if (field === 'source') result.configResult!.originalSha256 = 'f'.repeat(64);
    if (field === 'companion') result.configResult!.wayrillSha256 = 'f'.repeat(64);
    vi.mocked(client.pollAction).mockResolvedValue(result);
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(applied).not.toHaveBeenCalled();
    expect(client.startAction).not.toHaveBeenCalled();
  },
);
