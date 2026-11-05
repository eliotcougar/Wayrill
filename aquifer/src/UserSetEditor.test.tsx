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
