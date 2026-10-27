// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import RuleTableEditor from './RuleTableEditor';
import DnsEditor from './DnsEditor';
import { createDnsExample } from '../graph/example';
import { readRuleTable } from '../graph/rules';
import { readDnsFilter } from '../graph/dns';
import { updateGraphNode } from '../graph/model';
import {
  initialWorkspaceHistory,
  commitWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
async function choose(label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
for (const kind of ['routing-filter', 'dns-routing-filter'] as const)
  it.each(['Cancel', 'Apply changes'])(
    `${kind} stages a preset without dropping existing wires and honors %s`,
    async (finish) => {
      const graph = createDnsExample(),
        before = structuredClone(graph),
        node = graph.nodes.find((n) => n.data.kind === kind)!,
        apply = vi.fn();
      await act(() =>
        root.render(
          kind === 'routing-filter' ? (
            <RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
          ) : (
            <DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
          ),
        ),
      );
      await act(() => button('Presets').click());
      if (kind === 'routing-filter') {
        await choose('Routing preset', 'ir-local');
        expect(
          host.querySelector<HTMLSelectElement>('[aria-label="Preset output: Proxy"]')!.value,
        ).toBe('preferred');
        await choose('Preset output: Direct', 'default');
        await choose('Preset output: Block', 'blocked');
      } else {
        await choose('Routing preset', 'ir-dns');
        await choose('Preset output: Iran DNS', 'local');
        expect(
          host.querySelector<HTMLSelectElement>('[aria-label="Preset output: Fallback"]')!.disabled,
        ).toBe(true);
      }
      await act(() => button('Import preset').click());
      expect(host.querySelector('[role="alert"]')?.textContent).toBeUndefined();
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(
        /Rules|Preferences/,
      );
      expect(graph).toEqual(before);
      expect(apply).not.toHaveBeenCalled();
      expect(button('Apply changes').disabled).toBe(false);
      await act(() => button(finish).click());
      if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
      else {
        const patch = apply.mock.calls[0][1],
          next = updateGraphNode(graph, node.id, patch);
        expect(next.edges).toEqual(before.edges);
        if (kind === 'routing-filter') {
          expect(readRuleTable(patch.settings).rules).toHaveLength(8);
          expect(apply.mock.calls[0][2]).toBe('IPOnDemand');
        } else {
          const filter = readDnsFilter(patch.settings);
          expect(filter.rules).toHaveLength(1);
          expect(filter.fallbackFirst).toBe(true);
          expect(filter.outputs).toEqual(readDnsFilter(node.data.settings).outputs);
        }
        expect(
          undoWorkspaceHistory(
            commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: next }),
          ).present.graph,
        ).toEqual(before);
      }
    },
  );

it('appending another preset retains the domain strategy staged by a previous replacement', async () => {
  const graph = createDnsExample(),
    node = graph.nodes.find((n) => n.data.kind === 'routing-filter')!,
    apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await act(() => button('Presets').click());
  await act(() => button('Import preset').click());
  await act(() => button('Presets').click());
  await choose('Routing preset', 'cn-local');
  await choose('Preset import mode', 'append');
  await act(() => button('Import preset').click());
  await act(() => button('Apply changes').click());
  expect(apply).toHaveBeenCalledOnce();
  expect(apply.mock.calls[0][2]).toBe('IPOnDemand');
  const table = readRuleTable(apply.mock.calls[0][1].settings);
  expect(table.rules).toHaveLength(16);
  expect(table.defaultOutput).toBe('default');
});
