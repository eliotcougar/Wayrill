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
const validity = (_: string, valid: boolean) => valid;
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
  it.each(['text', 'number', 'password', 'textarea', 'select', 'boolean'] as const)(
    'associates %s errors and help with the actual control',
    async (type) => {
      await act(() =>
        root.render(
          <SettingField
            field={{
              key: 'qa',
              label: 'QA field',
              type,
              help: 'Public help',
              options: ['a'],
              min: 1,
            }}
            value={type === 'number' ? 2 : type === 'boolean' ? true : 'a'}
            issues={[{ severity: 'error', message: 'Review this value' }]}
            onChange={() => {}}
          />,
        ),
      );
      const control = container.querySelector<HTMLInputElement>('#setting-qa')!;
      expect(control.getAttribute('aria-invalid')).toBe('true');
      const descriptions = control
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => document.getElementById(id)!.textContent);
      expect(descriptions.join(' ')).toContain('Public help');
      expect(descriptions.join(' ')).toContain('Review this value');
    },
  );
  it('distinguishes inherited, unset and explicit dropdown values', async () => {
    await act(() =>
      root.render(
        <SettingField
          field={{
            key: 'fingerprint',
            label: 'Fingerprint',
            type: 'select',
            options: ['', 'chrome'],
          }}
          value="chrome"
          inherited
          hint={{ source: 'global', text: 'chrome' }}
          issues={[]}
          onChange={() => {}}
          onInherit={() => {}}
        />,
      ),
    );
    expect([...container.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Default: chrome',
      'Xray default',
      'chrome',
    ]);
  });
  it('enables Save immediately after a valid edit without waiting for blur', async () => {
    await act(() => root.render(<Field />));
    await enter('45');
    expect(container.querySelector('button')!.disabled).toBe(false);
    expect(container.querySelector('button')!.textContent).toBe('Save 45');
    expect(container.querySelector('input')!.value).toBe('45');
  });
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
  it('preserves an unprefixed diagnostic message in full', async () => {
    await act(() =>
      root.render(
        <SettingField
          field={{ key: 'text', label: 'Text', type: 'text' }}
          value=""
          issues={[{ severity: 'error', message: 'Required field' }]}
          onChange={() => {}}
          onValidity={validity}
        />,
      ),
    );
    expect(container.textContent).toContain('Required field');
  });
});

it.each([
  {
    message: 'Invalid pattern: missing closing bracket',
    prefix: undefined,
    expected: 'Invalid pattern: missing closing bracket',
  },
  {
    message: 'Global defaults: Invalid pattern: missing closing bracket',
    prefix: 'Global defaults: ',
    expected: 'Invalid pattern: missing closing bracket',
  },
  {
    message: 'QA: Europe: Invalid pattern: missing closing bracket',
    prefix: 'QA: Europe: ',
    expected: 'Invalid pattern: missing closing bracket',
  },
])(
  'preserves meaningful diagnostic context and strips only the supplied prefix: $message',
  async ({ message, prefix, expected }) => {
    await act(() =>
      root.render(
        <SettingField
          field={{ key: 'qa', label: 'Pattern', type: 'text' }}
          value="["
          issues={[{ severity: 'error', message }]}
          messagePrefix={prefix}
          onChange={() => {}}
        />,
      ),
    );
    expect(container.querySelector('.field-message span')!.textContent).toBe(expected);
  },
);
