// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import RoutingLogFilter, { allLogItems } from './RoutingLogFilter';

let host: HTMLDivElement, root: Root;
const choices = ['Error', 'Warning', 'Info', 'Debug', 'Trace'].map((name) => ({
  id: name.toLowerCase(),
  name,
}));
function Fixture() {
  const [visibility, setVisibility] = useState(allLogItems<string>);
  return (
    <dialog open tabIndex={-1}>
      <RoutingLogFilter
        label="Levels"
        choices={choices}
        visibility={visibility}
        onChange={setVisibility}
      />
      <button>Outside</button>
    </dialog>
  );
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<Fixture />));
  host.querySelector('details')!.open = true;
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const click = async (element: HTMLElement) => act(() => element.click());
const checkbox = (name: string) =>
  [...host.querySelectorAll('label')]
    .find((label) => label.textContent === name)!
    .querySelector('input')!;

it('keeps the popover open during label activation through transient ancestor focus', async () => {
  const details = host.querySelector('details')!;
  const dialog = host.querySelector('dialog')!;
  for (const name of ['Trace', 'Debug', 'Info', 'Warning', 'Error']) {
    await act(() => {
      // Native label pointer activation can focus the enclosing modal before
      // focusing its input. Closing details here hides the pending click target.
      const previous =
        document.activeElement === document.body
          ? details.querySelector('summary')!
          : document.activeElement!;
      previous.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: dialog }));
    });
    expect(details.open).toBe(true);
    await click(checkbox(name).closest('label')!);
    expect(checkbox(name).checked).toBe(false);
    expect(details.open).toBe(true);
  }
  await click(checkbox('All').closest('label')!);
  expect(choices.every(({ name }) => checkbox(name).checked)).toBe(true);
  expect(checkbox('All').indeterminate).toBe(false);
});

it('closes on a real focus move outside and on pointer clicks outside, including its ancestor', async () => {
  const details = host.querySelector('details')!;
  const outside = host.querySelector('button')!;
  await act(() => checkbox('Trace').focus());
  await act(() => outside.focus());
  expect(details.open).toBe(false);
  for (const target of [outside, host.querySelector('dialog')!]) {
    details.open = true;
    await act(() => target.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(details.open).toBe(false);
  }
});

it('leaves internal pointer clicks and focus changes open and preserves mixed selection', async () => {
  const details = host.querySelector('details')!;
  await act(() => checkbox('Trace').focus());
  await act(() => checkbox('Debug').focus());
  await act(() =>
    checkbox('Trace')
      .closest('label')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true })),
  );
  await click(checkbox('Trace').closest('label')!);
  expect(details.open).toBe(true);
  expect(checkbox('All').indeterminate).toBe(true);
  expect(checkbox('Debug').checked).toBe(true);
  expect(checkbox('Trace').checked).toBe(false);
});
