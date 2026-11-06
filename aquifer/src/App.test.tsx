// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { demoConfig } from './demo';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { remoteView } from './remoteModel';
import { emptyLayout, saveRemoteDocument } from './remoteDocument';
import { exportJson, type UserStore } from './users/storage';
import type {
  RemoteClient,
  ConfigSnapshot,
  Discovery,
  SessionInventory,
  ServerStatus,
  ServerJob,
  UpgradePlan,
} from './remoteClient';

const canvasActions = vi.hoisted(() => ({
  fit: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  focus: vi.fn(),
  placement: vi.fn().mockReturnValue({ x: 840, y: 600 }),
}));
vi.mock('./RemoteCanvas', async () => {
  const { useImperativeHandle } = await import('react');
  return {
    default: ({
      ref,
      view,
      onSelect,
      onEdit,
      onContext,
      layout,
      onLayout,
    }: {
      ref: import('react').Ref<typeof canvasActions>;
      view: import('./remoteModel').RemoteView;
      onSelect: (id: string) => void;
      onEdit: (id: string) => void;
      onContext: (id: string, opener: HTMLElement, x: number, y: number) => void;
      layout: import('./remoteDocument').RemoteLayout;
      onLayout: (change: Partial<import('./remoteDocument').RemoteLayout>) => void;
    }) => {
      useImperativeHandle(ref, () => canvasActions, []);
      return (
        <div data-testid="canvas" data-layout={JSON.stringify(layout)}>
          Canvas ready
          {view.nodes.map((node) => (
            <button
              key={node.id}
              data-node-title={node.data.title}
              onClick={() => onSelect(node.id)}
            >
              <span>{node.data.title}</span>
              <small>{node.data.subtitle}</small>
            </button>
          ))}
          <button onClick={() => onLayout({ positions: { 'native-in-0': { x: 420, y: 180 } } })}>
            Move fixture node
          </button>
          <button
            onDoubleClick={() => onEdit('native-out-0')}
            onContextMenu={(event) => {
              event.preventDefault();
              onContext('native-out-0', event.currentTarget, 20, 30);
            }}
          >
            Canvas Direct node
          </button>
        </div>
      );
    },
  };
});
vi.mock('./users/storage', async (original) => ({
  ...(await original<typeof import('./users/storage')>()),
  exportJson: vi.fn().mockResolvedValue(undefined),
}));
let host: HTMLDivElement, root: Root, client: RemoteClient;
let credentialStore: UserStore;
const inventory: SessionInventory = {
  sessions: [{ id: 'FlauntVPN', name: 'FlauntVPN', host: 'example.net', user: 'root', port: 22 }],
  executable: 'C:\\WinSCP\\WinSCP.exe',
  executableVersion: '6.5.7.0',
  compatibilityError: null,
  source: 'Windows registry · current user',
  selectedConfig: 'auto',
  configs: [],
  windowsUser: 'PC\\Alice',
  warnings: [],
};
const snapshot: ConfigSnapshot = {
  path: '/etc/xray/config.json',
  text: JSON.stringify(demoConfig),
  bytes: 2000,
  sha256: 'a'.repeat(64),
};
const discovery: Discovery = {
  version: 1,
  hostname: 'demo-linux',
  processes: [
    { pid: 77, executable: '/usr/bin/xray', configPaths: [snapshot.path], configDirectories: [] },
  ],
  files: [
    {
      path: snapshot.path,
      size: 2000,
      modified: 0,
      source: 'Running process argument',
      running: true,
      readable: true,
    },
  ],
  warnings: [],
};
const serverStatus: ServerStatus = {
  version: 1,
  hostname: 'demo-linux',
  checkedAt: 1792512000,
  user: 'root',
  uid: 0,
  reboot: { required: true, packages: ['linux-image'], error: null },
  xray: {
    installedVersion: '26.10.17',
    binary: '/usr/bin/xray',
    processes: [{ pid: 77, executable: '/usr/bin/xray', replacedExecutable: false }],
    services: [
      {
        name: 'xray.service',
        activeState: 'active',
        subState: 'running',
        mainPid: 77,
        startedAt: 'Mon 2026-10-19 00:00:00 UTC',
        unitFileState: 'enabled',
        needsDaemonReload: false,
      },
    ],
    error: null,
  },
  apt: {
    available: true,
    packages: [
      { name: 'curl', installedVersion: '1.0', candidateVersion: '2.0', source: 'Debian:stable' },
    ],
    upgraded: 1,
    heldBack: 2,
    indexesUpdatedAt: 1792425600,
    error: null,
  },
};
const upgradePlan: UpgradePlan = {
  version: 1,
  id: 'b'.repeat(32),
  hostname: 'demo-linux',
  createdAt: 100,
  expiresAt: 1000,
  installs: [
    { name: 'new-lib', architecture: 'amd64', installedVersion: null, candidateVersion: '3.0' },
  ],
  upgrades: [
    { name: 'curl', architecture: 'amd64', installedVersion: '1.0', candidateVersion: '2.0' },
  ],
  removals: [
    {
      name: 'obsolete-lib',
      architecture: 'amd64',
      installedVersion: '0.5',
      candidateVersion: null,
    },
  ],
  heldBack: 2,
};
const button = (label: string) =>
  [
    ...host.querySelectorAll('button'),
    ...document.querySelectorAll<HTMLButtonElement>('.node-context-menu button'),
  ].find(
    (b) =>
      b.getAttribute('aria-label') === label ||
      (b.querySelector('.menu-item-text')?.textContent ?? b.textContent)?.trim() === label,
  )!;

async function menuAction(menu: string, item: string) {
  await act(async () => button(menu).click());
  await act(async () => button(item).click());
}

it('opens the xray.service config before an auxiliary daemon', async () => {
  const main = { ...discovery.files[0], path: '/srv/main/config.json', services: ['xray.service'] };
  vi.mocked(client.discover).mockResolvedValueOnce({
    ...discovery,
    files: [{ ...discovery.files[0], services: ['xray-vnc.service'] }, main],
  });
  await act(async () => button('Read server').click());
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', main.path);
});

