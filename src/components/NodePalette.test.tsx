// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import NodePalette from './NodePalette';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
async function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1) {
  await act(() => {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'isPrimary', { value: true });
    target.dispatchEvent(event);
  });
}
it('drops at the pointer position once and suppresses the trailing button click', async () => {
  const onDrop = vi.fn(),
    onAdd = vi.fn();
  await act(() => root.render(<NodePalette onAdd={onAdd} onDrop={onDrop} />));
  const item = host.querySelector<HTMLButtonElement>(
    '[aria-label="Add Proxy inbound (Inbounds)"]',
  )!;
  await pointer(item, 'pointerdown', 20, 40);
  await pointer(item, 'pointermove', 220, 140, 2);
  expect(document.querySelector('.palette-drag-preview')).toBeNull();
  await pointer(item, 'pointermove', 220, 140);
  expect(document.querySelector('.palette-drag-preview')).not.toBeNull();
  await pointer(item, 'pointerup', 320, 240);
  await act(() => item.click());
  expect(onDrop).toHaveBeenCalledExactlyOnceWith(expect.any(String), { x: 320, y: 240 });
  expect(onAdd).not.toHaveBeenCalled();
  expect(document.querySelector('.palette-drag-preview')).toBeNull();
});
it('keeps short presses and keyboard clicks usable and cancels interrupted drags', async () => {
  const onDrop = vi.fn(),
    onAdd = vi.fn();
  await act(() => root.render(<NodePalette onAdd={onAdd} onDrop={onDrop} />));
  const item = host.querySelector<HTMLButtonElement>('.palette-item')!;
  await pointer(item, 'pointerdown', 20, 40);
  await pointer(item, 'pointermove', 23, 42);
  await pointer(item, 'pointerup', 23, 42);
  await act(() => item.click());
  expect(onAdd).toHaveBeenCalledTimes(1);
  await pointer(item, 'pointerdown', 20, 40);
  await pointer(item, 'pointermove', 200, 140);
  await pointer(item, 'pointercancel', 200, 140);
  await pointer(item, 'pointerup', 300, 240);
  await act(() => item.click());
  expect(onDrop).not.toHaveBeenCalled();
  expect(onAdd).toHaveBeenCalledTimes(1);
  await act(() => item.click());
  expect(onAdd).toHaveBeenCalledTimes(2);
});
