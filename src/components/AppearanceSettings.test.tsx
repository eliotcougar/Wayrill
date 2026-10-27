// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import AppearanceSettings from './AppearanceSettings';
import type { ThemePreference } from '../theme';
it('exposes one native radio group and applies choices immediately', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  function Fixture() {
    const [preference, set] = useState<ThemePreference>('system');
    return (
      <AppearanceSettings
        onClose={vi.fn()}
        theme={{
          preference,
          resolved: 'light',
          persistenceError: '',
          windowError: '',
          setPreference: (value) => {
            changed(value);
            set(value);
          },
        }}
      />
    );
  }
  try {
    await act(() => root.render(<Fixture />));
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(inputs.map((input) => input.value)).toEqual(['light', 'dark', 'system']);
    expect(inputs[2].checked).toBe(true);
    await act(() => inputs[1].click());
    expect(changed).toHaveBeenCalledWith('dark');
    expect(inputs[1].checked).toBe(true);
    expect(host.querySelector('fieldset legend')!.textContent).toBe('Theme');
    expect(host.textContent).not.toContain('Changes apply immediately');
    expect(host.textContent).not.toContain('Currently using');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
