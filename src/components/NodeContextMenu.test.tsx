// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import NodeContextMenu from './NodeContextMenu';
let root: Root, host: HTMLDivElement;
const edit = vi.fn(),
  duplicate = vi.fn(),
  remove = vi.fn(),
  closed = vi.fn();
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button id="owner">Node</button>
      {open && (
        <NodeContextMenu
          x={1020}
          y={760}
          label="Destination"
          onClose={(restore) => {
            closed(restore);
            if (restore) document.getElementById('owner')?.focus();
            setOpen(false);
          }}
          items={[
            { label: 'Edit…', action: edit },
            { label: '', separator: true },
            { label: 'Duplicate', disabled: true, action: duplicate },
            { label: 'Delete', action: remove, destructive: true },
          ]}
        />
      )}
    </>
  );
}
const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent === label,
  )!;
const key = async (value: string) =>
  act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 215,
    bottom: 200,
    width: 215,
    height: 200,
    toJSON() {},
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it('fits inside viewport, supports arrows/typeahead and returns focus on Escape without running graph shortcuts', async () => {
  const leaked = vi.fn();
  window.addEventListener('keydown', leaked);
  try {
    await act(() => root.render(<Harness />));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(Number.parseFloat(menu.style.left) + 215).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(Number.parseFloat(menu.style.top) + 200).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(document.activeElement).toBe(item('Edit…'));
    await key('ArrowUp');
    expect(document.activeElement).toBe(item('Delete'));
    await key('Home');
    expect(document.activeElement).toBe(item('Edit…'));
    await key('d');
    expect(document.activeElement).toBe(item('Duplicate'));
    await key('d');
    expect(document.activeElement).toBe(item('Delete'));
    await key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('owner'));
    expect(leaked).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', leaked);
  }
});
it('keeps disabled actions inert and focuses the surviving node before opening an editor', async () => {
  edit.mockImplementation(() =>
    expect(document.activeElement).toBe(document.getElementById('owner')),
  );
  await act(() => root.render(<Harness />));
  await act(() => item('Duplicate').click());
  expect(duplicate).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  await act(() => item('Edit…').click());
  expect(edit).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledExactlyOnceWith(true);
});
it('dismisses outside without stealing focus from the clicked control', async () => {
  await act(() => root.render(<Harness />));
  const owner = document.getElementById('owner')!;
  await act(() => {
    owner.focus();
    owner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(owner);
  expect(edit).not.toHaveBeenCalled();
});

it('opens Replace as a submenu, preserves keyboard focus, and runs only the chosen starred action', async () => {
  const replace = vi.fn(),
    browse = vi.fn();
  await act(() =>
    root.render(
      <NodeContextMenu
        x={20}
        y={20}
        label="Main"
        onClose={closed}
        items={[
          { label: 'Edit…', action: edit },
          {
            label: 'Replace',
            items: [
              { label: '🇳🇱 Amsterdam · Servers', action: replace },
              { label: 'Unavailable', disabled: true, action: duplicate },
              { label: '', separator: true },
              { label: 'Select from Stash…', action: browse },
            ],
          },
          { label: 'Delete', action: remove },
        ]}
      />,
    ),
  );
  await act(() => item('Replace').click());
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
  expect(closed).not.toHaveBeenCalled();
  item('Replace').focus();
  await key('ArrowRight');
  expect(document.activeElement).toBe(item('🇳🇱 Amsterdam · Servers'));
  await key('ArrowLeft');
  expect(document.activeElement).toBe(item('Replace'));
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  await key('ArrowRight');
  await act(() => item('Unavailable').click());
  expect(duplicate).not.toHaveBeenCalled();
  await act(() => item('🇳🇱 Amsterdam · Servers').click());
  expect(replace).toHaveBeenCalledOnce();
  expect(browse).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledExactlyOnceWith(true);
});
