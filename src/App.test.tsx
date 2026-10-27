// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import type useGraphEditor from './useGraphEditor';
import { exportFile } from './exportFile';
import { readImportText } from './importText';
import { importXrayConfig } from './graph/xrayImport';
import { makeNode } from './graph/catalog';
import type { SharingInspection } from './graph/internetSharing';

// Editor race cases need their own complex graph, not the bundled first-run starter.
vi.mock('./graph/examples', async (original) => {
  const module = await original<typeof import('./graph/examples')>();
  const { createTrafficExample } = await import('./graph/example');
  const { enableDefaults } = await import('./graph/defaults');
  return { ...module, createProxyStarter: () => enableDefaults(createTrafficExample()) };
});

const sharing = vi.hoisted(() => ({
  value: undefined as SharingInspection | undefined,
  error: undefined as string | undefined,
  busy: false,
  refresh: vi.fn(),
}));
vi.mock('./useInternetSharing', () => ({ default: () => sharing }));

let editor: ReturnType<typeof useGraphEditor>;
vi.mock('./useGraphEditor', async (original) => {
  const module = await original<typeof import('./useGraphEditor')>();
  return {
    default: (...args: Parameters<typeof useGraphEditor>) => {
      editor = module.default(...args);
      return editor;
    },
  };
});
vi.mock('./exportFile', () => ({ exportFile: vi.fn() }));
vi.mock('./importText', () => ({ readImportText: vi.fn() }));

const lifecycle = vi.hoisted(() => ({ active: false }));
vi.mock('./runtimeProgress', async (original) => {
  const module = await original<typeof import('./runtimeProgress')>();
  return {
    ...module,
    runtimeProgress: (...args: Parameters<typeof module.runtimeProgress>) =>
      lifecycle.active
        ? { title: 'Starting networking', stage: 'Waiting for Xray', percent: null }
        : module.runtimeProgress(...args),
  };
});

