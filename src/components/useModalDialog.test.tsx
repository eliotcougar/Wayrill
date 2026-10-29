// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useModalDialog from './useModalDialog';
let root: Root, host: HTMLDivElement, opener: HTMLButtonElement;
const show = vi.fn(function (this: HTMLDialogElement) {
  this.open = true;
  this.querySelector<HTMLButtonElement>('button')!.focus();
});
function Modal() {
  const ref = useRef<HTMLDialogElement>(null);
  useModalDialog(ref);
  return (
    <dialog ref={ref}>
      <button>Cancel</button>
    </dialog>
  );
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = show;
  show.mockClear();
  host = document.createElement('div');
  opener = document.createElement('button');
  opener.textContent = 'Edit node';
  document.body.append(opener, host);
  root = createRoot(host);
  opener.focus();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  opener.remove();
});
it('does not pull focus out of a replacement modal or focus a deleted opener', async () => {
  await act(() => root.render(<Modal />));
  opener.remove();
  await act(() => root.render(<Modal key="replacement" />));
  expect(document.activeElement?.textContent).toBe('Cancel');
  await act(() => root.render(null));
  expect(document.activeElement).toBe(document.body);
});
