// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import RuntimeProgressOverlay from './RuntimeProgressOverlay';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
it('makes all three panels inert, announces phases and keeps their elements mounted', async () => {
  const render = (progress: { title: string; stage: string; percent: number | null } | null) =>
    root.render(
      <RuntimeProgressOverlay progress={progress}>
        <button>Library</button>
        <input aria-label="Node field" defaultValue="Draft" />
        <button>Properties</button>
      </RuntimeProgressOverlay>,
    );
  await act(() => render(null));
  const field = host.querySelector('input')!;
  field.focus();
  await act(() => render({ title: 'Starting networking', stage: 'Waiting for Xray', percent: 60 }));
  expect(host.querySelector('.workspace-body')?.hasAttribute('inert')).toBe(true);
  expect(host.querySelector('input')).toBe(field);
  expect(document.activeElement).toBe(host.querySelector('[role="status"]'));
  expect(host.querySelector('progress')?.value).toBe(60);
  expect(host.querySelector('[role="status"]')?.closest('[aria-busy="true"]')).toBeNull();
  await act(() =>
    render({
      title: 'Starting networking',
      stage: 'Configuring TUN and Internet sharing',
      percent: 70,
    }),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Configuring TUN');
  await act(() => render(null));
  expect(host.querySelector('.workspace-body')?.hasAttribute('inert')).toBe(false);
  expect(field.value).toBe('Draft');
  expect(document.activeElement).toBe(field);
});
it('uses an indeterminate bar during rollback without a fake percentage', async () => {
  await act(() =>
    root.render(
      <RuntimeProgressOverlay
        progress={{
          title: 'Restoring previous configuration',
          stage: 'Waiting for Xray',
          percent: null,
        }}
      >
        <button>Library</button>
      </RuntimeProgressOverlay>,
    ),
  );
  expect(host.querySelector('progress')?.hasAttribute('value')).toBe(false);
});
