// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RuleTableEditor from './RuleTableEditor';
import { DiagnosticFocusContext, focusDiagnostic } from './DiagnosticNavigation';
import { makeNode } from '../graph/catalog';
import { createRoutingExample } from '../graph/example';
import { updateGraphNode } from '../graph/model';
import {
  commitWorkspaceHistory,
  initialWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';
import { readRuleTable, ruleTablePlan, tableSettings } from '../graph/rules';
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
it('opens directly on the traffic log without changing the rule draft', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 });
  const graph = { name: 'Log shortcut', nodes: [node], edges: [] } as GraphState;
  const apply = vi.fn();
  await act(() =>
    root.render(
      <RuleTableEditor
        node={node}
        graph={graph}
        initialTab="log"
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(button('Traffic log').getAttribute('aria-selected')).toBe('true');
  expect(host.querySelector('[aria-label="Search destinations"]')).not.toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
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

it('reviews a second-row advanced condition directly and leaves the graph unchanged on cancel', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    graph = { name: 'Public QA', nodes: [node], edges: [] } as GraphState,
    table = readRuleTable(node.data.settings);
  table.rules = [
    {
      id: 'first',
      name: 'First',
      enabled: true,
      matchAll: false,
      output: table.defaultOutput,
      conditions: { domain: 'full:public.example' },
    },
    {
      id: 'second',
      name: 'Second',
      enabled: true,
      matchAll: false,
      output: table.defaultOutput,
      conditions: { sourcePort: 'bad' },
    },
  ];
  Object.assign(node.data.settings, tableSettings(table));
  const before = structuredClone(graph),
    apply = vi.fn();
  await act(() =>
    root.render(
      <DiagnosticFocusContext.Provider
        value={{
          surface: 'editor',
          issue: {
            severity: 'error',
            message: 'Localized',
            nodeId: node.id,
            rowId: 'second',
            fieldKey: 'sourcePort',
          },
        }}
      >
        <RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />
      </DiagnosticFocusContext.Provider>,
    ),
  );
  const input = host.querySelector<HTMLInputElement>(
    '[data-diagnostic-row="second"] [data-diagnostic-field="sourcePort"] input',
  )!;
  expect(document.activeElement).toBe(input);
  expect(input.closest('details')!.open).toBe(true);
  await act(() => button('Plan preview').click());
  await act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('button.diagnostic')]
      .find((b) => b.textContent!.includes('sourcePort'))!
      .click(),
  );
  expect(document.activeElement).toBe(input);
  expect(button('Apply changes').disabled).toBe(true);
  await act(() => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(graph).toEqual(before);
});

it.each(['Cancel', 'Apply changes'])(
  'keeps compact rule rows, reorders from the left toolbar atomically, and honors %s',
  async (finish) => {
    const node = makeNode('routing-filter', { x: 0, y: 0 }),
      destination = makeNode('block-outbound', { x: 0, y: 0 });
    destination.data.label = 'Public block';
    const table = readRuleTable(node.data.settings);
    table.rules = [
      {
        id: 'all',
        name: 'Broad rule',
        enabled: true,
        matchAll: true,
        output: table.defaultOutput,
        conditions: {},
      },
      {
        id: 'specific',
        name: 'Public site',
        enabled: true,
        matchAll: false,
        output: table.defaultOutput,
        conditions: { domain: 'full:public.example', port: '443' },
      },
    ];
    Object.assign(node.data.settings, tableSettings(table));
    const graph = {
      name: 'Precedence QA',
      nodes: [node, destination],
      edges: [
        {
          id: 'wire',
          source: node.id,
          sourceHandle: table.defaultOutput,
          target: destination.id,
          targetHandle: 'in',
        },
      ],
    } as GraphState;
    const before = structuredClone(graph),
      apply = vi.fn();
    await act(() =>
      root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.rule-list button')];
    expect(rows[1].title).toContain(
      'Destination domains: full:public.example AND Destination ports: 443',
    );
    expect(rows[1].querySelector('.rule-drag-handle')).not.toBeNull();
    expect(host.querySelector('.entry-position')).toBeNull();
    expect(rows[1].textContent).toContain('Public block');
    expect(rows[1].title).toContain('Unreachable after match-all rule 1');
    await act(() => rows[1].click());
    expect(
      host
        .querySelector<HTMLButtonElement>('[aria-label="Move rule up"]')!
        .closest('.ordered-rules'),
    ).not.toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Move rule up"]')!.click());
    expect(host.querySelector('.rule-list button')).toBe(rows[1]);
    expect(document.activeElement).toBe(rows[1]);
    expect(host.querySelector('.rule-list')!.textContent).not.toContain('Unreachable');
    expect(graph).toEqual(before);
    await act(() => button(finish).click());
    if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
    else {
      expect(apply).toHaveBeenCalledOnce();
      const data = { ...node.data, settings: apply.mock.calls[0][1].settings };
      expect(ruleTablePlan(data).rules.map((r) => r.name)).toEqual(['Public site', 'Broad rule']);
      expect(readRuleTable(data.settings).rules.map((r) => r.id)).toEqual(['specific', 'all']);
    }
  },
);

it('uses protocol checkboxes and the default route instead of a match-all control', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    table = readRuleTable(node.data.settings);
  table.rules = [
    {
      id: 'protocol-rule',
      name: 'Secure sites',
      enabled: true,
      output: table.defaultOutput,
      matchAll: false,
      conditions: { domain: 'full:public.example', protocol: 'tls' },
    },
  ];
  Object.assign(node.data.settings, tableSettings(table));
  const graph = { name: 'Protocol controls', nodes: [node], edges: [] } as GraphState,
    apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  expect(host.querySelector('[data-diagnostic-field="matchAll"]')).toBeNull();
  expect(host.querySelector('[data-diagnostic-field="protocol"] textarea')).toBeNull();
  const option = (name: string) =>
    [...host.querySelectorAll<HTMLLabelElement>('.rule-protocols label')]
      .find((label) => label.textContent!.trim() === name)!
      .querySelector<HTMLInputElement>('input')!;
  expect(option('TLS').checked).toBe(true);
  await act(() => option('HTTP').click());
  await act(() => option('TLS').click());
  await act(() => button('Apply changes').click());
  const applied = readRuleTable(apply.mock.calls[0][1].settings);
  expect(applied.rules[0].conditions).toEqual({ domain: 'full:public.example', protocol: 'http' });
  expect(applied.defaultOutput).toBe(table.defaultOutput);
});

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