it('edits and exports an outbound from the stash without changing the policy group', async () => {
  await act(async () => button('Read server').click());
  await act(async () => button('Stash').click());
  expect(host.textContent).toContain('Candidate · regional');
  const search = host.querySelector<HTMLInputElement>(
    '[aria-label="Find stashed configurations"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'relay',
    );
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit relay-eu"]')!.click(),
  );
  const input = host.querySelector<HTMLInputElement>('dialog [aria-label="Server address"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'edited.example.net',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Apply changes').click());
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Find stashed configurations"]')!.value,
  ).toBe('relay');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close stash"]')!.click(),
  );
  await menuAction('File', 'Export Xray configuration…');
  const exported = JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]);
  expect(exported.outbounds[2].settings.address).toBe('edited.example.net');
  expect(exported.routing).toEqual(demoConfig.routing);
});
beforeEach(async () => {
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  localStorage.clear();
  vi.mocked(exportJson).mockClear();
  credentialStore = {
    load: vi.fn().mockResolvedValue(emptyLibrary()),
    save: vi.fn().mockResolvedValue(undefined),
  };
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  let resolveSessions: (sessions: SessionInventory) => void = () => {};
  const sessionPromise = new Promise<SessionInventory>((resolve) => {
    resolveSessions = resolve;
  });
  client = {
    sessions: vi.fn().mockReturnValue(sessionPromise),
    discover: vi.fn().mockResolvedValue(discovery),
    read: vi.fn().mockResolvedValue(snapshot),
    serverStatus: vi.fn().mockResolvedValue(serverStatus),
    previewUpgrade: vi.fn().mockResolvedValue(upgradePlan),
    validateConfig: vi.fn(),
    startAction: vi.fn().mockImplementation((_session, request) =>
      Promise.resolve({
        ...request,
        version: 1,
        state: 'running',
        stage: 'Preparing',
        percent: null,
        message: '',
        logs: [],
        createdAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000,
        bootId: 'boot-before',
      } satisfies ServerJob),
    ),
    pollAction: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    choose: vi.fn().mockResolvedValue(null),
    setConfig: vi.fn().mockResolvedValue(inventory),
    resetSetup: vi.fn().mockResolvedValue(inventory),
  };
  await act(async () => {
    root.render(<App client={client} credentialStore={credentialStore} />);
  });
  await act(async () => {
    resolveSessions(inventory);
    await sessionPromise;
  });
});
it('opens User sets from the inbound editor and returns to its unsaved draft', async () => {
  await act(async () => button('Read server').click());
  const entry = [...host.querySelectorAll('button')].find(
    (item) =>
      item.textContent?.includes('public-vless') &&
      item.textContent?.includes('VLESS') &&
      !item.textContent?.includes('users'),
  )!;
  await act(async () => entry.click());
  await act(async () => button('Edit…').click());
  const tag = host.querySelector<HTMLInputElement>('[aria-label="Tag"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      tag,
      'new-server-tag',
    );
    tag.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Manage users').click());
  expect(host.querySelector('dialog[aria-label="User sets"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close user sets"]')!.click(),
  );
  expect(host.querySelector<HTMLInputElement>('[aria-label="Tag"]')!.value).toBe('new-server-tag');
  expect(client.read).toHaveBeenCalledOnce();
});
it('previews installations, upgrades and removals before confirming dist-upgrade', async () => {
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  expect(client.previewUpgrade).toHaveBeenCalledWith('FlauntVPN');
  expect(client.startAction).not.toHaveBeenCalled();
  const preview = host.querySelector('[role="alertdialog"]')!;
  expect(preview.textContent).toContain('new-lib');
  expect(preview.textContent).toContain('obsolete-lib');
  expect(preview.textContent).toContain('2.0');
  expect(preview.querySelector('[aria-label="Removals"]')?.textContent).toContain('0.5');
  await act(async () => button('Install full upgrade').click());
  expect(client.startAction).toHaveBeenCalledWith(
    'FlauntVPN',
    expect.objectContaining({ action: 'distUpgrade', planId: upgradePlan.id }),
  );
});
it('cancels a full upgrade without starting a mutation', async () => {
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  await act(async () => button('Cancel').click());
  expect(client.startAction).not.toHaveBeenCalled();
});
it('reports failed previews and does not enable a full upgrade', async () => {
  vi.mocked(client.previewUpgrade).mockRejectedValue({
    code: 'APT_PLAN',
    message: 'APT cannot calculate a plan.',
  });
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  expect(host.querySelector('dialog')?.textContent).toContain('APT cannot calculate a plan.');
  expect(button('Install full upgrade')).toBeUndefined();
  expect(button('Full upgrade…').disabled).toBe(false);
});
it('shows an empty full-upgrade preview without permitting a redundant install', async () => {
  vi.mocked(client.previewUpgrade).mockResolvedValue({
    ...upgradePlan,
    installs: [],
    upgrades: [],
    removals: [],
  });
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  expect(button('Install full upgrade').disabled).toBe(true);
  expect(client.startAction).not.toHaveBeenCalled();
});
it('does not open a late preview after its cancellation', async () => {
  let finish: (value: UpgradePlan) => void = () => {};
  vi.mocked(client.previewUpgrade).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  await act(async () => button('Cancel').click());
  await act(async () => finish(upgradePlan));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(client.cancel).toHaveBeenCalled();
});
it('paginates full-upgrade removals without hiding the remaining changes', async () => {
  vi.mocked(client.previewUpgrade).mockResolvedValue({
    ...upgradePlan,
    removals: Array.from({ length: 201 }, (_, index) => ({
      name: `remove-${index}`,
      architecture: 'amd64',
      installedVersion: '1',
      candidateVersion: null,
    })),
  });
  await act(async () => button('Server status').click());
  await act(async () => button('Full upgrade…').click());
  const section = host.querySelector('[aria-label="Removals"]')!;
  expect(section.querySelectorAll('tbody tr')).toHaveLength(100);
  expect(section.textContent).toContain('201');
  await act(async () =>
    section.querySelector<HTMLButtonElement>('[aria-label="Next removals"]')!.click(),
  );
  expect(section.textContent).toContain('remove-100');
  expect(section.querySelectorAll('tbody tr')).toHaveLength(100);
});
it('reads server health without downloading a configuration', async () => {
  await act(async () => button('Server status').click());
  expect(client.serverStatus).toHaveBeenCalledWith('FlauntVPN');
  expect(client.read).not.toHaveBeenCalled();
  const dialog = host.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Required');
  expect(dialog.textContent).toContain('Running');
  expect(dialog.textContent).toContain('xray.service');
  expect(dialog.textContent).toContain('1 upgrade');
  expect(dialog.textContent).toContain('2 packages kept back');
  expect(dialog.textContent).toContain('Available updates from cached package lists');
  expect(dialog.textContent).toContain('26.10.17');
  expect(dialog.textContent).toContain('SSH user: root');
});
it('disconnects before clearing a remote configuration', async () => {
  await act(async () => button('Read server').click());
  expect(host.textContent).toContain('Canvas ready');
  await menuAction('File', 'Close configuration');
  expect(client.disconnect).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('Canvas ready');
});
it('waits for disconnect before switching servers', async () => {
  vi.mocked(client.sessions).mockResolvedValue({
    ...inventory,
    sessions: [
      ...inventory.sessions,
      { id: 'Other', name: 'Other', host: 'other.example', user: 'root', port: 22 },
    ],
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh saved sessions"]')!.click(),
  );
  let finish: () => void = () => {};
  vi.mocked(client.disconnect).mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const select = host.querySelector<HTMLSelectElement>('#saved-session')!;
  await act(async () => {
    select.value = 'Other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Read server').disabled).toBe(true);
  expect(client.discover).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(select.value).toBe('Other');
  await act(async () => button('Read server').click());
  expect(client.discover).toHaveBeenCalledWith('Other');
});
it('preserves the displayed graph if disconnect fails', async () => {
  await act(async () => button('Read server').click());
  vi.mocked(client.disconnect).mockRejectedValue({ message: 'Could not disconnect.' });
  await menuAction('File', 'Close configuration');
  expect(host.textContent).toContain('Canvas ready');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not disconnect.');
  expect(button('Refresh from server').disabled).toBe(false);
});
it('requires confirmation for package installation and pins the row version', async () => {
  await act(async () => button('Server status').click());
  await act(async () => button('Install').click());
  expect(client.startAction).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('Update curl?');
  await act(async () => button('Confirm').click());
  expect(client.startAction).toHaveBeenCalledWith(
    'FlauntVPN',
    expect.objectContaining({
      action: 'upgradePackage',
      package: 'curl',
      candidateVersion: '2.0',
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
    }),
  );
  expect(button('Reboot server').disabled).toBe(true);
  expect(host.querySelector('progress')).not.toBeNull();
});
it('does not submit a cancelled reboot or restart', async () => {
  await act(async () => button('Server status').click());
  await act(async () => button('Reboot server').click());
  await act(async () => button('Cancel').click());
  expect(client.startAction).not.toHaveBeenCalled();
  await act(async () => button('Restart').click());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Restart xray.service?',
  );
  await act(async () => button('Confirm').click());
  expect(client.startAction).toHaveBeenCalledWith(
    'FlauntVPN',
    expect.objectContaining({ action: 'restartXray', service: 'xray.service' }),
  );
});
it('retains a running job when its progress window closes', async () => {
  await act(async () => button('Server status').click());
  await act(async () => button('Refresh package lists').click());
  const request = vi.mocked(client.startAction).mock.calls[0]![1];
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('dialog button[aria-label="Close server status"]')!
      .click(),
  );
  expect(localStorage.getItem('wayrill.remote.job.FlauntVPN')).toContain(request.id);
  expect(client.cancel).not.toHaveBeenCalled();
  expect(client.startAction).toHaveBeenCalledTimes(1);
});
it('reconnects to persisted progress after closing without submitting twice', async () => {
  vi.useFakeTimers();
  try {
    await act(async () => button('Server status').click());
    await act(async () => button('Refresh package lists').click());
    const request = vi.mocked(client.startAction).mock.calls[0]![1];
    vi.mocked(client.pollAction).mockResolvedValue({
      ...request,
      version: 1,
      state: 'succeeded',
      stage: 'Completed',
      percent: 100,
      message: '',
      logs: ['Completed safely'],
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      bootId: 'before',
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('dialog button[aria-label="Close server status"]')!
        .click(),
    );
    await act(async () => button('Server status').click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.pollAction).toHaveBeenCalledWith('FlauntVPN', request.id);
    expect(client.startAction).toHaveBeenCalledTimes(1);
    expect(host.querySelector('dialog')?.textContent).toContain('Completed safely');
    expect(button('Reboot server').disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('recovers a lost start acknowledgement by polling instead of repeating it', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(client.startAction).mockRejectedValue({
      code: 'CONNECT',
      message: 'SSH disconnected.',
    });
    await act(async () => button('Server status').click());
    await act(async () => button('Refresh package lists').click());
    const request = vi.mocked(client.startAction).mock.calls[0]![1];
    vi.mocked(client.pollAction).mockResolvedValue({
      ...request,
      version: 1,
      state: 'succeeded',
      stage: 'Completed',
      percent: 100,
      message: '',
      logs: [],
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      bootId: 'before',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.startAction).toHaveBeenCalledTimes(1);
    expect(client.pollAction).toHaveBeenCalledWith('FlauntVPN', request.id);
    expect(button('Reboot server').disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('leaves the panel usable when noninteractive sudo is unavailable', async () => {
  vi.mocked(client.startAction).mockRejectedValue({
    code: 'SUDO',
    message: 'Noninteractive sudo is required.',
  });
  await act(async () => button('Server status').click());
  await act(async () => button('Refresh package lists').click());
  expect(host.querySelector('dialog')?.textContent).toContain('Noninteractive sudo is required.');
  await act(async () => button('Dismiss').click());
  expect(button('Reboot server').disabled).toBe(false);
});
it('keeps the graph and previous status when a status refresh fails', async () => {
  await act(async () => button('Read server').click());
  await act(async () => button('Server status').click());
  vi.mocked(client.serverStatus).mockRejectedValue({ message: 'SSH unavailable.' });
  await act(async () => button('Refresh').click());
  expect(host.querySelector('dialog')!.textContent).toContain('SSH unavailable.');
  expect(host.querySelector('dialog')!.textContent).toContain('xray.service');
  expect(host.textContent).toContain('Canvas ready');
});
it('cancels an in-flight status check and ignores its late result', async () => {
  let finish: (status: ServerStatus) => void = () => {};
  vi.mocked(client.serverStatus).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button('Server status').click());
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('dialog button[aria-label="Close server status"]')!
      .click(),
  );
  expect(client.cancel).toHaveBeenCalled();
  await act(async () => finish(serverStatus));
  expect(host.querySelector('dialog')).toBeNull();
  expect(button('Server status').disabled).toBe(false);
});
it('pages large package lists and searches all results', async () => {
  vi.mocked(client.serverStatus).mockResolvedValue({
    ...serverStatus,
    apt: {
      ...serverStatus.apt,
      upgraded: 205,
      packages: Array.from({ length: 205 }, (_, index) => ({
        name: `package-${index}`,
        installedVersion: '1',
        candidateVersion: '2',
        source: 'Debian',
      })),
    },
  });
  await act(async () => button('Server status').click());
  expect(host.querySelectorAll('.package-table tbody tr')).toHaveLength(100);
  await act(async () => button('Next').click());
  expect(host.querySelectorAll('.package-table tbody tr')).toHaveLength(100);
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search packages"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'package-204',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelectorAll('.package-table tbody tr')).toHaveLength(1);
  expect(host.querySelector('.package-table')!.textContent).toContain('package-204');
});
it('reports unsupported WinSCP before any remote request', async () => {
  vi.mocked(client.sessions).mockResolvedValue({
    ...inventory,
    executableVersion: '5.13.9.9343',
    compatibilityError: 'WinSCP 5.13.9 cannot stream configuration files.',
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh saved sessions"]')!.click(),
  );
  expect(button('Read server').disabled).toBe(true);
  expect(button('Read file').disabled).toBe(true);
  expect(button('Server status').disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('5.13.9');
  expect(client.discover).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('reads a saved session then opens its detected file, without execution controls', async () => {
  await act(async () => button('Read server').click());
  expect(client.discover).toHaveBeenCalledWith('FlauntVPN');
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', snapshot.path);
  expect(host.textContent).toContain('Canvas ready');
  expect(host.textContent).toContain('Routing filter');
  for (const title of ['Start', 'Apply', 'Stop', 'System traffic capture'])
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === title)).toBe(false);
});
it('displays ordered rules and switches to redacted source JSON', async () => {
  await act(async () => button('Read server').click());
  await act(async () => button('Routing filterRouting filter').click());
  expect(host.querySelectorAll('.rule-list>article')).toHaveLength(3);
  await menuAction('View', 'Source JSON…');
  expect(host.querySelector('.json-view')?.textContent).toContain('[hidden]');
  expect(host.querySelector('.json-view')?.textContent).not.toContain(
    '00000000-0000-4000-8000-000000000001',
  );
  await act(async () => button('Reveal credentials').click());
  expect(host.querySelector('.json-view')?.textContent).toContain(
    '00000000-0000-4000-8000-000000000001',
  );
});
it('reports an SSH failure and permits a retry', async () => {
  vi.mocked(client.discover).mockRejectedValueOnce({
    code: 'AUTH',
    message: 'Authentication failed.',
  });
  await act(async () => button('Read server').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Authentication failed.');
  expect(button('Read server').disabled).toBe(false);
  await act(async () => button('Read server').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Canvas ready');
});
it('keeps source inspection available when graph conversion is unsupported', async () => {
  vi.mocked(client.read).mockResolvedValue({
    ...snapshot,
    text: '{"routing":{"rules":[{"outboundTag":"missing"}]}}',
  });
  await act(async () => button('Read server').click());
  expect(host.textContent).toContain('Graph conversion:');
  await act(async () => button('View').click());
  expect(button('Source JSON…').getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => button('Source JSON…').click());
  expect(host.querySelector('.json-view')?.textContent).toContain('missing');
});
it('cancels the actual SSH read and unblocks the UI afterwards', async () => {
  let rejectRead: (reason: unknown) => void = () => {};
  vi.mocked(client.discover).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectRead = reject;
      }),
  );
  await act(async () => button('Read server').click());
  expect(button('Read server').disabled).toBe(true);
  await act(async () => button('Cancel').click());
  expect(client.cancel).toHaveBeenCalled();
  await act(async () => rejectRead({ message: 'SSH read cancelled.' }));
  expect(button('Read server').disabled).toBe(false);
});
it('finds sessions from an explicitly chosen INI and uses its source-bound identity', async () => {
  const ini = 'C:\\Users\\Alice\\WinSCP\\WinSCP.ini';
  vi.mocked(client.choose).mockResolvedValue({
    ...inventory,
    source: ini,
    selectedConfig: ini,
    configs: [ini],
    sessions: [{ ...inventory.sessions[0], id: 'ini-flaunt' }],
  });
  await menuAction('Settings', 'WinSCP setup\u2026');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Choose WinSCP INI file"]')!.click(),
  );
  expect(client.choose).toHaveBeenCalledWith('ini');
  expect(host.textContent).toContain(ini);
  await act(async () => button('Read server').click());
  expect(client.discover).toHaveBeenCalledWith('ini-flaunt');
});
it('shows actionable setup when automatic detection finds no executable or sites', async () => {
  vi.mocked(client.sessions).mockResolvedValue({
    ...inventory,
    executable: null,
    sessions: [],
    warnings: ['WinSCP was not found. Use Locate WinSCP.'],
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh saved sessions"]')!.click(),
  );
  expect(button('Read server').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Locate WinSCP"]')).not.toBeNull();
  expect(host.textContent).toContain('PC\\Alice');
});
it('cancelling the location picker retains the current graph', async () => {
  await act(async () => button('Read server').click());
  await menuAction('Settings', 'WinSCP setup\u2026');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Locate WinSCP"]')!.click(),
  );
  expect(host.textContent).toContain('Canvas ready');
  expect(client.choose).toHaveBeenCalledWith('executable');
});
it('reads the visible default path directly without discovery', async () => {
  expect(host.querySelector<HTMLInputElement>('#remote-path')!.value).toBe(
    '/usr/local/etc/xray/config.json',
  );
  expect(button('Read file').disabled).toBe(false);
  await act(async () => button('Read file').click());
  expect(client.discover).not.toHaveBeenCalled();
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', '/usr/local/etc/xray/config.json');
  expect(host.textContent).toContain('Canvas ready');
});
it('falls back to SFTP when discovery returns no result', async () => {
  vi.mocked(client.discover).mockRejectedValue({
    code: 'DISCOVERY',
    message: 'Python discovery is unavailable.',
  });
  await act(async () => button('Read server').click());
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', '/usr/local/etc/xray/config.json');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Canvas ready');
  await act(async () => host.querySelector<HTMLButtonElement>('.notice-button')!.click());
  expect(host.textContent).toContain('running process was not verified');
});
it('falls back to the edited path when discovery finds no files', async () => {
  vi.mocked(client.discover).mockResolvedValue({ ...discovery, files: [] });
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('#remote-path')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '/etc/xray/custom.json',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Read server').click());
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', '/etc/xray/custom.json');
});
it('reports a failed fallback with its path and discovery context', async () => {
  vi.mocked(client.discover).mockRejectedValue({
    code: 'DISCOVERY',
    message: 'No discovery result.',
  });
  vi.mocked(client.read).mockRejectedValue({ code: 'NOT_FOUND', message: 'File not found.' });
  await act(async () => button('Read server').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    '/usr/local/etc/xray/config.json',
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('File not found.');
  expect(button('Read server').disabled).toBe(false);
});
it('does not start a fallback read after cancellation or a host-key error', async () => {
  let rejectDiscovery: (reason: unknown) => void = () => {};
  vi.mocked(client.discover).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectDiscovery = reject;
      }),
  );
  await act(async () => button('Read server').click());
  await act(async () => button('Cancel').click());
  await act(async () =>
    rejectDiscovery({ code: 'DISCOVERY', message: 'Late unavailable result.' }),
  );
  expect(client.read).not.toHaveBeenCalled();
  expect(button('Read server').disabled).toBe(false);
  vi.mocked(client.discover).mockRejectedValueOnce({
    code: 'HOST_KEY',
    message: 'Verify host key.',
  });
  await act(async () => button('Read server').click());
  expect(client.read).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Verify host key.');
});

const nodeButton = (name: string) =>
  [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="canvas"] button[data-node-title]'),
  ].find((b) => b.querySelector('span')?.textContent === name)!;
const inputValue = async (label: string, value: string) => {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
it('edits multiple users in one set and exports all connected inbounds without changing source JSON', async () => {
  const config = {
    ...demoConfig,
    inbounds: [
      ...demoConfig.inbounds,
      { ...demoConfig.inbounds[0], tag: 'second-vless', port: 8443 },
    ],
  };
  vi.mocked(client.read).mockResolvedValue({ ...snapshot, text: JSON.stringify(config) });
  await act(async () => button('Read server').click());
  expect(credentialStore.save).not.toHaveBeenCalled();
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add user"]')!.click());
  await inputValue('User display name', 'Family member');
  await act(async () => button('Save to library').click());
  const library = vi.mocked(credentialStore.save).mock.calls[0][0];
  expect(library.sets[0].users).toHaveLength(2);
  expect(library.sets[0].users[1].name).toBe('Family member');
  expect(host.querySelector<HTMLInputElement>('[aria-label="User credential"]')!.type).toBe(
    'password',
  );
  await act(async () => button('Apply to graph').click());
  await menuAction('File', 'Export Xray configuration…');
  const exported = JSON.parse(vi.mocked(exportJson).mock.calls[0][1]);
  expect(exported.inbounds[0].settings.clients).toHaveLength(2);
  expect(exported.inbounds[2].settings.clients).toHaveLength(2);
  expect(exported.routing).toEqual(config.routing);
  expect(exported.inbounds[0].streamSettings).toEqual(config.inbounds[0].streamSettings);
  await menuAction('View', 'Source JSON…');
  const pre = host.querySelector('.inspector .json-view')!;
  expect(pre.textContent).not.toContain('Family member');
  expect(host.textContent).toContain('Local draft');
  expect(localStorage.getItem('wayrill-user-sets')).toBeNull();
});
it('keeps an edited set in the library when closing a configuration', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => button('Save to library').click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close user sets"]')!.click(),
  );
  await menuAction('File', 'Close configuration');
  await menuAction('Edit', 'User sets…');
  expect(host.querySelector('dialog')?.textContent).toContain('public-vless users');
  expect(host.querySelector('dialog')?.textContent).not.toContain('From this configuration');
});
it('retains a draft and the previous library when Windows cannot save it', async () => {
  vi.mocked(credentialStore.save).mockRejectedValue({
    message: 'Windows could not save the library.',
  });
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add user"]')!.click());
  await act(async () => button('Save to library').click());
  expect(host.querySelector('dialog')?.textContent).toContain('Windows could not save');
  expect(
    host.querySelector('[aria-label="Users in set"]')?.querySelectorAll('button'),
  ).toHaveLength(2);
  expect(host.textContent).not.toContain('Local user draft · not deployed');
});
it('saves valid account JSON without a second commit and blocks invalid JSON', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => button('Edit account JSON').click());
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Account JSON"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '{');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Save to library').disabled).toBe(true);
  await act(async () => button('Restore last valid JSON').click());
  expect(button('Save to library').disabled).toBe(false);
});
it('protects draft user assignments from an accidental server refresh', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add user"]')!.click());
  await act(async () => button('Apply to graph').click());
  await act(async () => button('Refresh from server').click());
  expect(confirm).toHaveBeenCalled();
  expect(client.read).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});
