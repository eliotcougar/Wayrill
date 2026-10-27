// @vitest-environment jsdom
import { act, StrictMode, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useModalDialog from './useModalDialog';
import { DiagnosticFocusContext } from './DiagnosticNavigation';
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
it('restores the opener after an open native dialog is removed', async () => {
  await act(() => root.render(<Modal />));
  expect(document.activeElement?.textContent).toBe('Cancel');
  await act(() => root.render(null));
  expect(document.activeElement).toBe(opener);
});
it('keeps the original opener through Strict Mode effect replay', async () => {
  await act(() =>
    root.render(
      <StrictMode>
        <Modal />
      </StrictMode>,
    ),
  );
  expect(show).toHaveBeenCalledOnce();
  expect(host.querySelector('dialog')!.open).toBe(true);
  await act(() => root.render(null));
  expect(document.activeElement).toBe(opener);
});
it('does not steal an intentional focus destination when the dialog closes', async () => {
  const destination = document.createElement('button');
  document.body.append(destination);
  try {
    await act(() => root.render(<Modal />));
    destination.focus();
    await act(() => root.render(null));
    expect(document.activeElement).toBe(destination);
  } finally {
    destination.remove();
  }
});
it('does not pull focus out of a replacement modal or focus a deleted opener', async () => {
  await act(() => root.render(<Modal />));
  opener.remove();
  await act(() => root.render(<Modal key="replacement" />));
  expect(document.activeElement?.textContent).toBe('Cancel');
  await act(() => root.render(null));
  expect(document.activeElement).toBe(document.body);
});

it('returns diagnostic-opened editors to a surviving workspace trigger', async () => {
  const removedReview = document.createElement('button');
  removedReview.textContent = 'Review';
  document.body.append(removedReview);
  removedReview.focus();
  await act(() =>
    root.render(
      <DiagnosticFocusContext.Provider
        value={{
          surface: 'editor',
          issue: { severity: 'error', message: 'Public error' },
          returnFocus: opener,
        }}
      >
        <Modal />
      </DiagnosticFocusContext.Provider>,
    ),
  );
  removedReview.remove();
  await act(() => root.render(null));
  expect(document.activeElement).toBe(opener);
});
