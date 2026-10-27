// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTrafficExample } from '../graph/example';
import DnsEditor from './DnsEditor';
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
it('selects with arrows and Home/End using one tab stop without reordering', async () => {
  await act(() => root.render(<Harness />));
  const rows = [...host.querySelectorAll<HTMLButtonElement>('.rule-list button')];
  expect(rows.filter((b) => b.tabIndex === 0)).toEqual([rows[1]]);
  await press(rows[1], 'ArrowDown');
  expect(document.activeElement).toBe(rows[2]);
  await press(rows[2], 'Home');
  expect(document.activeElement).toBe(rows[0]);
  await press(rows[0], 'End');
  expect(document.activeElement).toBe(rows[2]);
  expect([...host.querySelectorAll('.rule-list strong')].map((e) => e.textContent)).toEqual([
    'first',
    'second',
    'third',
  ]);
});
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

it('keeps the first row keyboard reachable when a diagnostic refers to a deleted row', async () => {
  await act(() =>
    root.render(
      <OrderedEntries
        entries={original}
        selected="deleted"
        onSelect={() => {}}
        onMove={() => {}}
        label="Rows"
        empty="Empty"
      />,
    ),
  );
  expect(host.querySelector<HTMLButtonElement>('.rule-list button')!.tabIndex).toBe(0);
});

it.each(['dns-handler', 'dns-routing-filter', 'dns-servers'])(
  'moves %s entries while preserving settings and stable identities',
  async (kind) => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    const graph = createTrafficExample(),
      node = graph.nodes.find((n) => n.data.kind === kind)!;
    const key =
      kind === 'dns-handler' ? 'policyRules' : kind === 'dns-servers' ? 'servers' : 'rules';
    const rows = JSON.parse(String(node.data.settings[key]));
    rows.splice(1, rows.length - 1, { ...rows[0], id: 'second', name: 'Secondary entry' });
    node.data.settings[key] = JSON.stringify(rows);
    const before = structuredClone(graph),
      applied: unknown[][] = [];
    await act(() =>
      root.render(
        <DnsEditor
          node={node}
          graph={graph}
          onApply={(...args) => {
            applied.push(args);
          }}
          onClose={() => {}}
        />,
      ),
    );
    const second = host.querySelectorAll<HTMLButtonElement>('.rule-list button')[1];
    await act(() => second.click());
    expect(host.querySelector('.entry-position')).toBeNull();
    const up = host.querySelector<HTMLButtonElement>('[aria-label="Move entry up"]')!;
    expect(up.closest('.ordered-rules')).not.toBeNull();
    await act(() => up.click());
    expect(host.querySelector('.rule-list button')).toBe(second);
    expect(graph).toEqual(before);
    await act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Apply changes')!
        .click(),
    );
    expect(applied).toHaveLength(1);
    const settings = (applied[0][1] as { settings: Record<string, string> }).settings;
    expect(JSON.parse(settings[key])).toEqual([rows[1], rows[0]]);
  },
);

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
