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
const select = async (id: string, value: string) => {
  await act(() => {
    const field = host.querySelector<HTMLSelectElement>(`#${id}`)!;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
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

it('treats the edited edge as available when switching back to its source', async () => {
  const graph = createVerificationExample();
  const edge = graph.edges.find((item) => item.source === 'socks' && item.sourceHandle === 'data')!;
  await setup({ edgeId: edge.id }, graph);
  await select('connection-source', 'routes');
  await select('connection-source', 'socks');
  expect(host.querySelector<HTMLSelectElement>('#connection-output')!.value).toBe('data');
  expect(graph.edges.find((item) => item.id === edge.id)?.target).toBe('routes');
});
it('opens a local endpoint draft; Apply forwards exact port IDs and preserves the existing edge ID', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  const { apply, close } = await setup({ edgeId: edge.id }, graph);
  expect(document.activeElement?.id).toBe('connection-source');
  expect(button('Apply connection').disabled).toBe(true);
  await choose('block');
  expect(apply).not.toHaveBeenCalled();
  expect(graph.edges.find((e) => e.id === edge.id)?.target).toBe('routes');
  await act(() => button('Apply connection').click());
  expect(apply).toHaveBeenCalledWith(
    { source: 'socks', sourceHandle: 'data', target: 'block', targetHandle: 'in' },
    edge.id,
  );
  expect(close).toHaveBeenCalledOnce();
});
it('Cancel and Escape discard the local draft without an edit command', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges[0];
  const { apply, close } = await setup({ edgeId: edge.id }, graph);
  await choose('block');
  await act(() => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  await act(() =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(2);
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
it('requires explicit editing of an occupied output, and source/port changes do not silently choose a destination', async () => {
  const { graph, apply, editExisting } = await setup({ sourceId: 'socks', port: 'data' });
  expect(button('Add connection').disabled).toBe(true);
  await act(() => button('Edit existing connection…').click());
  expect(editExisting).toHaveBeenCalledWith(
    graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!.id,
  );
  await select('connection-source', 'dns');
  expect(host.textContent).toContain('Resolver selection');
  expect(apply).not.toHaveBeenCalled();
  expect(button('Add connection').disabled).toBe(true);
});
it('blocks Apply when a selected destination or output disappears while the dialog is open', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  const { render, apply } = await setup({ edgeId: edge.id }, graph);
  await choose('block');
  await act(() => render({ ...graph, nodes: graph.nodes.filter((n) => n.id !== 'block') }));
  expect(button('Apply connection').disabled).toBe(true);
  expect(host.textContent).toContain('missing node');
  await act(() => button('Apply connection').click());
  expect(apply).not.toHaveBeenCalled();
});
it('leaves the editor open with the previous graph intact if the commit rejects a stale draft', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  const { apply, close } = await setup({ edgeId: edge.id }, graph);
  apply.mockReturnValue('This output port already has a path.');
  await choose('block');
  await act(() => button('Apply connection').click());
  expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('already has a path');
});

it('returns keyboard focus to the opener when the editor unmounts', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  try {
    await setup({ sourceId: 'socks', port: 'data' });
    expect(document.activeElement?.id).toBe('connection-source');
    await act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  } finally {
    opener.remove();
  }
});

it('wraps Tab and Shift+Tab at the dialog boundaries with enabled or disabled Apply', async () => {
  const graph = createVerificationExample(),
    edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  await setup({ edgeId: edge.id }, graph);
  const first = host.querySelector<HTMLButtonElement>('[aria-label="Cancel connection editing"]')!;
  const tab = async (from: HTMLButtonElement, shiftKey = false) => {
    from.focus();
    await act(() =>
      from.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  };
  await tab(button('Cancel'));
  expect(document.activeElement).toBe(first);
  await tab(first, true);
  expect(document.activeElement).toBe(button('Cancel'));
  await choose('block');
  await tab(button('Apply connection'));
  expect(document.activeElement).toBe(first);
  await tab(first, true);
  expect(document.activeElement).toBe(button('Apply connection'));
});

it('finds a decorated Unicode destination with plain typed text and retains its original name', async () => {
  const graph = createVerificationExample();
  const target = graph.nodes.find((n) => n.id === 'direct')!;
  target.data.label = '𝗝𝗼𝗶𝗻➠@PlanB_net';
  const edge = graph.edges.find((e) => e.source === 'socks' && e.sourceHandle === 'data')!;
  const { apply } = await setup({ edgeId: edge.id }, graph);
  await act(() => {
    const search = host.querySelector<HTMLInputElement>('#connection-search')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'Join➠',
    );
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const options = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(options).toHaveLength(1);
  expect(options[0].value).toBe(target.id);
  expect(host.querySelector('strong[dir="auto"]')!.getAttribute('title')).toBe(target.data.label);
  await choose(target.id);
  expect(host.querySelector('[aria-label="Proposed connection"]')!.textContent).toContain(
    target.data.label,
  );
  expect(target.data.label).toBe('𝗝𝗼𝗶𝗻➠@PlanB_net');
  expect(apply).not.toHaveBeenCalled();
});
