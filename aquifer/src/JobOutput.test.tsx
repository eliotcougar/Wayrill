// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import JobOutput from './JobOutput';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(logs: string[]) {
  await act(async () => root.render(<JobOutput logs={logs} />));
  return host.querySelector('pre')!;
}

it('follows the rolling log, pauses for reading, and catches up when reopened', async () => {
  const output = await render(['First', 'Second']);
  const details = host.querySelector('details')!;
  let height = 800;
  Object.defineProperties(output, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
  });
  const toggle = (open: boolean) =>
    act(async () => {
      details.open = open;
      details.dispatchEvent(new Event('toggle'));
    });
  const scroll = (top: number) =>
    act(async () => {
      output.scrollTop = top;
      output.dispatchEvent(new Event('scroll'));
    });
  await toggle(true);
  await scroll(100);
  await render(['Second', 'Third']);
  expect(output.scrollTop).toBe(100);
  await scroll(600);
  height = 1000;
  await render(['Third', 'Fourth']);
  expect(output.scrollTop).toBeGreaterThanOrEqual(800);
  await scroll(100);
  await toggle(false);
  await render(['Fourth', 'Fifth']);
  await toggle(true);
  expect(output.textContent).toBe('Fourth\nFifth');
  expect(output.scrollTop).toBeGreaterThanOrEqual(800);
});
