// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FakeDnsEditor from './FakeDnsEditor';
import { createFakeDnsExample } from '../graph/fakeDnsExample';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
it('shows the audited family pools and discards cancelled custom edits', async () => {
  const graph = createFakeDnsExample(),
    node = graph.nodes.find((n) => n.data.kind === 'fakedns')!,
    original = structuredClone(graph),
    apply = vi.fn(),
    close = vi.fn();
  await act(() =>
    root.render(<FakeDnsEditor graph={graph} node={node} onApply={apply} onClose={close} />),
  );
  expect(host.textContent).toContain('198.18.0.0/15');
  expect(host.textContent).toMatch(/65[,\s\u00a0]535 mappings/);
  await act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(() => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(graph).toEqual(original);
});
it('prevents applying missing required custom fields and preserves native automatic omission', async () => {
  const graph = createFakeDnsExample(),
    node = graph.nodes.find((n) => n.data.kind === 'fakedns')!,
    apply = vi.fn();
  node.data.settings.pools = '{"ipPool":"198.18.0.0/24"}';
  await act(() =>
    root.render(<FakeDnsEditor graph={graph} node={node} onApply={apply} onClose={vi.fn()} />),
  );
  expect(button('Apply FakeDNS settings').disabled).toBe(true);
  await act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button('Apply FakeDNS settings').disabled).toBe(false);
  await act(() => button('Apply FakeDNS settings').click());
  expect(apply.mock.calls[0][1].settings.pools).toBe('');
});
