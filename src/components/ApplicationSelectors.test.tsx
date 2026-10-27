// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ApplicationSelectors from './ApplicationSelectors';
vi.mock('./useWindowsCatalog', () => ({
  useWindowsCatalog: () => ({
    catalog: {
      processes: [
        { name: 'Root.exe', path: 'C:\\Root.exe' },
        { name: 'Client.exe', path: 'C:\\Apps\\Client.exe' },
      ],
      packages: [
        { family: 'Pkg_one', name: 'Friendly App' },
        { family: 'Pkg_two', name: 'Second App' },
      ],
      services: [],
    },
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  errorText: (e: unknown) => String(e),
  serviceCall: vi.fn(async () => ({
    packages: [
      { family: 'Pkg_one', name: 'Friendly App', enabled: true },
      { family: 'Pkg_two', name: 'Second App', enabled: false },
    ],
  })),
}));
it('selects the containing directory including a valid drive-root folder', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host),
    changed = vi.fn();
  try {
    await act(async () => root.render(<ApplicationSelectors rows={[]} onChange={changed} />));
    const mode = host.querySelector<HTMLSelectElement>('[aria-label="Process match"]')!;
    await act(async () => {
      mode.value = 'folder';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const options = [...host.querySelectorAll<HTMLInputElement>('.capture-picker-list input')];
    await act(async () => options[0].click());
    expect(changed.mock.calls[0][0][0]).toMatchObject({
      kind: 'process',
      mode: 'folder',
      value: 'C:\\',
    });
    await act(async () => options[1].click());
    expect(changed.mock.calls[1][0][0]).toMatchObject({ mode: 'folder', value: 'C:\\Apps\\' });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('removes chosen processes from the PC list and restores them when deleted', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Controlled() {
    const [rows, setRows] = useState<import('../graph/applications').ApplicationSelector[]>([]);
    return <ApplicationSelectors rows={rows} onChange={setRows} />;
  }
  try {
    await act(async () => root.render(<Controlled />));
    expect(host.querySelector('.application-choice')!.textContent).toContain('C:\\Root.exe');
    await act(async () =>
      host.querySelector<HTMLInputElement>('.application-choice input')!.click(),
    );
    expect(host.querySelectorAll('.application-choice')).toHaveLength(1);
    expect(host.querySelector('.application-choice')!.textContent).not.toContain('Root.exe');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Remove Root.exe"]')!.click(),
    );
    expect(host.querySelectorAll('.application-choice')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('adds exempt apps without changing Windows permissions and supports all/none with friendly names', async () => {
  const { serviceCall } = await import('../serviceClient');
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Controlled() {
    const [rows, set] = useState<import('../graph/applications').ApplicationSelector[]>([
      { kind: 'process', value: 'Keep.exe', mode: 'name', children: false, enabled: true },
    ]);
    return <ApplicationSelectors rows={rows} onChange={set} />;
  }
  const click = async (name: string) =>
    act(async () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!.click(),
    );
  try {
    await act(async () => root.render(<Controlled />));
    const type = host.querySelector<HTMLSelectElement>('[aria-label="Application type"]')!;
    await act(async () => {
      type.value = 'package';
      type.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Add loopback-exempt apps');
    expect(serviceCall).toHaveBeenCalledWith('windows.loopback.get');
    expect(host.querySelector('.capture-selector-list')!.textContent).toContain('Friendly App');
    expect(host.querySelector('.capture-selector-list')!.textContent).not.toContain('Second App');
    await click('Select all');
    expect(
      host.querySelectorAll('.capture-selector-list input[aria-label^="Enable"]'),
    ).toHaveLength(3);
    await click('Select none');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Enable Pkg_one"]')!.checked).toBe(
      false,
    );
    expect(host.querySelector<HTMLInputElement>('[aria-label="Enable Keep.exe"]')!.checked).toBe(
      true,
    );
    await click('Select all');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Enable Pkg_two"]')!.checked).toBe(
      true,
    );
    expect(vi.mocked(serviceCall).mock.calls.every((c) => c[0] === 'windows.loopback.get')).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