it('requires explicit replacements for the default route and disabled rules after output deletion', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    table = readRuleTable(node.data.settings);
  table.outputs = [
    { id: 'old', name: 'Old route' },
    { id: 'keep', name: 'Keep route' },
  ];
  table.defaultOutput = 'old';
  table.rules = [
    {
      id: 'disabled',
      name: 'Disabled rule',
      enabled: false,
      matchAll: false,
      conditions: { domain: 'full:public.example' },
      output: 'old',
    },
  ];
  Object.assign(node.data.settings, tableSettings(table));
  const graph = { name: 'Default deletion', nodes: [node], edges: [] } as GraphState;
  const apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await act(() => button('Outputs (2)').click());
  await act(() => button('Delete output Old route').click());
  expect(button('Apply changes').disabled).toBe(true);
  await act(() => button('Rules (1)').click());
  const fallback = host.querySelector<HTMLSelectElement>(
    '[data-diagnostic-field="defaultOutput"]',
  )!;
  const rule = host.querySelector<HTMLSelectElement>('[data-diagnostic-field="output"]')!;
  const section = fallback.closest('details')!;
  expect(section.open).toBe(false);
  expect(section.querySelector('summary')!.textContent).toContain('Choose an output…');
  expect(
    focusDiagnostic(host, {
      severity: 'error',
      nodeId: node.id,
      fieldKey: 'defaultOutput',
      message: 'Choose an output',
    }),
  ).toBe(true);
  expect(section.open).toBe(true);
  expect(document.activeElement).toBe(fallback);
  expect(fallback.value).toBe('');
  expect(rule.value).toBe('');
  await choose(fallback, 'keep');
  await act(() => section.querySelector('summary')!.click());
  expect(section.open).toBe(false);
  expect(section.querySelector('summary')!.textContent).toContain('Keep route');
  expect(button('Apply changes').disabled).toBe(true);
  await choose(rule, 'keep');
  expect(button('Apply changes').disabled).toBe(false);
  await act(() => button('Apply changes').click());
  const saved = readRuleTable(apply.mock.calls[0][1].settings);
  expect(saved.defaultOutput).toBe('keep');
  expect(saved.rules[0]).toMatchObject({ output: 'keep', enabled: false });
});

it('can remove the last output in a draft without silently adopting a newly added route', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    table = readRuleTable(node.data.settings);
  table.outputs = [{ id: 'only', name: 'Only route' }];
  table.defaultOutput = 'only';
  table.rules = [];
  Object.assign(node.data.settings, tableSettings(table));
  const graph = { name: 'Last output deletion', nodes: [node], edges: [] } as GraphState,
    before = structuredClone(graph),
    apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await act(() => button('Outputs (1)').click());
  await act(() => button('Delete output Only route').click());
  expect(button('Apply changes').disabled).toBe(true);
  await act(() => button('Add output').click());
  expect(button('Apply changes').disabled).toBe(true);
  await act(() => button('Rules (0)').click());
  expect(
    host.querySelector<HTMLSelectElement>('[data-diagnostic-field="defaultOutput"]')!.value,
  ).toBe('');
  await act(() => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(graph).toEqual(before);
});

it('edits an expanded field atomically, trims commas and preserves comments', async () => {
  const node = makeNode('routing-filter', { x: 0, y: 0 }),
    t = readRuleTable(node.data.settings);
  node.data.settings = {
    ...node.data.settings,
    ...tableSettings({
      ...t,
      rules: [
        {
          id: 'expanded',
          name: 'QA',
          enabled: true,
          output: t.defaultOutput,
          matchAll: false,
          conditions: { domain: 'full:old.example' },
        },
      ],
    }),
  };
  const graph = { name: 'QA', nodes: [node], edges: [] } as GraphState,
    apply = vi.fn(),
    close = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={close} />),
  );
  await act(() => button('Expand Destination domains').click());
  const field = host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Expanded Destination domains"]',
  )!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      '# Notes,\n full: new.example,',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Apply changes').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  await act(() => button('OK').click());
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Destination domains"]')!.value).toBe(
    '# Notes,\n full: new.example,',
  );
  await act(() => button('Expand Destination IPs').click());
  await act(() =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  );
  expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Expanded Destination IPs"]')).toBeNull();
  await act(() => button('Apply changes').click());
  expect(readRuleTable(apply.mock.calls[0][1].settings).rules[0].conditions.domain).toBe(
    '# Notes,\nfull: new.example',
  );
  expect(readRuleTable(node.data.settings).rules[0].conditions.domain).toBe('full:old.example');
});

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