let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  lifecycle.active = false;
  sharing.value = undefined;
  sharing.error = undefined;
  sharing.busy = false;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m22 = 1;
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>,
    ),
  );
  await act(async () => {
    editor.selectNode(editor.graph.nodes.find((node) => node.data.kind === 'routing-filter')!.id);
    editor.change((graph) => ({ ...graph, name: 'Changed graph' }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text,
  )!;
it('does not offer ICS setup merely because inspection failed', async () => {
  sharing.error = 'The service is busy. Wait for the current operation to finish.';
  await act(async () =>
    root.render(
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>,
    ),
  );
  expect(host.querySelector('.ics-notice')).toBeNull();
  sharing.error = 'Cannot inspect Windows sharing.';
  await act(async () =>
    root.render(
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>,
    ),
  );
  expect(host.querySelector('.ics-notice')).toBeNull();
});
it('offers setup for a confirmed sharing pair and hides it once an ICS node exists', async () => {
  sharing.value = {
    version: 'detected',
    supported: true,
    managed: false,
    recoveryPending: false,
    lastError: null,
    connections: [],
    pair: { public: { id: 'public', name: 'Ethernet' }, private: { id: 'private', name: 'LAN' } },
  };
  await act(async () =>
    root.render(
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>,
    ),
  );
  expect(host.querySelector('.ics-notice')?.textContent).toContain('Ethernet → LAN');
  expect(button('Add ICS TUN')).toBeDefined();
  await act(async () =>
    editor.change((graph) => ({
      ...graph,
      nodes: [...graph.nodes, makeNode('ics-tun', { x: 0, y: 0 })],
    })),
  );
  expect(host.querySelector('.ics-notice')).toBeNull();
});
async function key(target: HTMLElement, value: string, ctrlKey = false) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
it.each([
  ['Undo', 'z', true],
  ['Duplicate', 'd', true],
  ['Delete', 'Delete', false],
  ['Export', 's', true],
  ['Open', 'o', true],
] as const)(
  'keeps graph %s shortcuts out of the application logs dialog',
  async (_, value, ctrlKey) => {
    await act(async () => button('Help').click());
    await act(async () => button('Application logs…').click());
    const dialog = host.querySelector<HTMLDialogElement>('dialog.diagnostics-window')!;
    expect(dialog.open).toBe(true);
    const before = editor.serialize();
    const open = vi.spyOn(
      host.querySelector<HTMLInputElement>('[aria-label="Open graph file"]')!,
      'click',
    );
    await key(dialog.querySelector<HTMLButtonElement>('button')!, value, ctrlKey);
    expect(editor.serialize()).toBe(before);
    expect(exportFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(true);
    await act(async () => button('Close Application logs').click());
    await key(host.querySelector('[aria-label="Routing graph canvas"]')!, 'z', true);
    expect(editor.graph.name).not.toBe('Changed graph');
  },
);
it('honors a shortcut already handled by a focused control', async () => {
  const target = button('Select tool');
  target.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  const before = editor.serialize();
  await key(target, 'd', true);
  expect(editor.serialize()).toBe(before);
});

function delayedRead() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  vi.mocked(readImportText).mockReturnValueOnce(promise);
  return { resolve, reject };
}
async function chooseGraph(name: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Open graph file"]')!;
  await act(() => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['graph'], name)],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function graphText(name: string) {
  return JSON.stringify({ ...JSON.parse(editor.serialize()), name });
}
it('keeps the newest graph when file reads complete out of order', async () => {
  const first = delayedRead(),
    second = delayedRead();
  const older = graphText('Older file'),
    newer = graphText('Newest file');
  await chooseGraph('older.json');
  await chooseGraph('newer.json');
  await act(async () => second.resolve(newer));
  expect(editor.graph.name).toBe('Newest file');
  await act(async () => first.resolve(older));
  expect(editor.graph.name).toBe('Newest file');
});
it('keeps a new graph and suppresses obsolete read errors', async () => {
  const read = delayedRead();
  await chooseGraph('older.json');
  await act(() => button('File').click());
  await act(() => button('New graph').click());
  expect(editor.graph.name).toBe('Untitled graph');
  await act(async () => read.reject(new Error('Obsolete read failed')));
  expect(editor.graph.name).toBe('Untitled graph');
  expect(host.textContent).not.toContain('Obsolete read failed');
});
it('preserves edits made while an earlier graph file is being read', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  await chooseGraph('incoming.json');
  await act(() => editor.change((graph) => ({ ...graph, name: 'A more recent edit' })));
  await act(async () => read.resolve(incoming));
  expect(editor.graph.name).toBe('A more recent edit');
  expect(host.textContent).toContain('The graph changed while the file was opening');
});
it('still opens a graph after harmless selection and viewport changes', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  await chooseGraph('incoming.json');
  await act(() => {
    editor.selectNode(editor.graph.nodes.at(-1)!.id);
    editor.setViewport({ x: 10, y: 20, zoom: 0.8 });
  });
  await act(async () => read.resolve(incoming));
  expect(editor.graph.name).toBe('Incoming graph');
});

it.each([false, true])(
  'does not restore old outbound credentials when an open protocol editor is saved (same turn: %s)',
  async (sameTurn) => {
    const graph = importXrayConfig(
      JSON.stringify({
        outbounds: [
          {
            tag: 'server',
            protocol: 'trojan',
            settings: {
              servers: [{ address: 'public.example', port: 443, password: 'old-password' }],
            },
            streamSettings: {
              network: 'raw',
              security: 'tls',
              tlsSettings: { serverName: 'public.example' },
            },
          },
        ],
      }),
    );
    await act(() => editor.loadGraph(graph));
    const node = editor.graph.nodes.find((node) => node.data.kind === 'trojan-outbound')!;
    await act(() => editor.selectNode(node.id));
    await act(() => button('Edit protocol settings…').click());
    const dialog = host.querySelector<HTMLDialogElement>('.protocol-editor-window')!;
    expect(dialog.open).toBe(true);
    const refresh = () =>
      editor.updateNode(node.id, {
        settings: {
          ...node.data.settings,
          json: String(node.data.settings.json).replace('old-password', 'provider-password'),
        },
      });
    if (sameTurn)
      await act(() => {
        refresh();
        button('Apply protocol settings').click();
      });
    else {
      await act(refresh);
      await act(() => button('Apply protocol settings').click());
    }
    expect(
      String(editor.graph.nodes.find((next) => next.id === node.id)!.data.settings.json),
    ).toContain('provider-password');
  },
);

it('keeps a conflicting protocol draft open with a visible error', async () => {
  const graph = importXrayConfig(
    JSON.stringify({
      outbounds: [
        {
          tag: 'server',
          protocol: 'trojan',
          settings: {
            servers: [{ address: 'public.example', port: 443, password: 'old-password' }],
          },
          streamSettings: {
            network: 'raw',
            security: 'tls',
            tlsSettings: { serverName: 'public.example' },
          },
        },
      ],
    }),
  );
  await act(() => editor.loadGraph(graph));
  const node = editor.graph.nodes.find((node) => node.data.kind === 'trojan-outbound')!;
  await act(() => editor.selectNode(node.id));
  await act(() => button('Edit protocol settings…').click());
  await act(() => button('Native JSON').click());
  const input = host.querySelector<HTMLTextAreaElement>(
    '.protocol-editor-window textarea[data-diagnostic-field="json"]',
  )!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      input.value.replace('old-password', 'my-password'),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() =>
    editor.updateNode(node.id, {
      settings: {
        ...node.data.settings,
        json: String(node.data.settings.json).replace('old-password', 'provider-password'),
      },
    }),
  );
  await act(() => button('Apply protocol settings').click());
  expect(host.querySelector<HTMLDialogElement>('.protocol-editor-window')?.open).toBe(true);
  expect(host.querySelector('.protocol-editor-window [role="alert"]')?.textContent).toContain(
    'changed while this editor was open',
  );
  expect(input.value).toContain('my-password');
  expect(
    String(editor.graph.nodes.find((next) => next.id === node.id)!.data.settings.json),
  ).toContain('provider-password');
});

