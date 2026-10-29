// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../graph/catalog';
import { createVerificationExample } from '../graph/example';
import ConnectionEditor, { type ConnectionRequest } from './ConnectionEditor';
import type { GraphState } from '../graph/types';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector<HTMLElement>('[autofocus]')?.focus();
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const choose = async (id: string) => {
  await act(() =>
    host.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)!.click(),
  );
};
const setup = async (request: ConnectionRequest, graph = createVerificationExample()) => {
  const apply = vi.fn((): string | null => null),
    close = vi.fn(),
    editExisting = vi.fn();
  const render = (next: GraphState) =>
    root.render(
      <ConnectionEditor
        graph={next}
        request={request}
        onApply={apply}
        onEditExisting={editExisting}
        onClose={close}
      />,
    );
  await act(() => render(graph));
  return { graph, apply, close, editExisting, render };
};

it('prefers an unused output for Add while honoring an explicit occupied output', async () => {
  const graph = createVerificationExample();
  graph.edges = graph.edges.filter(
    (edge) => !(edge.source === 'socks' && edge.sourceHandle === 'dns'),
  );
  await setup({ sourceId: 'socks' }, graph);
  expect(host.querySelector<HTMLSelectElement>('#connection-output')!.value).toBe('dns');
  expect(host.textContent).not.toContain('This output is already connected');
  await act(() => root.render(null));
  await setup({ sourceId: 'socks', port: 'data' }, graph);
  expect(host.querySelector<HTMLSelectElement>('#connection-output')!.value).toBe('data');
  expect(host.textContent).toContain('This output is already connected');
});
it('searches destination names and tags while retaining the explicitly selected endpoint in the preview', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  await setup({ edgeId: edge.id }, graph);
  await choose('block');
  await act(() => {
    const input = host.querySelector<HTMLInputElement>('#connection-search')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'DIRECT',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(1);
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')!.value).toBe('direct');
  expect(host.querySelector('[aria-label="Proposed connection"]')!.textContent).toContain(
    'Block / Input',
  );
  expect(button('Apply connection').disabled).toBe(false);
});
it('explains incompatible destinations in text, including observatory settings instead of traffic', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.sourceHandle === 'observation')!;
  await setup({ edgeId: edge.id }, graph);
  expect(host.textContent).toContain('Shared health and latency observation settings');
  expect(host.querySelector('input[type="radio"][value="direct"]')).toBeNull();
  await act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(
    host.querySelector<HTMLInputElement>('input[type="radio"][value="direct"]')!.disabled,
  ).toBe(true);
  expect(host.textContent).toContain('Connect the Observation port to an observatory node.');
});
