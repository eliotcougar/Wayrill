// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import StashEntryEditor from './StashEntryEditor';
import { importProfiles } from '../profiles/import';
import { preparedPreview } from '../profiles/preparedPreview';
vi.mock('../profiles/preparedPreviewClient', () => ({
  checkPrepared: async (
    g: Parameters<typeof preparedPreview>[0],
    n: Parameters<typeof preparedPreview>[1],
  ) => {
    preparedPreview(g, n);
  },
}));
let root: Root, host: HTMLDivElement;
const save = vi.fn(),
  close = vi.fn();
const entry = () => importProfiles('socks://old.example.net:1080#Friendly').groups[0].entries[0];
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  save.mockReset();
  close.mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
async function change(selector: string, value: string) {
  await act(() => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('edits the full ordinary outbound fields, retains protection metadata, and saves only on confirmation', async () => {
  const original = { ...entry(), locked: true };
  await act(() => root.render(<StashEntryEditor entry={original} onSave={save} onClose={close} />));
  await change('#node-label', 'Edited 🧭');
  await change('#setting-address', 'new.example.net');
  expect(save).not.toHaveBeenCalled();
  expect(original.profile?.settings.address).toBe('old.example.net');
  await act(async () => button('Save to Stash').click());
  expect(save.mock.calls[0][0]).toMatchObject({
    id: original.id,
    name: 'Edited 🧭',
    locked: true,
    profile: { settings: { address: 'new.example.net' } },
  });
  expect(close).toHaveBeenCalledOnce();
});
