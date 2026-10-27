// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ResultPager from './ResultPager';

it('keeps compact icon navigation and page jumps accessible', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'),
    root = createRoot(container),
    change = vi.fn();
  await act(() =>
    root.render(
      <ResultPager compact label="Policy" count={127} size={25} page={1} onPage={change} />,
    ),
  );
  expect(container.querySelector('.result-pager-compact')).not.toBeNull();
  expect(container.textContent).toContain('26–50 of 127');
  const next = container.querySelector<HTMLButtonElement>('[aria-label="Policy: next page"]')!;
  expect(next.textContent).toBe('');
  await act(() => next.click());
  expect(change).toHaveBeenLastCalledWith(2);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Policy: go to page"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '6');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(change).toHaveBeenLastCalledWith(5);
  await act(() => root.unmount());
});
it('navigates directly through 834 pages and refuses out-of-scope jumps or stale queries', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'),
    root = createRoot(container),
    change = vi.fn();
  await act(async () =>
    root.render(<ResultPager label="Stash" count={50000} size={60} page={0} onPage={change} />),
  );
  const last = container.querySelector('[aria-label="Stash: last page"]') as HTMLButtonElement;
  await act(async () => last.click());
  expect(change).toHaveBeenLastCalledWith(833);
  const input = container.querySelector('input')!;
  const set = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await set('834');
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(change).toHaveBeenLastCalledWith(833);
  change.mockClear();
  await set('835');
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <ResultPager label="Stash" count={50000} size={60} page={900} disabled onPage={change} />,
    ),
  );
  expect(container.textContent).toContain('Page 834');
  expect([...container.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  await act(async () => root.unmount());
});