it('limits the rendered user list to one page', async () => {
  const config = structuredClone(demoConfig);
  config.inbounds[0].settings.clients = Array.from({ length: 1000 }, (_, i) => ({
    id: `synthetic-${i}`,
  }));
  vi.mocked(client.read).mockResolvedValue({ ...snapshot, text: JSON.stringify(config) });
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  expect(
    host.querySelector('[aria-label="Users in set"]')?.querySelectorAll('button'),
  ).toHaveLength(100);
  expect(host.querySelector('dialog')?.textContent).toContain('1000 total');
  await act(async () => button('Next').click());
  expect(host.querySelector('[aria-label="Users in set"]')?.textContent).toContain('User 101');
});

it('uses the shared menus for examples, core settings and export without SSH', async () => {
  await menuAction('File', 'Load Example');
  await act(async () => button('Server configuration').click());
  expect(client.read).not.toHaveBeenCalled();
  expect(client.discover).not.toHaveBeenCalled();
  expect(host.querySelectorAll('.menu-trigger')).toHaveLength(7);
  await menuAction('Settings', 'Core settings…');
  expect(host.querySelector('dialog h2')?.textContent).toBe('Core settings');
  await act(async () => button('Cancel').click());
  await menuAction('File', 'Export Xray configuration…');
  expect(JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1])).toEqual(demoConfig);
});
it('hides API plumbing in navigation while preserving it in an unchanged export', async () => {
  await act(async () => button('Read server').click());
  expect(nodeButton('local-admin')).toBeUndefined();
  expect(nodeButton('api')).toBeUndefined();
  await act(async () => nodeButton('Routing filter').click());
  await act(async () => button('Edit…').click());
  expect(
    [...host.querySelectorAll('dialog select option')].some((option) =>
      option.textContent?.includes('api'),
    ),
  ).toBe(false);
  await act(async () => button('Cancel').click());
  await menuAction('File', 'Export Xray configuration…');
  expect(JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1])).toEqual(demoConfig);
});
it('keeps User set bindings correct when Core settings removes an API listener before the public inbound', async () => {
  const config = { ...demoConfig, inbounds: [demoConfig.inbounds[1], demoConfig.inbounds[0]] };
  vi.mocked(client.read).mockResolvedValue({ ...snapshot, text: JSON.stringify(config) });
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('public-vless users').click());
  await act(async () => button('Edit users').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add user"]')!.click());
  await act(async () => button('Apply to graph').click());
  await menuAction('Settings', 'Core settings…');
  await act(async () => button('Statistics & API').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Enable management API"]')!.click(),
  );
  await act(async () => button('Apply changes').click());
  await menuAction('File', 'Export Xray configuration…');
  const result = JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]);
  expect(result.inbounds).toHaveLength(1);
  expect(result.inbounds[0].tag).toBe('public-vless');
  expect(result.inbounds[0].settings.clients).toHaveLength(2);
  expect(result.api).toBeUndefined();
});
it('locates an existing outbound from Stash without duplicating or changing its definition', async () => {
  await act(async () => button('Read server').click());
  await act(async () => button('Stash').click());
  expect(host.querySelector('dialog tbody')?.textContent).toContain('direct');
  const row = [...host.querySelectorAll('dialog tbody tr')].find(
    (row) => row.firstElementChild?.textContent === 'direct',
  )!;
  await act(async () =>
    [...row.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.getAttribute('aria-label') === 'Locate on graph')!
      .click(),
  );
  expect(host.querySelector('[aria-label="Configuration stash"]')).toBeNull();
  expect(canvasActions.focus).toHaveBeenCalledWith('native-out-0');
  await menuAction('File', 'Export Xray configuration…');
  expect(JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1])).toEqual(demoConfig);
});
it('opens WinSCP in its own dialog and retains an edited graph when changing session storage', async () => {
  await act(async () => button('Read server').click());
  await act(async () => button('Stash').click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit direct"]')!.click(),
  );
  await inputValue('Outbound tag', 'renamed-direct');
  await act(async () => button('Apply changes').click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close stash"]')!.click(),
  );
  vi.mocked(client.setConfig).mockResolvedValue(inventory);
  await menuAction('Settings', 'WinSCP setup…');
  expect(host.querySelector('[aria-label="WinSCP setup"]')?.tagName).toBe('DIALOG');
  expect(host.querySelector('.connection-panel #session-storage')).toBeNull();
  const select = host.querySelector<HTMLSelectElement>('#session-storage')!;
  await act(async () => {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(client.setConfig).toHaveBeenCalledWith('auto');
  await act(async () => button('Close WinSCP setup').click());
  await menuAction('File', 'Export Xray configuration…');
  expect(JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]).outbounds[0].tag).toBe(
    'renamed-direct',
  );
});
it('opens editors through double click and node context menu actions', async () => {
  await act(async () => button('Read server').click());
  await act(async () =>
    button('Canvas Direct node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  );
  expect(host.querySelector('[aria-label="Node settings"]')).not.toBeNull();
  expect(host.querySelector('dialog')).toBeNull();
  await act(async () =>
    button('Canvas Direct node').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 }),
    ),
  );
  expect(document.querySelector('.node-context-menu')?.getAttribute('aria-label')).toBe(
    'Actions for direct',
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.node-context-menu button')!.click(),
  );
  expect(host.querySelector('[aria-label="Node settings"]')).not.toBeNull();
});
it('switches tools and keeps the selected node when hiding and showing properties', async () => {
  await act(async () => button('Read server').click());
  expect(host.querySelector('.inspector')?.textContent).toContain('Select a node to inspect.');
  expect(host.querySelector('.inspector [role="tablist"]')).toBeNull();
  await act(async () => nodeButton('public-vless').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pan tool"]')!.click());
  expect(host.querySelector('[aria-label="Pan tool"]')?.getAttribute('aria-pressed')).toBe('true');
  await menuAction('View', 'Hide properties');
  expect(host.querySelector('.inspector')).toBeNull();
  await menuAction('View', 'Show properties');
  expect(host.querySelector('.inspector')?.textContent).toContain('public-vless');
  await menuAction('View', 'Hide navigation');
  expect(host.querySelector('.connection-panel')?.hasAttribute('hidden')).toBe(true);
  await menuAction('View', 'Show navigation');
  expect(host.querySelector('.connection-panel')?.hasAttribute('hidden')).toBe(false);
});
it('runs graph checks and ignores global shortcuts while an editor is open', async () => {
  canvasActions.fit.mockClear();
  await act(async () => button('Read server').click());
  await act(async () => button('Check').click());
  expect(host.querySelector('dialog')?.textContent).toContain('No graph errors');
  await act(async () => button('Close').click());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })),
  );
  expect(canvasActions.fit).toHaveBeenCalledOnce();
  await act(async () => nodeButton('public-vless').click());
  await act(async () => button('Edit…').click());
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })),
  );
  expect(exportJson).not.toHaveBeenCalled();
});
it('reads a local draft deployment target before allowing remote validation', async () => {
  expect(button('Apply…').disabled).toBe(true);
  await menuAction('File', 'Load Example');
  await act(async () => button('Server configuration').click());
  expect(button('Apply…').disabled).toBe(false);
  await act(async () => button('Apply…').click());
  expect(client.read).toHaveBeenCalledWith('FlauntVPN', '/usr/local/etc/xray/config.json');
  await act(async () => button('Close configuration deployment').click());
  expect(button('Apply…').disabled).toBe(false);
  await act(async () => button('Check').click());
  await act(async () => button('Validate on server…').click());
  expect(host.querySelector('[aria-label="Validate and apply configuration"]')).not.toBeNull();
  expect(client.validateConfig).not.toHaveBeenCalled();
});
it('updates the server snapshot and draft baseline only after confirmed successful apply', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('direct').click());
  await inputValue('Outbound tag', 'renamed-direct');
  await act(async () => button('Apply changes').click());
  vi.mocked(client.validateConfig).mockImplementation(async (_session, request) => ({
    version: 1,
    id: 'b'.repeat(32),
    valid: true,
    path: request.path,
    service: request.service,
    sourceSha256: request.expectedSha256,
    configSha256: 'c'.repeat(64),
    coreVersion: '26.10.31',
    checkedAt: Date.now() / 1000,
    expiresAt: Date.now() / 1000 + 900,
    logs: [],
    message: 'Validated',
  }));
  vi.mocked(client.startAction).mockImplementation(async (_session, request) => ({
    version: 1,
    id: request.id,
    action: 'applyConfig',
    state: 'succeeded',
    stage: 'Configuration applied',
    percent: 100,
    message: '',
    logs: [],
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    bootId: 'boot',
    configResult: {
      path: snapshot.path,
      service: 'xray.service',
      planId: 'b'.repeat(32),
      backupPath: '/private/config.backup',
      originalSha256: 'a'.repeat(64),
      installedSha256: 'c'.repeat(64),
      rollback: 'not-needed',
    },
  }));
  await act(async () => button('Apply…').click());
  await act(async () => button('Validate on server').click());
  const modalApply = () =>
    [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (item) => item.textContent?.trim() === 'Apply…',
    )!;
  await act(async () => modalApply().click());
  await act(async () => button('Apply & restart').click());
  expect(host.querySelector('.snapshot-hash')?.getAttribute('title')).toBe('c'.repeat(64));
  expect(host.querySelector('.users-draft-label')).toBeNull();
  expect(host.textContent).toContain('The draft matches the loaded configuration.');
  const sent = vi.mocked(client.validateConfig).mock.calls[0][1];
  expect(JSON.parse(sent.configText).outbounds[0].tag).toBe('renamed-direct');
});
it('opens properties for an imported outbound selected on the graph', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('direct').click());
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Properties');
});

