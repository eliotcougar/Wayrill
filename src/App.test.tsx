// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import type useGraphEditor from './useGraphEditor';
import { readImportText } from './importText';
import { importXrayConfig } from './graph/xrayImport';
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
it('preserves edits made while an earlier graph file is being read', async () => {
  const read = delayedRead(),
    incoming = graphText('Incoming graph');
  await chooseGraph('incoming.json');
  await act(() => editor.change((graph) => ({ ...graph, name: 'A more recent edit' })));
  await act(async () => read.resolve(incoming));
  expect(editor.graph.name).toBe('A more recent edit');
  expect(host.textContent).toContain('The graph changed while the file was opening');
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
