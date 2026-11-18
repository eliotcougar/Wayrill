import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import RemoteSettings from '../RemoteSettings';
let host: HTMLDivElement, root: Root;
function interact(action: () => void) {
  return act(() => Promise.resolve(action()));
}
const destinations = [
  { tag: 'direct', group: false },
  { tag: 'relay-eu', group: false },
  { tag: 'automatic', group: true },
];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await interact(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      (item.getAttribute('role') === 'tab'
        ? item.childNodes[0]?.textContent?.trim()
        : item.textContent?.trim()) === name,
  )!;
const control = (name: string) =>
  host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${name}"]`,
  )!;
const click = (name: string) => interact(() => button(name).click());
async function change(name: string, value: string) {
  const input = control(name);
  expect(input, name).not.toBeNull();
  await interact(() => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const toggle = (name: string) => interact(() => control(name).click());
async function render(value: unknown, schema = 'Config') {
  const save = vi.fn(),
    close = vi.fn();
  await interact(() =>
    root.render(
      <RemoteSettings
        title="Example"
        value={value}
        schema={schema}
        destinations={destinations}
        onSave={save}
        onClose={close}
      />,
    ),
  );
  return { save, close };
}

export { host, root, button, control, click, change, toggle, render };
