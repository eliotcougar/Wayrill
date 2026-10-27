// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ActionMenu from './ActionMenu';

it('keeps modal commands inside the dialog, supports keyboard inspection and restores focus', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const dialog = document.createElement('dialog');
  dialog.open = true;
  document.body.append(dialog);
  const root = createRoot(dialog);
  const action = vi.fn();
  try {
    await act(() =>
      root.render(
        <ActionMenu
          label="Group actions"
          items={[
            { label: 'Refresh', action },
            { label: 'Unavailable', disabled: true, action },
            { label: 'Export', action },
          ]}
        />,
      ),
    );
    const trigger = dialog.querySelector('button')!;
    const key = async (element: HTMLElement, key: string) =>
      act(() =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        ),
      );
    await act(() => trigger.focus());
    await key(trigger, 'ArrowUp');
    expect(dialog.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Export');
    await key(document.activeElement as HTMLElement, 'Home');
    await key(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Unavailable');
    await act(() => (document.activeElement as HTMLButtonElement).click());
    expect(action).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await key(document.activeElement as HTMLElement, 'Escape');
    expect(document.activeElement).toBe(trigger);
    expect(dialog.querySelector('[role="menu"]')).toBeNull();
    await act(() => trigger.click());
    action.mockImplementation(() => expect(document.activeElement).toBe(trigger));
    await act(() => dialog.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(action).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    dialog.remove();
  }
});
