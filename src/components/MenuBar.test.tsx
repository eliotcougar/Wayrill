// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MenuBar from './MenuBar';

let root: Root, host: HTMLDivElement;
const action = vi.fn();
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  action.mockReset();
  await act(() =>
    root.render(
      <>
        <MenuBar
          menus={[
            {
              label: 'File',
              items: [
                { label: 'New draft', action },
                { label: 'Unavailable command', disabled: true, action },
                { label: '', separator: true },
                { label: 'Open graph', action },
                { label: 'Find graph', action },
              ],
            },
            { label: 'Help', items: [{ label: 'Keyboard help', action }] },
          ]}
        />
        <button>Outside</button>
      </>,
    ),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const trigger = () => host.querySelector<HTMLButtonElement>('.menu-trigger')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
async function key(target: HTMLElement, value: string) {
  await act(() =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
it.each(['Enter', ' ', 'ArrowDown'])(
  'opens with %s and focuses the first command',
  async (value) => {
    await act(() => trigger().focus());
    await key(trigger(), value);
    expect(document.activeElement).toBe(items()[0]);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(trigger().getAttribute('aria-controls')!)).toBe(
      host.querySelector('[role="menu"]'),
    );
  },
);
it('opens at the last command with Up, wraps and supports Home/End', async () => {
  await key(trigger(), 'ArrowUp');
  expect(document.activeElement).toBe(items().at(-1));
  await key(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], 'End');
  expect(document.activeElement).toBe(items().at(-1));
  await key(document.activeElement as HTMLElement, 'Home');
  await key(document.activeElement as HTMLElement, 'ArrowUp');
  expect(document.activeElement).toBe(items().at(-1));
});
it('allows reading a disabled command without executing or closing it', async () => {
  await key(trigger(), 'Enter');
  await key(items()[0], 'ArrowDown');
  expect(document.activeElement).toBe(items()[1]);
  await act(() => items()[1].click());
  expect(action).not.toHaveBeenCalled();
  expect(host.querySelector('[role="menu"]')).not.toBeNull();
});
it('returns focus on Escape and before activating a command', async () => {
  await key(trigger(), 'Enter');
  await key(items()[0], 'Escape');
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector('[role="menu"]')).toBeNull();
  await key(trigger(), 'Enter');
  action.mockImplementation(() => expect(document.activeElement).toBe(trigger()));
  await act(() => items()[0].click());
  expect(action).toHaveBeenCalledOnce();
});
it.each(['Tab', 'ShiftTab'])(
  'closes on %s without cancelling normal tab navigation',
  async (value) => {
    await key(trigger(), 'Enter');
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: value === 'ShiftTab',
      bubbles: true,
      cancelable: true,
    });
    await act(() => items()[0].dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(host.querySelector('[role="menu"]')).toBeNull();
  },
);
it('searches command names without sending graph shortcuts to the window', async () => {
  const behindMenu = vi.fn();
  window.addEventListener('keydown', behindMenu);
  try {
    await key(trigger(), 'Enter');
    await key(items()[0], 'f');
    expect(document.activeElement).toBe(items().at(-1));
    await key(document.activeElement as HTMLElement, 'Delete');
    expect(behindMenu).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', behindMenu);
  }
});
it('closes on outside pointer/focus without stealing the destination focus', async () => {
  await key(trigger(), 'Enter');
  const outside = host.lastElementChild as HTMLButtonElement;
  await act(() => {
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    outside.focus();
  });
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(outside);
});

it('opens a submenu with Right, navigates only that level and returns to its parent with Left/Escape', async () => {
  await act(() =>
    root.render(
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              { label: 'Open graph', action },
              {
                label: 'Load Example',
                items: [
                  { label: 'Traffic', action },
                  { label: 'DNS', action },
                ],
              },
            ],
          },
        ]}
      />,
    ),
  );
  await key(trigger(), 'Enter');
  await key(document.activeElement as HTMLElement, 'End');
  const parent = document.activeElement as HTMLButtonElement;
  expect(parent.textContent).toBe('Load Example');
  await key(parent, 'ArrowRight');
  expect(host.querySelectorAll('[role="menu"]')).toHaveLength(2);
  expect(document.activeElement?.textContent).toBe('Traffic');
  await key(document.activeElement as HTMLElement, 'ArrowUp');
  expect(document.activeElement?.textContent).toBe('DNS');
  await key(document.activeElement as HTMLElement, 'Escape');
  expect(document.activeElement).toBe(parent);
  expect(host.querySelectorAll('[role="menu"]')).toHaveLength(1);
  await key(parent, 'Enter');
  await key(document.activeElement as HTMLElement, 'ArrowLeft');
  expect(document.activeElement).toBe(parent);
  await act(() => parent.click());
  await act(() => (document.activeElement as HTMLButtonElement).click());
  expect(action).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector('[role="menu"]')).toBeNull();
});
it('opens a submenu on hover without taking keyboard focus and closes the branch on another row', async () => {
  await act(() =>
    root.render(
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              { label: 'Load Example', items: [{ label: 'Traffic', action }] },
              { label: 'Open graph', action },
            ],
          },
        ]}
      />,
    ),
  );
  await key(trigger(), 'Enter');
  const parent = document.activeElement as HTMLButtonElement;
  await act(() => parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelectorAll('[role="menu"]')).toHaveLength(2);
  expect(document.activeElement).toBe(parent);
  const row = [...host.querySelectorAll('[role="menuitem"]')].find(
    (b) => b.textContent === 'Open graph',
  )!;
  await act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelectorAll('[role="menu"]')).toHaveLength(1);
});