it('reloads a saved graph layout on the next connection and exposes layout-only saving', async () => {
  const view = remoteView(snapshot.text);
  const users = createUserWorkspace(view.original, emptyLibrary());
  const layout = {
    ...emptyLayout(),
    positions: { 'native-in-0': { x: 100, y: 200 } },
    viewport: { x: 10, y: 20, zoom: 0.6 },
  };
  let stored = saveRemoteDocument(view, users, layout);
  vi.mocked(client.read).mockImplementation(async () => ({
    ...snapshot,
    companion: { path: '/etc/xray/config.wayrill.json', text: stored, sha256: 'd'.repeat(64) },
  }));
  await act(async () => button('Read server').click());
  const currentLayout = () =>
    JSON.parse(host.querySelector('[data-testid="canvas"]')!.getAttribute('data-layout')!);
  expect(currentLayout()).toEqual(layout);
  await act(async () => button('Move fixture node').click());
  await act(async () => button('Apply\u2026').click());
  expect(host.textContent).toContain('Xray will keep running.');
  await act(async () => button('Validate on server').click());
  const sent = vi.mocked(client.validateConfig).mock.calls[0][1];
  expect(sent.configText).toBe(snapshot.text);
  expect(sent.expectedWayrillSha256).toBe('d'.repeat(64));
  expect(JSON.parse(sent.wayrillText!).layout.positions['native-in-0']).toEqual({ x: 420, y: 180 });
  stored = sent.wayrillText!;
  await act(async () => button('Close').click());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => button('Refresh from server').click());
  expect(currentLayout().positions['native-in-0']).toEqual({ x: 420, y: 180 });
  expect(currentLayout().viewport).toEqual(layout.viewport);
});

