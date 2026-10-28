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
async function enter(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
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

it('aligns the full unfiltered menu beneath the field, including while editing a custom URL', async () => {
  await act(() => toggle().click());
  expect(popup().style.left).toBe('30px');
  expect(popup().style.top).toBe('120px');
  expect(popup().style.width).toBe('400px');
  expect(popup().dataset.open).toBe('true');
  expect(input().required).toBe(true);
  expect(input().type).toBe('url');
  await enter('https://another-manual.test/');
  expect(
    [...popup().querySelectorAll('[role="option"]')].map((element) => element.textContent),
  ).toEqual(options);
  expect(input().value).toBe('https://another-manual.test/');
  expect(input().getAttribute('aria-activedescendant')).toBeNull();
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
it('navigates upward after manual editing and Escape does not escape the containing dialog', async () => {
  await act(() => toggle().click());
  await enter('https://manual-updated.test/');
  await key('ArrowUp');
  expect(document.getElementById(input().getAttribute('aria-activedescendant')!)?.textContent).toBe(
    options[2],
  );
  parentKeys.mockClear();
  const event = await key('Escape');
  expect(event.defaultPrevented).toBe(true);
  expect(parentKeys).not.toHaveBeenCalled();
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(input().value).toBe('https://manual-updated.test/');
});
it('dismisses on Tab or an outside click without committing a highlighted value', async () => {
  await key('ArrowDown');
  expect((await key('Tab')).defaultPrevented).toBe(false);
  expect(input().getAttribute('aria-expanded')).toBe('false');
  await act(() => toggle().click());
  await act(() =>
    host.querySelector('.outside')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
  );
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(input().value).toBe('https://manual.test/204');
});
it('fits the viewport and follows an editor scroll instead of clipping the menu', async () => {
  const measure = vi.mocked(host.querySelector('.editable-select')!.getBoundingClientRect);
  measure.mockReturnValue(new DOMRect(30, 740, 400, 36));
  await act(() => toggle().click());
  expect(Number.parseFloat(popup().style.top)).toBeLessThan(740);
  measure.mockReturnValue(new DOMRect(60, 200, 420, 36));
  await act(() => window.dispatchEvent(new Event('scroll')));
  expect(popup().style.top).toBe('240px');
  expect(popup().style.left).toBe('60px');
  expect(popup().style.width).toBe('420px');
});
it.each([{ disabled: true }, { empty: true }])(
  'does not open an unavailable preset list: %j',
  async (props) => {
    await act(() => root.render(<Fixture {...props} />));
    await key('ArrowDown');
    expect(toggle().disabled).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('false');
  },
);
