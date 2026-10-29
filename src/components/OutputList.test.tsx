// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RuleTableEditor from './RuleTableEditor';
import DnsEditor from './DnsEditor';
import { moveEntry } from './OrderedEntries';
import { createDnsExample } from '../graph/example';
import { getOutputPorts } from '../graph/catalog';
import { readDnsFilter } from '../graph/dns';
import { readRuleTable } from '../graph/rules';
import { updateGraphNode } from '../graph/model';
import { compileRuntimeGraph } from '../graph/runtime';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLElement.prototype.setPointerCapture = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )!;
const order = () =>
  [...host.querySelectorAll<HTMLElement>('[data-diagnostic-output]')].map(
    (row) => row.dataset.diagnosticOutput,
  );
function geometry() {
  const list = host.querySelector<HTMLElement>('.output-editor-list')!;
  const rows = [...list.querySelectorAll<HTMLElement>('.output-editor-row')];
  list.getBoundingClientRect = () =>
    ({ left: 20, right: 600, top: 100, bottom: 100 + rows.length * 52 }) as DOMRect;
  const scroller = list.closest<HTMLElement>('.output-editor');
  if (scroller)
    scroller.getBoundingClientRect = () =>
      ({ left: 0, right: 620, top: 80, bottom: 400 }) as DOMRect;
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({ left: 20, right: 600, top: 100 + index * 52, bottom: 142 + index * 52 }) as DOMRect;
  });
  return rows;
}
async function pointer(handle: HTMLElement, type: string, x: number, y: number) {
  await act(() => {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    handle.dispatchEvent(event);
  });
}

for (const kind of ['routing-filter', 'dns-routing-filter'] as const) {
  it.each(['Cancel', 'Apply changes'])(
    `${kind} drag reorders connected ports without changing configuration and honors %s`,
    async (finish) => {
      const graph = createDnsExample(),
        before = structuredClone(graph),
        node = graph.nodes.find((n) => n.data.kind === kind)!,
        apply = vi.fn(),
        initial = getOutputPorts(kind, node.data).filter((p) => p !== 'fakedns'),
        expected = moveEntry(initial, initial.length - 1, 0),
        configuration = compileRuntimeGraph(graph).config;
      await act(() =>
        root.render(
          kind === 'routing-filter' ? (
            <RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
          ) : (
            <DnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
          ),
        ),
      );
      await act(() =>
        button(kind === 'dns-routing-filter' ? 'Outputs' : `Outputs (${initial.length})`).click(),
      );
      const rows = geometry(),
        handle = rows.at(-1)!.querySelector<HTMLElement>('.output-drag-handle')!;
      await pointer(handle, 'pointerdown', 32, 121 + (rows.length - 1) * 52);
      await pointer(handle, 'pointermove', 32, 121);
      expect(order()).toEqual(initial);
      expect(graph).toEqual(before);
      await pointer(handle, 'pointerup', 32, 121);
      expect(order()).toEqual(expected);
      expect(document.activeElement).toBe(handle);
      expect(button('Apply changes').disabled).toBe(false);
      if (kind === 'dns-routing-filter') {
        expect(
          host.querySelector('[role="tabpanel"]:not([hidden]) [aria-label="Fallback policy"]'),
        ).toBeNull();
        expect(host.querySelector('[aria-label="Delete output Fallback"]')).toBeNull();
      }
      await act(() => button(finish).click());
      if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
      else {
        const edited = updateGraphNode(graph, node.id, apply.mock.calls[0][1]),
          data = edited.nodes.find((n) => n.id === node.id)!.data;
        expect(getOutputPorts(kind, data)).toEqual(
          kind === 'dns-routing-filter' ? [...expected, 'fakedns'] : expected,
        );
        expect(edited.edges).toEqual(before.edges);
        expect(compileRuntimeGraph(edited).config).toEqual(configuration);
        if (kind === 'routing-filter') {
          const old = readRuleTable(node.data.settings),
            current = readRuleTable(data.settings);
          expect(current.rules).toEqual(old.rules);
          expect(current.defaultOutput).toBe(old.defaultOutput);
        } else {
          const old = readDnsFilter(node.data.settings),
            current = readDnsFilter(data.settings);
          expect(current.rules).toEqual(old.rules);
          expect(current.fallbackMode).toBe(old.fallbackMode);
        }
        expect(
          undoWorkspaceHistory(
            commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: edited }),
          ).present.graph,
        ).toEqual(before);
      }
      expect(graph).toEqual(before);
    },
  );
}
