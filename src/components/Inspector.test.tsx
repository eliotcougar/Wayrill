// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Inspector from './Inspector';
import { updateGraphNode } from '../graph/model';
import { makeNode } from '../graph/catalog';
import { createPolicyExample } from '../graph/policyExample';
import type { GraphState } from '../graph/types';

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
const initial = createPolicyExample();
it.each(['tun-inbound', 'ics-tun'] as const)(
  'edits the adapter from the single %s Name control, including a cleared default',
  async (kind) => {
    const node = makeNode(kind, { x: 0, y: 0 }, 'capture');
    await act(() =>
      root.render(
        <Harness selected={node.id} source={{ name: 'Capture', nodes: [node], edges: [] }} />,
      ),
    );
    const input = host.querySelector<HTMLInputElement>('#node-label')!;
    const originalName = input.value;
    expect(originalName).toBe(kind === 'ics-tun' ? 'Wayrill-ICS' : 'Wayrill-TUN');
    for (const name of ['', 'Office capture']) {
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          name,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input.value).toBe(name);
      if (!name) expect(input.placeholder).toBe(originalName);
    }
  },
);
function Harness({ selected, source = initial }: { selected: string; source?: GraphState }) {
  const [graph, setGraph] = useState<GraphState>(() => {
    const graph = structuredClone(source);
    if (graph.nodes[1]) graph.nodes[1].data.description = 'Existing note';
    return graph;
  });
  return (
    <Inspector
      graph={graph}
      node={graph.nodes.find((n) => n.id === selected)}
      diagnostics={[]}
      selectedCount={1}
      onUpdate={(id, update) => setGraph((g) => updateGraphNode(g, id, update))}
      onSelect={vi.fn()}
      onConnect={vi.fn()}
      onSelectConnection={vi.fn()}
      onEditConnection={vi.fn()}
      onShowConnection={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />
  );
}
it('collapses empty descriptions, retains expansion and focus while clearing, and shows an existing note on another node', async () => {
  await act(() => root.render(<Harness selected={initial.nodes[0].id} />));
  const input = host.querySelector<HTMLTextAreaElement>('#node-description')!;
  const disclosure = input.closest('details')!;
  expect(disclosure.open).toBe(false);
  await act(() => {
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));
  });
  input.focus();
  const enter = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enter('Draft note');
  await enter('');
  expect(input.value).toBe('');
  expect(disclosure.open).toBe(true);
  expect(document.activeElement).toBe(input);
  await act(() => root.render(<Harness selected={initial.nodes[1].id} />));
  const existing = host.querySelector<HTMLTextAreaElement>('#node-description')!;
  expect(existing.value).toBe('Existing note');
  expect(existing.closest('details')!.open).toBe(true);
  await act(() => root.render(<Harness selected={initial.nodes[0].id} />));
  expect(host.querySelector('#node-description')!.closest('details')!.open).toBe(false);
});

it('edits chain structure through its dedicated editor rather than exposing internal serialized fields', async () => {
  const node = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
  await act(() =>
    root.render(<Harness selected="chain" source={{ name: 'Chain', nodes: [node], edges: [] }} />),
  );
  expect(host.textContent).toContain('Edit proxy chain');
  expect(host.textContent).toContain('Outbound tag');
  expect(host.textContent).not.toContain('Chain hops');
  expect(host.textContent).not.toContain('Use observation');
  expect(host.textContent).not.toContain('Saved observation settings');
});

it('toggles an inbound while keeping its settings editable and has no outbound toggle', async () => {
  const node = makeNode('proxy-inbound', { x: 0, y: 0 }, 'proxy');
  await act(() =>
    root.render(<Harness selected="proxy" source={{ name: 'Toggle', nodes: [node], edges: [] }} />),
  );
  const toggle = host.querySelector<HTMLInputElement>('.inbound-enable-control input')!;
  expect(toggle.checked).toBe(true);
  await act(() => toggle.click());
  expect(toggle.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('#node-label')!.value).toBe(node.data.label);
  await act(() => toggle.click());
  expect(toggle.checked).toBe(true);
  const outbound = makeNode('direct-outbound', { x: 0, y: 0 }, 'direct');
  await act(() =>
    root.render(
      <Harness
        key="outbound"
        selected="direct"
        source={{ name: 'Toggle', nodes: [outbound], edges: [] }}
      />,
    ),
  );
  expect(host.querySelector('.inbound-enable-control')).toBeNull();
});

it('offers TCP socket buffers for Proxy and points to global UDP settings', async () => {
  const node = makeNode('proxy-inbound', { x: 0, y: 0 }, 'proxy');
  await act(() =>
    root.render(
      <Harness selected="proxy" source={{ name: 'Buffers', nodes: [node], edges: [] }} />,
    ),
  );
  expect(host.querySelector('#protocol-buffer-udp-receive')).toBeNull();
  expect(host.textContent).toContain('SOCKS UDP uses the listener buffers in Global defaults.');
  const input = host.querySelector<HTMLInputElement>('#protocol-buffer-tcp-receive')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '524288',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain('"network": "tcp"');
  expect(host.textContent).toContain('"value": "524288"');
  expect(input.value).toBe('524288');
});
