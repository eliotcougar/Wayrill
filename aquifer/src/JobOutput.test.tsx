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

it('follows new output and an advancing circular buffer even when its line count is unchanged', async () => {
  const output = await render(['First', 'Second']);
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 800 });
  await render(['Second', 'Third']);
  expect(output.scrollTop).toBe(800);
  expect(output.textContent).toBe('Second\nThird');
});

it('leaves the scroll position alone while reading earlier lines and resumes at the bottom', async () => {
  const output = await render(['First']);
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 800 });
  Object.defineProperty(output, 'clientHeight', { configurable: true, value: 200 });
  await act(async () => {
    output.scrollTop = 100;
    output.dispatchEvent(new Event('scroll'));
  });
  await render(['First', 'Second']);
  expect(output.scrollTop).toBe(100);
  await act(async () => {
    output.scrollTop = 600;
    output.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 1000 });
  await render(['First', 'Second', 'Third']);
  expect(output.scrollTop).toBe(1000);
});

it('opens output at the latest line after collecting updates while collapsed', async () => {
  const output = await render(['First']);
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 800 });
  const details = host.querySelector('details')!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(output.scrollTop).toBe(800);
});
