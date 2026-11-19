// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApplicationSelectors from '../components/ApplicationSelectors';
import { PoolApplicationPicker } from './PoolApplications';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

const calculator = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe';
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.dataset.app = 'pool';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'pool_windows_catalog')
      return {
        processes: [{ pid: 100, name: 'editor.exe', path: 'C:\\Apps\\editor.exe' }],
        packages: [{ family: calculator, name: 'Calculator', publisher: 'Microsoft' }],
        services: [{ name: 'Dnscache', displayName: 'DNS Client', pid: 200 }],
        interfaces: [],
      };
    if (command === 'process_picker') return 'offline.exe';
    if (command === 'pool_describe_executable')
      return { name: 'editor.exe', product: 'Example Editor' };
    throw new Error('Unexpected command ' + command);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.app;
});

function button(label: string) {
  return [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  )!;
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('lets Pool users choose a running process, package, or service and browse for an executable', async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<ApplicationSelectors rows={[]} onChange={onChange} />));
  expect(invoke).toHaveBeenCalledWith('pool_windows_catalog');
  const kind = host.querySelector<HTMLSelectElement>('[aria-label="Application type"]')!;
  for (const [type, value] of [
    ['process', 'editor.exe'],
    ['package', calculator],
    ['service', 'Dnscache'],
  ]) {
    await choose(kind, type);
    await act(async () =>
      host.querySelector<HTMLInputElement>('.application-choice input')!.click(),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: type, value, mode: 'name', children: false, enabled: true },
    ]);
  }
  await choose(kind, 'process');
  await act(async () => button('Browse…').click());
  expect(invoke).toHaveBeenLastCalledWith('process_picker', { mode: 'name' });
  expect(host.querySelector<HTMLInputElement>('[aria-label="Application selector"]')?.value).toBe(
    'offline.exe',
  );
});

it('saves a subscriber choice or identities selected and entered on the publisher PC', async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(<PoolApplicationPicker rows={[]} known={[]} onChange={onChange} />),
  );
  await act(async () => button('New application…').click());
  const match = host.querySelector<HTMLSelectElement>('fieldset select')!;
  expect(match.value).toBe('automatic');
  await choose(
    host.querySelector('[aria-label="Choose a running executable"]')!,
    'C:\\Apps\\editor.exe',
  );
  await act(async () => button('Add application').click());
  expect(onChange).toHaveBeenLastCalledWith([
    expect.objectContaining({
      identity: expect.objectContaining({
        executable: { name: 'editor.exe', product: 'Example Editor' },
      }),
    }),
  ]);
  expect(JSON.stringify(onChange.mock.lastCall)).not.toContain('C:');

  await act(async () => button('New application…').click());
  await choose(host.querySelector('fieldset select')!, 'subscriber');
  await type(host.querySelector('fieldset input')!, 'Subscriber browser');
  await act(async () =>
    host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click(),
  );
  await act(async () => button('Add application').click());
  expect(onChange).toHaveBeenLastCalledWith([
    expect.objectContaining({
      identity: expect.objectContaining({
        name: 'Subscriber browser',
        identities: [],
        requireLocal: true,
      }),
    }),
  ]);

  await act(async () => button('New application…').click());
  await choose(host.querySelector('fieldset select')!, 'identity');
  await choose(host.querySelector('[aria-label="Add a package from this PC"]')!, calculator);
  await type(host.querySelector('[placeholder="Dnscache"]')!, 'ExampleRemoteService');
  await act(async () => button('Add application').click());
  expect(onChange).toHaveBeenLastCalledWith([
    expect.objectContaining({
      kind: 'pool',
      identity: expect.objectContaining({
        name: 'Calculator',
        identities: [
          { kind: 'package', value: calculator },
          { kind: 'service', value: 'ExampleRemoteService' },
        ],
      }),
    }),
  ]);
});