it('preserves an edit published immediately before the file read completes', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  await chooseGraph('incoming.json');
  await act(async () => {
    editor.change((graph) => ({ ...graph, name: 'Same turn edit' }));
    read.resolve(incoming);
  });
  expect(editor.graph.name).toBe('Same turn edit');
});

it('lets a New graph command supersede a file completing in the same turn', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  await chooseGraph('incoming.json');
  await act(() => button('File').click());
  await act(async () => {
    button('New graph').click();
    read.resolve(incoming);
  });
  expect(editor.graph.name).toBe('Untitled graph');
});

async function setLifecycle(active: boolean) {
  lifecycle.active = active;
  await act(() =>
    root.render(
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>,
    ),
  );
}
it('retains a routing-rule draft when lifecycle work blocks its save, then accepts retry', async () => {
  await act(() => button('Edit routing rules…').click());
  const dialog = host.querySelector<HTMLDialogElement>('[aria-labelledby="rule-editor-title"]')!;
  const input = [...dialog.querySelectorAll('label')]
    .find((label) => label.querySelector('span')?.textContent === 'Rule name')!
    .querySelector('input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'My pending rule',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const before = editor.serialize();
  await setLifecycle(true);
  await act(() => button('Apply changes').click());
  expect(dialog.isConnected).toBe(true);
  expect(input.value).toBe('My pending rule');
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
    'graph is temporarily busy',
  );
  expect(editor.serialize()).toBe(before);
  await setLifecycle(false);
  await act(() => button('Apply changes').click());
  expect(dialog.isConnected).toBe(false);
  expect(editor.serialize()).toContain('My pending rule');
});
it('does not claim a pending graph open succeeded during lifecycle work and allows retry', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  const original = editor.serialize(),
    version = editor.loadVersion;
  await chooseGraph('incoming.json');
  await setLifecycle(true);
  await act(async () => read.resolve(incoming));
  expect(editor.serialize()).toBe(original);
  expect(editor.loadVersion).toBe(version);
  expect(host.textContent).toContain(
    'Wait for the current operation to finish, then open the graph again.',
  );
  expect(host.textContent).not.toContain('Opened Incoming graph.');
  await setLifecycle(false);
  const retry = delayedRead();
  await chooseGraph('incoming.json');
  await act(async () => retry.resolve(incoming));
  expect(editor.graph.name).toBe('Incoming graph');
  expect(editor.loadVersion).toBe(version + 1);
});
