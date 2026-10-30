// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import ServiceEvents from './ServiceEvents';
import type { ServiceEvent } from '../serviceClient';

let root: Root, host: HTMLDivElement;
const event = (sequence: number, kind: string, message: string): ServiceEvent => ({
  type: 'event',
  apiVersion: 1,
  instanceId: 'test-service',
  sequence,
  timestampMs: sequence * 1000,
  kind,
  payload: { message },
});
const log = () => host.querySelector<HTMLDivElement>('[aria-label="Service events"]')!;
const checkbox = (name: string) =>
  [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.trim() === name)!
    .querySelector<HTMLInputElement>('input')!;
const render = (events: ServiceEvent[], active = true) =>
  act(() => root.render(<ServiceEvents events={events} active={active} onClear={() => {}} />));

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

it('combines source selection and search while new events keep arriving', async () => {
  let events = [
    event(1, 'core.log', 'Connected to alpha.example'),
    event(2, 'resources.failed', 'Download beta.example failed'),
    event(3, 'subscriptions.changed', 'Refreshed profiles'),
  ];
  await render(events);
  await act(() => host.querySelector('summary')!.click());
  await act(() => checkbox('All').click());
  expect(log().textContent).toContain('No events match');
  events = [...events, event(4, 'config.applied', 'Applied new graph')];
  await render(events);
  expect(log().textContent).not.toContain('Applied new graph');
  await act(() => checkbox('core').click());
  expect(log().textContent).toContain('alpha.example');
  expect(log().textContent).not.toContain('beta.example');

  const search = host.querySelector<HTMLInputElement>('[aria-label="Search events"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'BETA');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(log().textContent).toContain('No events match');
  await act(() => checkbox('resources').click());
  expect(log().textContent).toContain('beta.example');
  events = [...events, event(5, 'core.log', 'Connected to beta.example')];
  await render(events);
  expect(log().textContent).toContain('Connected to beta.example');
  expect(log().textContent).not.toContain('alpha.example');
  await act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Reset event filters"]')!.click(),
  );
  expect(search.value).toBe('');
  for (const entry of events)
    expect(log().textContent).toContain(String((entry.payload as { message: string }).message));
});

it('follows the tail until scrolled up and resumes when the user returns to the bottom', async () => {
  let events = [event(1, 'core.log', 'First connection')];
  await render(events);
  let height = 1000;
  Object.defineProperties(log(), {
    scrollHeight: { get: () => height, configurable: true },
    clientHeight: { value: 200, configurable: true },
  });
  const append = async (active = true) => {
    events = [...events, event(events.length + 1, 'core.log', 'Next connection')];
    await render(events, active);
  };
  await append();
  expect(log().scrollTop).toBe(800);
  await act(() => {
    log().scrollTop = 100;
    log().dispatchEvent(new Event('scroll'));
  });
  height = 1300;
  await append();
  expect(log().scrollTop).toBe(100);
  await act(() => {
    log().scrollTop = 1100;
    log().dispatchEvent(new Event('scroll'));
  });
  height = 1400;
  await append();
  expect(log().scrollTop).toBe(1200);
  height = 1600;
  await append(false);
  expect(log().scrollTop).toBe(1200);
  await render(events, true);
  expect(log().scrollTop).toBe(1400);
});
