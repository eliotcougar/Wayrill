// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import UserSetEditor from './users/UserSetEditor';
import { newUser, newUserSet } from './users/model';

it('returns to the surviving users when deleting the last row of the last page', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initial = {
    ...newUserSet(),
    users: Array.from({ length: 101 }, (_, i) => newUser('vless', i + 1)),
  };
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <UserSetEditor value={value} isNew={false} onChange={setValue} onPendingJson={vi.fn()} />
    );
  }
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    )!;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => button('Next').click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="User display name"]')!.value).toBe(
      'User 101',
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.user-rows button')!.click());
    expect(host.querySelector('.user-rows')?.textContent).toContain('User 101');
    await act(async () => button('Remove user').click());
    expect(host.querySelectorAll('.user-rows button')).toHaveLength(100);
    expect(host.querySelector('.user-rows')?.textContent).toContain('User 1');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('edits only the searched user and protects invalid JSON during navigation', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current = {
    ...newUserSet(),
    users: Array.from({ length: 101 }, (_, i) => newUser('vless', i + 1)),
  };
  function Harness() {
    const [value, setValue] = useState(current);
    return (
      <UserSetEditor
        value={value}
        isNew={false}
        onChange={(next) => {
          current = next;
          setValue(next);
        }}
        onPendingJson={vi.fn()}
      />
    );
  }
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    )!;
  const field = (name: string) =>
    host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`)!;
  const change = async (name: string, value: string) => {
    const control = field(name);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      )!.set!.call(control, value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<Harness />));
    await change('Find users', 'User 101');
    expect(field('User display name').value).toBe('User 101');
    await change('User display name', 'Edited user');
    expect(field('Find users').value).toBe('');
    expect(field('User display name').value).toBe('Edited user');
    expect(current.users[100].name).toBe('Edited user');
    expect(current.users[0].name).toBe('User 1');
    await change('Find users', 'no-such-user');
    expect(host.querySelector('[aria-label="Remove user"]')).toBeNull();
    await change('Find users', '');
    await act(async () => button('Edit account JSON').click());
    await change('Account JSON', '{');
    expect(field('Find users').disabled).toBe(true);
    expect(button('Next').disabled).toBe(true);
    await act(async () => button('Next').click());
    expect(field('Account JSON').value).toBe('{');
    await act(async () => button('Restore last valid JSON').click());
    expect(field('Find users').disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
