// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ActionMenu from './ActionMenu';
import MenuBar from './MenuBar';
import EditableSelect from './EditableSelect';
import NodeContextMenu from './NodeContextMenu';

let host: HTMLDivElement, root: Root;
const action = vi.fn();
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.showPopover = function () {
    this.dataset.open = 'true';
  };
  HTMLElement.prototype.hidePopover = function () {
    delete this.dataset.open;
  };
  action.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const click = async (element: HTMLElement) => act(() => element.click());
async function transientFocus(target: Element, next: EventTarget | null) {
  await act(() =>
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next })),
  );
}

it.each(['action', 'bar', 'context'] as const)(
  '%s menu survives transient ancestor and null focus until its command activates',
  async (kind) => {
    function Fixture() {
      const [context, setContext] = useState(true);
      const items = [
        { label: 'Keep open', disabled: true },
        { label: 'Run once', action },
      ];
      return (
        <dialog open tabIndex={-1}>
          {kind === 'action' ? (
            <ActionMenu label="Actions" items={items} />
          ) : kind === 'bar' ? (
            <MenuBar menus={[{ label: 'File', items }]} />
          ) : (
            context && (
              <NodeContextMenu
                x={50}
                y={50}
                label="Fixture"
                items={items}
                onClose={() => setContext(false)}
              />
            )
          )}
          <button className="outside">Outside</button>
        </dialog>
      );
    }
    await act(() => root.render(<Fixture />));
    if (kind !== 'context')
      await click(host.querySelector(kind === 'bar' ? '.menu-trigger' : 'button')!);
    const menu = document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const ancestor = kind === 'context' ? document.body : host.querySelector('dialog')!;
    for (const next of [ancestor, null]) {
      await transientFocus(items[0], next);
      expect(menu.isConnected).toBe(true);
    }
    await click(items[0]);
    expect(menu.isConnected).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await click(items[1]);
    expect(action).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it.each(['action', 'bar', 'context'] as const)(
  '%s menu closes on a real outside focus move',
  async (kind) => {
    function Fixture() {
      const [open, setOpen] = useState(true);
      const items = [{ label: 'Run once', action }];
      return (
        <>
          {kind === 'action' ? (
            <ActionMenu label="Actions" items={items} />
          ) : kind === 'bar' ? (
            <MenuBar menus={[{ label: 'File', items }]} />
          ) : (
            open && (
              <NodeContextMenu
                x={50}
                y={50}
                label="Fixture"
                items={items}
                onClose={() => setOpen(false)}
              />
            )
          )}
          <button className="outside">Outside</button>
        </>
      );
    }
    await act(() => root.render(<Fixture />));
    if (kind !== 'context')
      await click(host.querySelector(kind === 'bar' ? '.menu-trigger' : 'button')!);
    const outside = host.querySelector<HTMLButtonElement>('.outside')!;
    await act(() => outside.focus());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(action).not.toHaveBeenCalled();
  },
);

function Presets({ disabled = false, empty = false }: { disabled?: boolean; empty?: boolean }) {
  const [value, setValue] = useState('manual');
  return (
    <dialog open tabIndex={-1}>
      <EditableSelect
        label="Endpoint"
        value={value}
        onChange={setValue}
        disabled={disabled}
        options={empty ? [] : ['First', 'Second']}
      />
      <button className="outside">Outside</button>
    </dialog>
  );
}
it('preserves an editable preset through transient modal focus and commits the subsequent click', async () => {
  await act(() => root.render(<Presets />));
  for (let i = 0; i < 6; i++) {
    await click(host.querySelector('.editable-select-toggle')!);
    const input = host.querySelector<HTMLInputElement>('input')!;
    await transientFocus(input, host.querySelector('dialog')!);
    await transientFocus(input, null);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await click(host.querySelectorAll<HTMLElement>('[role="option"]')[i % 2]);
    expect(input.value).toBe(i % 2 ? 'Second' : 'First');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(input);
  }
});
it.each([{ disabled: true }, { empty: true }])(
  'retires an open preset list when it becomes unavailable: %j',
  async (props) => {
    await act(() => root.render(<Presets />));
    await click(host.querySelector('.editable-select-toggle')!);
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.dataset.open).toBe('true');
    await act(() => root.render(<Presets {...props} />));
    expect(host.querySelector('input')!.getAttribute('aria-expanded')).toBe('false');
    expect(list.dataset.open).toBeUndefined();
    await act(() => root.render(<Presets />));
    expect(list.dataset.open).toBeUndefined();
  },
);

async function menuKey(target: HTMLElement, key: string) {
  await act(() =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
}
const hover = async (target: Element) =>
  act(() => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));

it('keeps keyboard focus in the new root menu when hover replaces a focused menu', async () => {
  await act(() =>
    root.render(
      <MenuBar
        menus={[
          { label: 'File', items: [{ label: 'First', action }] },
          { label: 'Help', items: [{ label: 'Second', action }] },
        ]}
      />,
    ),
  );
  const triggers = host.querySelectorAll<HTMLButtonElement>('.menu-trigger');
  await click(triggers[0]);
  expect(document.activeElement?.textContent).toBe('First');
  await hover(triggers[1]);
  expect(document.activeElement?.textContent).toBe('Second');
  await menuKey(document.activeElement as HTMLElement, 'Escape');
  expect(document.activeElement).toBe(triggers[1]);
});

it.each([false, true])(
  'preserves focus when hover retires a focused submenu (new branch: %s)',
  async (branch) => {
    await act(() =>
      root.render(
        <MenuBar
          menus={[
            {
              label: 'File',
              items: [
                { label: 'Old branch', items: [{ label: 'Old child', action }] },
                branch
                  ? { label: 'New branch', items: [{ label: 'New child', action }] }
                  : { label: 'Leaf', action },
              ],
            },
          ]}
        />,
      ),
    );
    await click(host.querySelector('.menu-trigger')!);
    await menuKey(document.activeElement as HTMLElement, 'ArrowRight');
    expect(document.activeElement?.textContent).toBe('Old child');
    const next = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === (branch ? 'New branch' : 'Leaf'),
    )!;
    await hover(next);
    expect(document.activeElement).toBe(next);
    expect(host.querySelectorAll('[role="menu"]')).toHaveLength(branch ? 2 : 1);
    if (branch) {
      await menuKey(next, 'ArrowRight');
      expect(document.activeElement?.textContent).toBe('New child');
    }
    expect(action).not.toHaveBeenCalled();
  },
);