it('ignores an out-of-date companion and reports why the native graph was loaded', async () => {
  const view = remoteView(JSON.stringify({ ...demoConfig, log: { loglevel: 'debug' } }));
  const stored = saveRemoteDocument(
    view,
    createUserWorkspace(view.original, emptyLibrary()),
    emptyLayout(),
  );
  vi.mocked(client.read).mockResolvedValue({
    ...snapshot,
    companion: { path: '/etc/xray/config.wayrill.json', text: stored, sha256: 'd'.repeat(64) },
  });
  await act(async () => button('Read server').click());
  expect(host.textContent).toContain(
    'The saved graph does not compile to the current Xray configuration.',
  );
});

it('builds a configuration from an empty fresh-server config through the node library', async () => {
  vi.mocked(client.read).mockResolvedValue({ ...snapshot, text: '{}' });
  await act(async () => button('Read server').click());
  expect(host.querySelector('.node-list')).toBeNull();
  expect(host.querySelector('[aria-label="Node library"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add Direct (Outbounds)"]')!.click(),
  );
  expect(host.querySelector('[aria-label="Node settings"]')).not.toBeNull();
  expect(host.querySelector('dialog')).toBeNull();
  await inputValue('Outbound tag', 'internet');
  await act(async () => button('Apply changes').click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add Proxy inbound (Inbounds)"]')!.click(),
  );
  expect(host.querySelector('dialog h2')?.textContent).toContain('mixed');
  await act(async () => button('Apply changes').click());
  await menuAction('File', 'Export Xray configuration…');
  const exported = JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]);
  expect(exported.outbounds).toEqual([{ tag: 'internet', protocol: 'freedom', settings: {} }]);
  expect(exported.inbounds[0]).toMatchObject({ protocol: 'mixed', port: 10808 });
  expect(client.startAction).not.toHaveBeenCalled();
});

