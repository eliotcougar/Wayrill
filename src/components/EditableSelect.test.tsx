// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EditableSelect from './EditableSelect';

const options = ['https://first.test/204', 'https://second.test/204', 'https://third.test/204'];
let host: HTMLDivElement, root: Root;
const submit = vi.fn(),
  parentKeys = vi.fn();
function Fixture({ disabled = false, empty = false } = {}) {
  const [value, setValue] = useState('https://manual.test/204');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={parentKeys}
    >
      <EditableSelect
        label="Test URL"
        type="url"
        required
        value={value}
        options={empty ? [] : options}
        disabled={disabled}
        onChange={setValue}
      />
      <button type="button" className="outside">
        Outside
      </button>
    </form>
  );
}
const input = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!;
const popup = () => host.querySelector<HTMLDivElement>('[role="listbox"]')!;
const toggle = () => host.querySelector<HTMLButtonElement>('.editable-select-toggle')!;
async function key(name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  await act(() => input().dispatchEvent(event));
  return event;
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.showPopover = function () {
    this.dataset.open = 'true';
  };
  HTMLElement.prototype.hidePopover = function () {
    delete this.dataset.open;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<Fixture />));
  vi.spyOn(host.querySelector('.editable-select')!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(30, 80, 400, 36),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('commits a pointer choice, closes and returns focus to the editable input', async () => {
  await act(() => toggle().click());
  await act(() => (popup().children[1] as HTMLElement).click());
  expect(input().value).toBe(options[1]);
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(popup().dataset.open).toBeUndefined();
  expect(document.activeElement).toBe(input());
  expect(submit).not.toHaveBeenCalled();
});
it('supports arrow navigation and Enter without submitting the settings form', async () => {
  await key('ArrowDown');
  await key('ArrowDown');
  const selected = document.getElementById(input().getAttribute('aria-activedescendant')!);
  expect(selected?.textContent).toBe(options[1]);
  const event = await key('Enter');
  expect(event.defaultPrevented).toBe(true);
  expect(input().value).toBe(options[1]);
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(submit).not.toHaveBeenCalled();
});
