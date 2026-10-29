// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import XrayImportDialog from './XrayImportDialog';
import { compileRuntimeGraph } from '../graph/runtime';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const textarea = () => host.querySelector<HTMLTextAreaElement>('#xray-import-json')!;
async function edit(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea(),
      value,
    );
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function setup(applied: Record<string, unknown> | null = null) {
  const onImport = vi.fn(),
    onClose = vi.fn();
  await act(() =>
    root.render(<XrayImportDialog applied={applied} onImport={onImport} onClose={onClose} />),
  );
  return { onImport, onClose };
}

it('offers an explicit in-place fix, retains comments, imports the corrected graph and waits for Import graph', async () => {
  const { onImport, onClose } = await setup();
  const text = '{ /* keep this */ "Outbounds": [{"Tag":"DIRECT","Protocol":"freedom"}]}';
  await edit(text);
  await act(() => button('Review conversion').click());
  expect(host.textContent).toContain('Field names need capitalization fixes');
  expect(textarea().value).toBe(text);
  expect(document.activeElement).toBe(button('Fix capitalization in JSON'));
  expect(button('Import graph').disabled).toBe(true);
  await act(() => button('Fix capitalization in JSON').click());
  expect(textarea().value).toContain('/* keep this */');
  expect(textarea().value).toContain('"outbounds"');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Fixed 3 field names');
  expect(button('Import graph').disabled).toBe(false);
  expect(document.activeElement?.textContent).toBe('Round trip preserves the corrected JSON');
  expect(onImport).not.toHaveBeenCalled();
  await act(() => button('Import graph').click());
  expect(onImport).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(compileRuntimeGraph(onImport.mock.calls[0][0]).config).toEqual({
    outbounds: [{ tag: 'DIRECT', protocol: 'freedom' }],
  });
});

it('refuses duplicate aliases, even with the same values, without offering a destructive merge', async () => {
  const { onImport } = await setup();
  const text = '{"Outbounds":[],"outbounds":[]}';
  await edit(text);
  await act(() => button('Review conversion').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Resolve the duplicate names',
  );
  expect(textarea().value).toBe(text);
  expect(button('Fix capitalization in JSON')).toBeUndefined();
  expect(button('Import graph').disabled).toBe(true);
  expect(onImport).not.toHaveBeenCalled();
});

async function readFile(text: Promise<string> | ArrayBuffer, name = 'file.json') {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [
      {
        size: 10,
        name,
        arrayBuffer: () =>
          text instanceof ArrayBuffer
            ? Promise.resolve(text)
            : text.then((value) => new TextEncoder().encode(value).buffer),
      },
    ],
  });
  await act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}
it('retains later pasted JSON and its review when an older file finishes reading', async () => {
  await setup();
  let resolve!: (value: string) => void;
  await readFile(
    new Promise<string>((done) => {
      resolve = done;
    }),
  );
  await edit('{"outbounds":[]}');
  await act(() => button('Review conversion').click());
  await act(() => resolve('{"Outbounds":[]}'));
  expect(textarea().value).toBe('{"outbounds":[]}');
  expect(button('Import graph').disabled).toBe(false);
});

it('renders a large pool conversion with DNS without unmounting the app', async () => {
  const { onImport } = await setup();
  await edit(
    JSON.stringify({
      outbounds: Array.from({ length: 501 }, (_, i) => ({
        tag: `candidate-${i}`,
        protocol: 'freedom',
        settings: {},
      })),
      routing: {
        rules: [
          {
            type: 'field',
            domain: ['full:private.example'],
            outboundTag: 'candidate-500',
          },
        ],
      },
      dns: { servers: ['https://dns.example/dns-query'] },
    }),
  );
  await act(() => button('Review conversion').click());
  expect(host.textContent).toContain('Unedited round trip preserves every JSON value');
  expect(button('Import graph').disabled).toBe(false);
  await act(() => button('Import graph').click());
  expect(onImport).toHaveBeenCalledOnce();
});

it('retains a reviewed import when the graph rejects a busy commit and allows retry', async () => {
  const { onImport, onClose } = await setup();
  const text = '{"outbounds":[{"tag":"direct","protocol":"freedom"}]}';
  await edit(text);
  await act(() => button('Review conversion').click());
  onImport.mockImplementationOnce(() => {
    throw new Error('The graph is temporarily busy.');
  });
  await act(() => button('Import graph').click());
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'The graph is temporarily busy.',
  );
  expect(textarea().value).toBe(text);
  expect(button('Import graph').disabled).toBe(false);
  await act(() => button('Import graph').click());
  expect(onImport).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledOnce();
});