it('guards inline drafts, and discards them only after confirmation', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('direct').click());
  await inputValue('Outbound tag', 'unsaved-name');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => nodeButton('public-vless').click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Outbound tag"]')!.value).toBe(
    'unsaved-name',
  );
  confirm.mockReturnValue(true);
  await menuAction('View', 'Hide properties');
  await menuAction('View', 'Show properties');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Outbound tag"]')!.value).toBe('direct');
  expect(confirm).toHaveBeenCalledTimes(2);
});

it('starts a new draft without replacing its bound server snapshot', async () => {
  await act(async () => button('Read server').click());
  await menuAction('File', 'New configuration');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add Direct (Outbounds)"]')!.click(),
  );
  await act(async () => button('Apply…').click());
  expect(client.read).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="Validate and apply configuration"]')).not.toBeNull();
  expect(host.querySelector('.snapshot-hash')?.getAttribute('title')).toBe(snapshot.sha256);
  expect(client.startAction).not.toHaveBeenCalled();
});

it('adds a hidden stashed outbound to the graph and remembers its placement', async () => {
  vi.mocked(client.read).mockResolvedValue({
    ...snapshot,
    text: JSON.stringify({
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'spare', protocol: 'blackhole' },
      ],
    }),
  });
  await act(async () => button('Read server').click());
  expect(nodeButton('spare')).toBeUndefined();
  await act(async () => button('Stash').click());
  const row = [...host.querySelectorAll('tbody tr')].find((row) =>
    row.textContent?.includes('spare'),
  )!;
  expect(row.textContent).toContain('Not on graph');
  await act(async () =>
    [...row.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Add to graph')!
      .click(),
  );
  expect(nodeButton('spare')).toBeDefined();
  expect(canvasActions.focus).toHaveBeenCalledWith('native-out-1');
  expect(host.querySelector('[aria-label="Configuration stash"]')).toBeNull();
  await act(async () => button('Stash').click());
  expect(host.querySelector('tbody [aria-label="Locate on graph"]')).not.toBeNull();
});

