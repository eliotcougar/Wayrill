// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import DnsEditor from './DnsEditor';
import { makeNode } from '../graph/catalog';
import { createDnsExample } from '../graph/example';
import { createFakeDnsExample } from '../graph/fakeDnsExample';
import { readDnsFilter, dnsFilterSettings } from '../graph/dns';
import { exportDnsRules } from '../graph/dnsRuleSource';
import { updateGraphNode } from '../graph/model';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';
import type { GraphState } from '../graph/types';
const download = vi.hoisted(() => vi.fn());
vi.mock('../routingDownload', () => ({ downloadRoutingRules: download }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  download.mockReset();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

it('loads and refreshes a DNS source through the editor without losing user entries or changing connections', async () => {
  let graph = createDnsExample();
  let node = graph.nodes.find((n) => n.id === 'dns-routes')!;
  const provider = readDnsFilter(node.data.settings),
    beforeEdges = structuredClone(graph.edges);
  download.mockResolvedValue(exportDnsRules(provider, 'Provider'));
  const apply = vi.fn();
  const render = async () => {
    await act(() =>
      root.render(
        <DnsEditor
          key={node.id + ':' + apply.mock.calls.length}
          node={node}
          graph={graph}
          onApply={apply}
          onClose={vi.fn()}
        />,
      ),
    );
  };
  await render();
  await act(() => button('Import').click());
  const url = host.querySelector<HTMLInputElement>('[aria-label="Routing URL"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      url,
      'https://example.test/dns.json',
    );
    url.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    button('Load URL').click();
  });
  await act(() => button('Import rules').click());
  const domains = host.querySelector<HTMLTextAreaElement>('[aria-label="Preferred domains"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      domains,
      domains.value + '\nfull:mine.test',
    );
    domains.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => button('Apply changes').click());
  graph = updateGraphNode(graph, node.id, apply.mock.calls.at(-1)![1]);
  node = graph.nodes.find((n) => n.id === node.id)!;
  expect(readDnsFilter(node.data.settings).source?.location).toBe('https://example.test/dns.json');
  provider.rules[0].domains = 'full:provider-updated.test';
  download.mockResolvedValue(exportDnsRules(provider, 'Provider'));
  await render();
  await act(() => button('Import').click());
  await act(async () => {
    button('Update from source').click();
  });
  await act(() => button('Update rules').click());
  await act(() => button('Apply changes').click());
  const updated = readDnsFilter(apply.mock.calls.at(-1)![1].settings);
  expect(updated.rules[0].domains).toBe('full:provider-updated.test\nfull:mine.test');
  expect(updated.outputs).toEqual(readDnsFilter(node.data.settings).outputs);
  expect(graph.edges).toEqual(beforeEdges);
  graph = updateGraphNode(graph, node.id, apply.mock.calls.at(-1)![1]);
  node = graph.nodes.find((n) => n.id === node.id)!;
  const accepted = structuredClone(node.data.settings);
  download.mockRejectedValue(new Error('Source unavailable'));
  await render();
  await act(() => button('Import').click());
  await act(async () => {
    button('Update from source').click();
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Source unavailable');
  await act(() => button(`Preferences (${updated.rules.length})`).click());
  await act(() => button('Apply changes').click());
  expect(apply.mock.calls.at(-1)![1].settings).toEqual(accepted);
});

it('does not save temporary DNS geodata skips as disabled preferences', async () => {
  const graph = createDnsExample(),
    node = graph.nodes.find((n) => n.id === 'dns-routes')!;
  const filter = readDnsFilter(node.data.settings);
  filter.rules[0].domains = 'geosite:gone';
  Object.assign(node.data.settings, dnsFilterSettings(filter));
  const apply = vi.fn(),
    before = structuredClone(node.data.settings);
  await act(() =>
    root.render(
      <DnsEditor
        node={node}
        graph={graph}
        resourceWarnings={{ skippedSelectors: [{ selector: 'geosite:gone', context: 'DNS' }] }}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  const enabled = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => input.parentElement?.textContent?.includes('Preference enabled'),
  )!;
  expect(enabled.checked).toBe(true);
  await act(() => button('Apply changes').click());
  expect(apply.mock.calls[0][1].settings).toEqual(before);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )!;
async function choose(select: HTMLSelectElement, value: string) {
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
it('shows the managed FakeDNS output and keeps a real fallback without serializing generated rules', async () => {
  const graph = createFakeDnsExample(),
    node = graph.nodes.find((n) => n.id === 'fake-routing')!,
    apply = vi.fn();
  node.data.settings.fallbackMode = 'disabled';
  node.data.settings.parallel = true;
  const before = structuredClone(graph);
  await act(() =>
    root.render(<DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  expect(host.textContent).toContain('Required by FakeDNS');
  const fallback = host.querySelector<HTMLSelectElement>('[aria-label="Fallback policy"]')!;
  expect(fallback.disabled).toBe(true);
  expect(fallback.value).toBe('always');
  expect(host.querySelector('[aria-label="Fallback servers first in core config"]')).toBeNull();
  const parallel = host.querySelector<HTMLInputElement>(
    '[data-diagnostic-field="parallel"] input',
  )!;
  expect(parallel.disabled).toBe(true);
  expect(parallel.checked).toBe(false);
  await act(() => button('Outputs').click());
  expect(host.querySelector('[aria-label="FakeDNS output"]')?.textContent).toContain('FakeDNS');
  expect(host.textContent).toContain('Name recovery is automatic');
  expect(host.querySelector('[aria-label="Delete output FakeDNS"]')).toBeNull();
  await act(() => button('Apply changes').click());
  expect(apply).toHaveBeenCalled();
  expect(JSON.parse(apply.mock.calls[0][1].settings.rules)).toEqual([]);
  expect(apply.mock.calls[0][1].settings.parallel).toBe(true);
  expect(graph).toEqual(before);
});

it.each(['Cancel', 'Apply changes'])(
  'deletes a connected preference output, requires reassignment and honors %s atomically',
  async (finish) => {
    const graph = createDnsExample(),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!,
      before = structuredClone(graph),
      apply = vi.fn();
    await act(() =>
      root.render(<DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
    );
    await act(() => button('Outputs').click());
    expect(button('Delete output Local names').disabled).toBe(false);
    await act(() => button('Delete output Local names').click());
    expect(button('Apply changes').disabled).toBe(true);
    expect(graph).toEqual(before);
    await act(() => host.querySelector<HTMLButtonElement>('button.diagnostic')!.click());
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Preferred output"]')!;
    expect(select.value).toBe('');
    expect(document.activeElement).toBe(select);
    await choose(select, 'remote');
    expect(button('Apply changes').disabled).toBe(false);
    await act(() => button(finish).click());
    if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
    else {
      const edited = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
      expect(edited.edges.some((e) => e.source === node.id && e.sourceHandle === 'local')).toBe(
        false,
      );
      expect(edited.edges.some((e) => e.source === node.id && e.sourceHandle === 'remote')).toBe(
        true,
      );
      expect(
        readDnsFilter(edited.nodes.find((n) => n.id === node.id)!.data.settings).rules[0].output,
      ).toBe('remote');
      expect(
        undoWorkspaceHistory(
          commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: edited }),
        ).present.graph,
      ).toEqual(before);
    }
    expect(graph).toEqual(before);
  },
);

it.each(['Cancel', 'Apply changes'])(
  'keeps fallback behavior below preferences, leaves Outputs for ports, and honors %s',
  async (finish) => {
    const graph = createDnsExample(),
      before = structuredClone(graph),
      node = graph.nodes.find((n) => n.id === 'dns-routes')!,
      apply = vi.fn(),
      filter = readDnsFilter(node.data.settings),
      fallback = filter.outputs.find((output) => output.fallback)!,
      target = graph.nodes.find(
        (n) =>
          n.id ===
          graph.edges.find((e) => e.source === node.id && e.sourceHandle === fallback.id)?.target,
      )!;
    await act(() =>
      root.render(<DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
    );
    const footer = host.querySelector<HTMLDetailsElement>('[aria-label="DNS fallback"]')!;
    expect(footer.open).toBe(false);
    await act(() => footer.querySelector('summary')!.click());
    expect(footer.open).toBe(true);
    const advanced = footer.querySelector<HTMLDetailsElement>('.settings-advanced')!;
    expect(advanced.open).toBe(false);
    await act(() => advanced.querySelector('summary')!.click());
    expect(advanced.open).toBe(true);
    expect(footer.previousElementSibling?.getAttribute('aria-label')).toBe(
      'Ordered DNS preferences',
    );
    expect(footer.querySelector('[aria-label="Fallback output"]')?.textContent).toContain(
      target.data.label,
    );
    await choose(footer.querySelector('[aria-label="Fallback policy"]')!, 'when-unmatched');
    expect(footer.querySelector('summary')!.textContent).toContain('Unmatched only');
    for (const field of ['fallbackFirst', 'parallel']) {
      const checkbox = footer.querySelector<HTMLInputElement>(
        `[data-diagnostic-field="${field}"] input`,
      )!;
      if (!checkbox.checked) await act(() => checkbox.click());
    }
    await act(() => button('Outputs').click());
    expect(
      host.querySelector('[role="tabpanel"]:not([hidden]) [aria-label="Fallback policy"]'),
    ).toBeNull();
    expect(
      host.querySelector('[role="tabpanel"]:not([hidden]) [data-diagnostic-field="parallel"]'),
    ).toBeNull();
    expect(
      host.querySelector('[role="tabpanel"]:not([hidden]) [data-diagnostic-field="fallbackFirst"]'),
    ).toBeNull();
    expect(host.querySelector('[aria-label="Delete output Fallback"]')).toBeNull();
    await act(() => button(`Preferences (${filter.rules.length})`).click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Fallback policy"]')!.value).toBe(
      'when-unmatched',
    );
    await act(() => button(finish).click());
    if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
    else {
      const edited = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
      const current = readDnsFilter(edited.nodes.find((n) => n.id === node.id)!.data.settings);
      expect(current).toEqual({
        ...filter,
        fallbackMode: 'when-unmatched',
        fallbackFirst: true,
        parallel: true,
      });
      expect(edited.edges).toEqual(before.edges);
      expect(
        undoWorkspaceHistory(
          commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: edited }),
        ).present.graph,
      ).toEqual(before);
    }
    expect(graph).toEqual(before);
  },
);

it('does not convert an invalid UDP resolver draft to TCP', async () => {
  const node = makeNode('dns-servers', { x: 0, y: 0 });

  const graph = { name: 'Invalid resolver', nodes: [node], edges: [] } as GraphState;
  const apply = vi.fn();
  await act(() =>
    root.render(<DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const port = host.querySelector<HTMLInputElement>('[aria-label="UDP port"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(port, '70000');
    port.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Use TCP DNS').disabled).toBe(true);
  expect(button('Apply changes').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});
