// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exportFile } from '../exportFile';
import type { DiagnosticSource } from '../diagnostics';
import DiagnosticsDialog from './DiagnosticsDialog';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../exportFile', () => ({ exportFile: vi.fn().mockResolvedValue(true) }));
let root: Root, host: HTMLDivElement;
const entry = (message: string, component = 'TUN', level = 'error') =>
  JSON.stringify({ timeMs: 1000, pid: 100, component, level, message });
const source = (name: DiagnosticSource['source'], text: string): DiagnosticSource => ({
  source: name,
  folder: name === 'desktop' ? 'C:/user/Logs' : 'C:/service/Logs',
  error: null,
  text,
});
const recent = () => [
  source(
    'service',
    [entry('recent event 192.168.1.2'), entry('observer message', 'attribution', 'warning')].join(
      '\n',
    ),
  ),
  source('sharing', entry('sharing message', 'TUN', 'info')),
  source('desktop', entry('desktop message', 'renderer', 'error')),
];
const output = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
const group = (name: string) =>
  [...host.querySelectorAll('fieldset')].find(
    (field) => field.querySelector('legend')?.textContent === `Visible ${name}`,
  )!;
const check = (groupName: string, label: string) =>
  [...group(groupName).querySelectorAll('label')]
    .find((row) => row.textContent?.trim() === label)!
    .querySelector('input')!;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (row) => row.textContent?.includes(name) || row.getAttribute('aria-label') === name,
  )!;
const render = async () =>
  act(async () => root.render(<DiagnosticsDialog maskAddress="full" onClose={() => {}} />));
const click = async (element: HTMLElement) => act(async () => element.click());
const tick = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  vi.clearAllMocks();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(invoke).mockImplementation(async (_method, args) => ({
    sources: (args as { retained?: boolean })?.retained
      ? [
          source(
            'service',
            [
              entry('older retained event example.com:443'),
              entry('older warning', 'attribution', 'warning'),
            ].join('\n'),
          ),
          source('desktop', entry('retained desktop', 'renderer')),
        ]
      : recent(),
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
it('filters individual components and exact levels with independent All checkboxes', async () => {
  await render();
  expect(invoke).toHaveBeenCalledWith('diagnostics_read', { retained: false });
  expect(output().value).toContain('192.168.1.2');
  await click(check('sources', 'Networking service / attribution'));
  expect(output().value).not.toContain('observer message');
  expect(check('sources', 'All').indeterminate).toBe(true);
  await click(check('levels', 'Error'));
  expect(output().value).not.toContain('recent event');
  expect(output().value).not.toContain('desktop message');
  expect(output().value).toContain('sharing message');
  await click(check('sources', 'All'));
  expect(check('sources', 'All').indeterminate).toBe(false);
  expect(output().value).toContain('observer message');
  await click(check('sources', 'All'));
  expect(output().value).toBe('');
  await click(button('Reset log filters'));
  expect(output().value).toContain('desktop message');
  expect(output().value).toContain('observer message');
  expect(button('Reset log filters').disabled).toBe(true);
});
it('keeps collecting while paused, holds the visible text, and immediately catches up on resume', async () => {
  await render();
  await click(button('Pause display'));
  const held = output().value;
  vi.mocked(invoke).mockResolvedValue({
    sources: [source('service', entry('new live event', 'attribution'))],
  });
  await tick();
  await tick();
  expect(
    vi.mocked(invoke).mock.calls.filter(([method]) => method === 'diagnostics_read'),
  ).toHaveLength(3);
  expect(output().value).toBe(held);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Display paused at');
  await click(button('Resume display'));
  expect(output().value).toContain('new live event');
  expect(output().value).not.toContain('recent event');
});
it('retries failed live reads without erasing entries or an export error', async () => {
  await render();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('temporary file read failure'));
  await tick();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'temporary file read failure',
  );
  expect(output().value).toContain('recent event');
  await tick();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  vi.mocked(exportFile).mockRejectedValueOnce(new Error('export failed'));
  await click(button('Save diagnostics'));
  await tick();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('export failed');
});
it('opens the desktop folder when only a desktop component is selected', async () => {
  await render();
  await click(check('sources', 'All'));
  await click(check('sources', 'Desktop app / renderer'));
  await click(button('Open folder'));
  expect(invoke).toHaveBeenCalledWith('diagnostics_open', { source: 'desktop' });
});
