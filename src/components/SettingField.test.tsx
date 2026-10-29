// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingField } from './SettingField';

let root: Root, container: HTMLDivElement;
function Field() {
  const [value, setValue] = useState(30),
    [valid, setValid] = useState(true);
  return (
    <>
      <SettingField
        field={{ key: 'number', label: 'Interval', type: 'number', min: 0, max: 120 }}
        value={value}
        issues={[]}
        onChange={(v) => setValue(Number(v))}
        onValidity={(_, v) => setValid(v)}
      />
      <button disabled={!valid || value === 30}>Save {value}</button>
    </>
  );
}
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function enter(value: string) {
  const input = container.querySelector('input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('numeric setting UX', () => {
  it('shows an invalid number and prevents Save instead of silently clamping it', async () => {
    await act(() => root.render(<Field />));
    await enter('999');
    expect(container.querySelector('input')!.value).toBe('999');
    expect(container.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(container.textContent).toContain('not been applied');
    await enter('0');
    expect(container.querySelector('button')!.textContent).toBe('Save 0');
  });
});
