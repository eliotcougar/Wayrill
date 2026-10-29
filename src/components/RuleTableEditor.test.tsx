// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RuleTableEditor from './RuleTableEditor';
import { makeNode } from '../graph/catalog';
import { createRoutingExample } from '../graph/example';
import { updateGraphNode } from '../graph/model';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';
import { readRuleTable, tableSettings } from '../graph/rules';
import type { GraphState } from '../graph/types';
import { exportFile } from '../exportFile';
import { attachTrafficSource, editSourcedRule } from '../graph/trafficRuleSource';
import { parseTrafficRules } from '../graph/trafficRuleImport';
vi.mock('../exportFile', () => ({ exportFile: vi.fn(async () => true) }));

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
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )!;
it('offers editable-source or embedded export and fixes Main/Direct/Block compatible mappings', async () => {
  const graph = createRoutingExample();
  graph.mainOutboundId = 'preferred';
  const node = graph.nodes.find((n) => n.id === 'routes')!;
  let table = attachTrafficSource(
    readRuleTable(node.data.settings),
    parseTrafficRules('[{"id":"provider","domain":["domain:source.test"],"outboundTag":"proxy"}]'),
    { 'outbound:proxy': 'preferred' },
    'replace',
    { kind: 'url', location: 'https://example.test/rules', allowHttp: false, viaWayrill: false },
  );
  table = {
    ...table,
    rules: table.rules.map((rule) =>
      editSourcedRule(rule, { conditions: { domain: 'domain:source.test\ndomain:mine.test' } }),
    ),
  };
  Object.assign(node.data.settings, tableSettings(table));
  const apply = vi.fn();
  await act(() =>
    root.render(
      <RuleTableEditor
        node={node}
        graph={graph}
        initialTab="export"
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  const embed = host.querySelector<HTMLInputElement>('.routing-presets input[type="checkbox"]')!;
  expect(embed.checked).toBe(false);
  await act(async () => {
    button('Export file').click();
  });
  expect(JSON.parse(vi.mocked(exportFile).mock.calls.at(-1)![1]).source.location).toBe(
    'https://example.test/rules',
  );
  await act(() => embed.click());
  await act(async () => {
    button('Export file').click();
  });
  const embedded = JSON.parse(vi.mocked(exportFile).mock.calls.at(-1)![1]);
  expect(embedded).not.toHaveProperty('source');
  expect(embedded.rules[0].conditions.domain).toContain('domain:mine.test');
  await act(() => {
    const format = host.querySelector<HTMLSelectElement>('.routing-presets select')!;
    format.value = 'v2rayn';
    format.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const fields = [...host.querySelectorAll<HTMLInputElement>('.preset-output-mapping input')];
  expect(fields.map((field) => field.value).sort()).toEqual(['block', 'direct', 'proxy']);
  expect(fields.every((field) => field.disabled)).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('.routing-presets input[type="checkbox"]')!.checked,
  ).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});
it('exports the current draft in both formats without applying it to the graph', async () => {
  const graph = createRoutingExample(),
    node = graph.nodes.find((n) => n.id === 'routes')!,
    apply = vi.fn();
  const original = structuredClone(node.data);
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const domains = host.querySelector<HTMLTextAreaElement>('[aria-label="Destination domains"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      domains,
      'domain:edited.test',
    );
    domains.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => button('Export').click());
  await act(async () => {
    button('Export file').click();
  });
  const first = vi.mocked(exportFile).mock.calls.at(-1)!;
  expect(first[0]).toMatch(/\.wayrill-rules\.json$/);
  expect(JSON.parse(first[1]).rules[0].conditions.domain).toEqual(['domain:edited.test']);
  await act(() => {
    const format = host.querySelector<HTMLSelectElement>('.routing-presets select')!;
    format.value = 'v2rayn';
    format.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    button('Export file').click();
  });
  const last = vi.mocked(exportFile).mock.calls.at(-1)!;
  expect(last[0]).toMatch(/\.v2rayn\.json$/);
  expect(JSON.parse(last[1])[0].domain).toEqual(['domain:edited.test']);
  expect(apply).not.toHaveBeenCalled();
  expect(node.data).toEqual(original);
});
async function key(target: HTMLElement, value: string) {
  await act(() => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  });
}
it.each(['Cancel', 'Apply changes'])(
  'keeps an edited rule while traversing sections and honors %s',
  async (finish) => {
    const node = makeNode('routing-filter', { x: 0, y: 0 }),
      graph = { name: 'Keyboard draft', nodes: [node], edges: [] } as GraphState;
    const table = readRuleTable(node.data.settings);
    node.data.settings = {
      ...node.data.settings,
      ...tableSettings({
        ...table,
        rules: [
          {
            id: 'qa-rule',
            name: 'Public site',
            enabled: true,
            output: table.defaultOutput,
            matchAll: false,
            conditions: { domain: 'full:public.example' },
          },
        ],
      }),
    };
    const before = structuredClone(node.data),
      apply = vi.fn(),
      close = vi.fn();
    await act(() =>
      root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={close} />),
    );
    const input = [...host.querySelectorAll<HTMLInputElement>('input')].find((i) =>
      i.parentElement!.textContent!.includes('Rule name'),
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'My edited rule',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const first = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await key(first, 'ArrowRight');
    expect(first.getAttribute('aria-selected')).toBe('true');
    await key(document.activeElement as HTMLElement, 'Enter');
    expect(
      host.querySelector('[role="tabpanel"]:not([hidden])')!.getAttribute('aria-labelledby'),
    ).toBe(document.activeElement!.id);
    await key(document.activeElement as HTMLElement, 'ArrowLeft');
    await key(document.activeElement as HTMLElement, ' ');
    expect(
      [...host.querySelectorAll('input')].find((i) =>
        i.parentElement!.textContent!.includes('Rule name'),
      )!.value,
    ).toBe('My edited rule');
    expect(node.data).toEqual(before);
    await act(() => button(finish).click());
    expect(close).toHaveBeenCalledOnce();
    if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
    else
      expect(readRuleTable(apply.mock.calls[0][1].settings).rules[0].name).toBe('My edited rule');
  },
);

async function choose(select: HTMLSelectElement, value: string) {
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it.each(['Cancel', 'Apply changes'])(
  'deletes a connected referenced output, requires reassignment, and honors %s atomically',
  async (finish) => {
    const graph = createRoutingExample(),
      node = graph.nodes.find((n) => n.id === 'routes')!,
      before = structuredClone(graph),
      apply = vi.fn();
    await act(() =>
      root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
    );
    await act(() => button('Outputs (3)').click());
    const output = readRuleTable(node.data.settings).outputs.find((o) => o.id === 'blocked')!;
    const remove = button(`Delete output ${output.name}`);
    expect(remove.disabled).toBe(false);
    await act(() => remove.click());
    expect(host.querySelector('[data-diagnostic-output="blocked"]')).toBeNull();
    expect(button('Apply changes').disabled).toBe(true);
    expect(graph).toEqual(before);
    await act(() => host.querySelector<HTMLButtonElement>('button.diagnostic')!.click());
    const select = host.querySelector<HTMLSelectElement>('[data-diagnostic-field="output"]')!;
    expect(select.value).toBe('');
    expect(document.activeElement).toBe(select);
    await choose(select, 'default');
    expect(button('Apply changes').disabled).toBe(false);
    await act(() => button(finish).click());
    if (finish === 'Cancel') {
      expect(apply).not.toHaveBeenCalled();
      expect(graph).toEqual(before);
    } else {
      expect(apply).toHaveBeenCalledOnce();
      const updated = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
      expect(updated.edges.map((e) => e.id)).not.toContain('routes-block');
      expect(updated.edges).toHaveLength(before.edges.length - 1);
      expect(
        readRuleTable(updated.nodes.find((n) => n.id === node.id)!.data.settings).rules[0].output,
      ).toBe('default');
      expect(
        undoWorkspaceHistory(
          commitWorkspaceHistory(initialWorkspaceHistory(graph), { graph: updated }),
        ).present.graph,
      ).toEqual(before);
    }
  },
);

it('reuses Rule enabled for missing resource matches and preserves the entries on save', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 });
  const table = readRuleTable(node.data.settings);
  table.rules = [
    {
      id: 'missing',
      name: 'Missing group',
      enabled: true,
      output: table.defaultOutput,
      matchAll: false,
      conditions: { domain: 'geosite:gone' },
    },
  ];
  node.data.settings = { ...node.data.settings, ...tableSettings(table) };
  const graph = { name: 'Unavailable resources', nodes: [node], edges: [] } as GraphState;
  const before = structuredClone(node.data);
  const apply = vi.fn();
  await act(() =>
    root.render(
      <RuleTableEditor
        node={node}
        graph={graph}
        onApply={apply}
        onClose={vi.fn()}
        resourceWarnings={{
          skippedSelectors: [{ selector: 'geosite:gone', context: 'Traffic rule 1' }],
        }}
      />,
    ),
  );
  const enabled = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) =>
    i.parentElement?.textContent?.includes('Rule enabled'),
  )!;
  expect(enabled.checked).toBe(false);
  expect(node.data).toEqual(before);
  await act(() => button('Apply changes').click());
  const settings = apply.mock.calls[0][1].settings;
  expect(readRuleTable(settings).rules[0]).toMatchObject({
    enabled: false,
    conditions: { domain: 'geosite:gone' },
  });
});

it('edits ambiguity atomically without changing the default output', async () => {
  const graph = createRoutingExample(),
    node = graph.nodes.find((n) => n.id === 'routes')!,
    apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const section = host.querySelector<HTMLDetailsElement>('.tun-ambiguity-settings')!;
  expect(section.open).toBe(false);
  await act(() => section.querySelector('summary')!.click());
  expect(section.open).toBe(true);
  const action = host.querySelector<HTMLSelectElement>('[aria-label="Ambiguous TUN ownership"]')!;
  expect(action.value).toBe('block');
  expect(host.querySelector('[aria-label="Ambiguous TUN output"]')).toBeNull();
  await act(() => {
    action.value = 'allow';
    action.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const output = host.querySelector<HTMLSelectElement>('[aria-label="Ambiguous TUN output"]')!;
  expect(output.value).toBe('');
  expect([...output.options].map((o) => o.text)).toContain('Unmatched traffic');
  await act(() => {
    output.value = 'preferred';
    output.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(apply).not.toHaveBeenCalled();
  await act(() => button('Apply changes').click());
  expect(readRuleTable(apply.mock.calls[0][1].settings).tunAmbiguity).toEqual({
    action: 'allow',
    output: 'preferred',
  });
});