it.each(['mixed', 'socks', 'http'])('configures Proxy mode %s without raw JSON', async (mode) => {
  await menuAction('File', 'New configuration');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add Proxy inbound (Inbounds)"]')!.click(),
  );
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Proxy mode"]')!;
  await act(async () => {
    select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Apply changes').click());
  await menuAction('File', 'Export Xray configuration…');
  expect(JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]).inbounds[0].protocol).toBe(mode);
});

it('keeps password authentication when changing an HTTP listener to SOCKS', async () => {
  vi.mocked(client.read).mockResolvedValue({
    ...snapshot,
    text: JSON.stringify({
      inbounds: [
        {
          tag: 'proxy',
          listen: '127.0.0.1',
          port: 10808,
          protocol: 'http',
          settings: { accounts: [{ user: 'sample-user', pass: 'fictional-password' }] },
        },
      ],
      outbounds: [{ protocol: 'freedom' }],
    }),
  });
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('proxy').click());
  await act(async () => button('Edit…').click());
  const mode = host.querySelector<HTMLSelectElement>('[aria-label="Proxy mode"]')!;
  await act(async () => {
    mode.value = 'socks';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Apply changes').click());
  await menuAction('File', 'Export Xray configuration…');
  const inbound = JSON.parse(vi.mocked(exportJson).mock.calls.at(-1)![1]).inbounds[0];
  expect(inbound.protocol).toBe('socks');
  expect(inbound.settings).toMatchObject({
    auth: 'password',
    accounts: [{ user: 'sample-user', pass: 'fictional-password' }],
  });
});

it('protects inline edits when switching to the JSON tab', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('direct').click());
  await inputValue('Outbound tag', 'pending-name');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === 'JSON',
  )!;
  await act(async () => tab.click());
  expect(host.querySelector('[aria-label="Node settings"]')).not.toBeNull();
  expect(confirm).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLInputElement>('[aria-label="Outbound tag"]')!.value).toBe(
    'pending-name',
  );
});

