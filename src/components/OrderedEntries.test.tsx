// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { OrderedEntries, moveEntry, type OrderedEntry } from './OrderedEntries';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const original: OrderedEntry[] = ['first', 'second', 'third'].map((id) => ({
  id,
  name: id,
  enabled: true,
  summary: 'Condition',
}));
function Harness() {
  const [entries, setEntries] = useState(original),
    [selected, setSelected] = useState('second');
  const move = (id: string, to: number) =>
    setEntries((rows) =>
      moveEntry(
        rows,
        rows.findIndex((e) => e.id === id),
        to,
      ),
    );
  return (
    <>
      <OrderedEntries
        entries={entries}
        selected={selected}
        onSelect={setSelected}
        onMove={move}
        label="Ordered test entries"
        empty="Empty"
      />
    </>
  );
}
async function press(target: HTMLElement, key: string, altKey = false) {
  await act(() => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }),
    );
  });
}
it('moves by keyboard while preserving row identity, selection and focus', async () => {
  await act(() => root.render(<Harness />));
  const selected = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
  await press(selected, 'ArrowUp', true);
  expect(host.querySelector('.rule-list button')).toBe(selected);
  expect(document.activeElement).toBe(selected);
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  await press(selected, 'ArrowDown', true);
  expect(document.activeElement).toBe(selected);
});

it('reorders from the captured drag handle and cancels drops outside the list', async () => {
  HTMLElement.prototype.setPointerCapture = () => {};
  await act(() => root.render(<Harness />));
  const list = host.querySelector<HTMLElement>('.rule-list')!;
  list.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 180 }) as DOMRect;
  const rows = [...host.querySelectorAll<HTMLButtonElement>('.rule-list button')];
  rows.forEach(
    (row, i) =>
      (row.getBoundingClientRect = () => ({ top: i * 60, bottom: (i + 1) * 60 }) as DOMRect),
  );
  const handle = rows[1].querySelector<HTMLElement>('.rule-drag-handle')!;
  const pointer = async (type: string, x: number, y: number) =>
    act(() => {
      const event = new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      handle.dispatchEvent(event);
    });
  await pointer('pointerdown', 20, 90);
  await pointer('pointermove', 20, 25);
  await pointer('pointerup', 20, 25);
  await act(() => rows[1].click());
  expect(host.querySelector('.rule-list button')).toBe(rows[1]);
  expect(document.activeElement).toBe(rows[1]);
  await pointer('pointerdown', 20, 90);
  await pointer('pointermove', 300, 170);
  await pointer('pointerup', 300, 170);
  expect([...host.querySelectorAll('.rule-list strong')].map((e) => e.textContent)).toEqual([
    'second',
    'first',
    'third',
  ]);
});
