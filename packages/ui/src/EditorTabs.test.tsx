// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorTabList, EditorTabPanels, useEditorTabs } from './EditorTabs';

let host: HTMLDivElement, root: Root;
const selected = vi.fn(),
  submitted = vi.fn();
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [tab, setTab] = useState('Listener');
  const tabs = useEditorTabs(
    [
      { key: 'Listener', label: 'Listener' },
      { key: 'TLS / REALITY', label: 'TLS / REALITY' },
    ],
    tab,
    (key) => {
      selected(key);
      setTab(key);
    },
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <EditorTabList tabs={tabs} label="Sections" disabled={disabled} />
      <EditorTabPanels tabs={tabs} className="panel">
        {(key) => <input aria-label={key + ' draft'} defaultValue="" />}
      </EditorTabPanels>
    </form>
  );
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  selected.mockReset();
  submitted.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
async function key(target: HTMLElement, value: string) {
  await act(() =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}

it('explores tabs without activating them, then activates without submitting the surrounding form', async () => {
  await act(() => root.render(<Harness />));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(() => buttons[0].focus());
  await key(buttons[0], 'ArrowRight');
  expect(document.activeElement).toBe(buttons[1]);
  expect(selected).not.toHaveBeenCalled();
  expect(buttons[0].getAttribute('aria-selected')).toBe('true');
  await key(buttons[1], 'Enter');
  expect(selected).toHaveBeenCalledWith('TLS / REALITY');
  expect(submitted).not.toHaveBeenCalled();
  const panel = document.getElementById(buttons[1].getAttribute('aria-controls')!);
  expect(panel?.getAttribute('aria-labelledby')).toBe(buttons[1].id);
  expect(/\s/.test(buttons[1].id)).toBe(false);
});

it('keeps an unfinished field draft when switching away and back', async () => {
  await act(() => root.render(<Harness />));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const input = host.querySelector<HTMLInputElement>('input')!;
  input.value = 'unfinished';
  await act(() => buttons[1].click());
  await act(() => buttons[0].click());
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('unfinished');
});

it('allows keyboard inspection while preventing activation of disabled tabs', async () => {
  await act(() => root.render(<Harness disabled />));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(() => buttons[0].focus());
  await key(buttons[0], 'End');
  expect(document.activeElement).toBe(buttons[1]);
  await key(buttons[1], ' ');
  await act(() => buttons[1].click());
  expect(selected).not.toHaveBeenCalled();
});