it('does not dirty the graph when opening an existing singleton from the library', async () => {
  const view = remoteView(snapshot.text);
  const users = createUserWorkspace(view.original, emptyLibrary());
  vi.mocked(client.read).mockResolvedValue({
    ...snapshot,
    companion: {
      path: '/etc/xray/config.wayrill.json',
      text: saveRemoteDocument(view, users, emptyLayout()),
      sha256: 'd'.repeat(64),
    },
  });
  await act(async () => button('Read server').click());
  expect(host.querySelector('.users-draft-label')).toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Add DNS handler (Rules & filters)"]')!
      .click(),
  );
  await act(async () => button('Cancel').click());
  expect(host.querySelector('.users-draft-label')).toBeNull();
});

it('offers only outbounds as the next hop in inline outbound settings', async () => {
  await act(async () => button('Read server').click());
  await act(async () => nodeButton('direct').click());
  const selector = host.querySelector<HTMLSelectElement>('[aria-label="Next outbound"]')!;
  const tags = Array.from(selector.options, (option) => option.value);
  expect(tags).toContain('relay-eu');
  expect(tags).not.toContain('public-vless');
  expect(tags).not.toContain('local-admin');
});

it('refreshes server status after session inventory switches to a different server', async () => {
  await menuAction('Server', 'Server status…');
  expect(host.querySelector('[aria-labelledby="server-status-title"]')?.textContent).toContain(
    'demo-linux',
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close server status"]')!.click(),
  );
  vi.mocked(client.sessions).mockResolvedValue({
    ...inventory,
    sessions: [
      { id: 'Other', name: 'Other server', host: 'other.example.test', user: 'root', port: 22 },
    ],
  });
  await menuAction('Server', 'Refresh saved sessions');
  vi.mocked(client.serverStatus).mockResolvedValue({ ...serverStatus, hostname: 'other-linux' });
  await menuAction('Server', 'Server status…');
  expect(client.serverStatus).toHaveBeenLastCalledWith('Other');
  expect(host.querySelector('[aria-labelledby="server-status-title"]')?.textContent).toContain(
    'other-linux',
  );
  expect(host.querySelector('[aria-labelledby="server-status-title"]')?.textContent).not.toContain(
    'demo-linux',
  );
});
