// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';

let root: Root, host: HTMLDivElement;
function Example({ disabled = false }: { disabled?: boolean }) {
  const [selected, select] = useState<'rules' | 'preview' | 'outputs'>('rules');
  const tabs = useEditorTabs(
    [
      { key: 'rules', label: 'Rules' },
      { key: 'outputs', label: 'Outputs' },
      { key: 'preview', label: 'Preview' },
    ],
    selected,
    select,
  );
  return (
    <>
      <EditorTabs tabs={tabs} label="Sections" disabled={disabled} />
      <EditorTabPanels tabs={tabs} className="body">
        <button>{selected} contents</button>
      </EditorTabPanels>
      <button>After panels</button>
    </>
  );
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<Example />));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
async function key(value: string) {
  await act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
it('moves and wraps focus without activating costly contents; Enter/Space activate', async () => {
  await act(() => tabs()[0].focus());
  await key('ArrowRight');
  expect(document.activeElement).toBe(tabs()[1]);
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).not.toContain('outputs contents');
  await key('Enter');
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).toContain('outputs contents');
  await key('End');
  await key('ArrowRight');
  expect(document.activeElement).toBe(tabs()[0]);
  await key('ArrowLeft');
  expect(document.activeElement).toBe(tabs()[2]);
  await key(' ');
  expect(host.textContent).toContain('preview contents');
  await key('Home');
  expect(document.activeElement).toBe(tabs()[0]);
});
it('has one roving stop and resets entry to the selected tab after leaving', async () => {
  await act(() => tabs()[0].focus());
  await key('ArrowRight');
  expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  await act(() => host.querySelector<HTMLButtonElement>('[role="tabpanel"] button')!.focus());
  expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
});
it('keeps each tab associated with an existing named panel, with only one visible', () => {
  for (const tab of tabs()) {
    const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(panel.hidden).toBe(tab.getAttribute('aria-selected') !== 'true');
  }
});
it('does not capture vertical arrows or Tab', async () => {
  await act(() => tabs()[0].focus());
  for (const key of ['ArrowUp', 'ArrowDown', 'Tab']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(() => tabs()[0].dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
});
it('retains readable keyboard focus but blocks selection during an operation', async () => {
  await act(() => root.render(<Example disabled />));
  await act(() => tabs()[0].focus());
  await key('ArrowRight');
  await key('Enter');
  await act(() => tabs()[1].click());
  expect(document.activeElement).toBe(tabs()[1]);
  expect(tabs()[1].getAttribute('aria-disabled')).toBe('true');
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
});

it('mounts render-function sections lazily, retains visited local state and updates their props', async () => {
  function Draft({ name }: { name: string }) {
    const [value, setValue] = useState('');
    return <input aria-label={name} value={value} onChange={(e) => setValue(e.target.value)} />;
  }
  function Retained() {
    const [selected, select] = useState<'first' | 'second'>('first'),
      [name, setName] = useState('original');
    const model = useEditorTabs(
      [
        { key: 'first', label: 'First' },
        { key: 'second', label: 'Second' },
      ],
      selected,
      select,
    );
    return (
      <>
        <EditorTabs tabs={model} label="Retained" />
        <EditorTabPanels tabs={model} className="body">
          {(key) => <Draft name={`${name}-${key}`} />}
        </EditorTabPanels>
        <button onClick={() => setName('updated')}>Change prop</button>
      </>
    );
  }
  await act(() => root.render(<Retained />));
  expect(host.querySelectorAll('input')).toHaveLength(1);
  const first = host.querySelector('input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      first,
      'unfinished',
    );
    first.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => tabs()[1].click());
  expect(host.querySelectorAll('input')).toHaveLength(2);
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Change prop')!.click(),
  );
  expect(first.getAttribute('aria-label')).toBe('updated-first');
  await act(() => tabs()[0].click());
  expect(host.querySelector('input')).toBe(first);
  expect(first.value).toBe('unfinished');
});
