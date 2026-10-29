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
async function key(target: HTMLElement, value: string) {
  await act(() =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}

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
