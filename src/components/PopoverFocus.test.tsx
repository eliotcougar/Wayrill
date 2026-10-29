// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ActionMenu from './ActionMenu';
import MenuBar from './MenuBar';
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
