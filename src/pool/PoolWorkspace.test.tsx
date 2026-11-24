// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { importProfiles, serializeStash } from '../profiles/import';
import PoolWorkspace from './PoolWorkspace';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

it('keeps an imported replacement saved across restart while inbox cleanup is blocked', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const groups = importProfiles('socks://192.0.2.1:1080#New server').groups;
  const stash = serializeStash({ format: 'wayrill.stash', version: 3, groups });
  const emptyStash = serializeStash({ format: 'wayrill.stash', version: 3, groups: [] });
  let saved = JSON.stringify({
    version: 1,
    pools: [
      {
        id: 'pool',
        name: 'Office',
        folder: 'C:/pool',
        configurations: [],
        members: [],
        layers: [{ id: 'target', name: 'Servers', data: { kind: 'stash', stash: emptyStash } }],
      },
    ],
  });
  let pending = true,
    locked = true;
  vi.mocked(invoke).mockImplementation(async (method, params) => {
    switch (method) {
      case 'pool_read':
        return saved;
      case 'pool_accounts_read':
        return [];
      case 'pool_inbox':
        return pending ? [id] : [];
      case 'pool_import':
        return JSON.stringify({ kind: 'stash', name: 'Import', stash });
      case 'pool_write':
        saved = String((params as { text: string }).text);
        return;
      case 'pool_discard':
        if (locked) throw new Error('The inbox file is locked.');
        pending = false;
        return;
      default:
        throw new Error(method);
    }
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  try {
    await act(async () => root.render(<PoolWorkspace />));
    await click('Review exports');
    await click('Review');
    await act(() => {
      const select = host.querySelector<HTMLSelectElement>('dialog select')!;
      select.value = 'target';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Replace layer');
    expect(pending).toBe(true);
    expect(host.textContent).toContain('Stash layer saved.');
    expect(JSON.parse(saved)).toMatchObject({
      acceptedImports: [id],
      pools: [{ layers: [{ id: 'target', data: { stash } }] }],
    });
    await act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<PoolWorkspace />));
    expect(host.textContent).not.toContain('Review exports');
    locked = false;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(pending).toBe(false);
    expect(host.textContent).not.toContain('Review exports');
    expect(vi.mocked(invoke).mock.calls.filter(([method]) => method === 'pool_write')).toHaveLength(
      1,
    );
  } finally {
    await act(() => root.unmount());
    host.remove();
    HTMLDialogElement.prototype.showModal = showModal;
    vi.unstubAllGlobals();
  }
});
