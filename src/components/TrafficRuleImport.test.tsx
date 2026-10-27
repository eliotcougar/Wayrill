// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import RuleTableEditor from './RuleTableEditor';
import { createDnsExample } from '../graph/example';
import { readRuleTable } from '../graph/rules';
import { updateGraphNode } from '../graph/model';
import {
  initialWorkspaceHistory,
  commitWorkspaceHistory,
  undoWorkspaceHistory,
} from '../graph/workspaceHistory';
import fixture from '../graph/fixtures/v2rayN-lab-routing.json';
const download = vi.hoisted(() => vi.fn());
vi.mock('../routingDownload', () => ({ downloadRoutingRules: download }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  download.mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
async function file(value: string | Promise<ArrayBuffer>) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Routing file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [
      {
        size: 1024,
        name: 'routing.json',
        arrayBuffer: () =>
          typeof value === 'string'
            ? Promise.resolve(new TextEncoder().encode(value).buffer)
            : value,
      },
    ],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
async function editor() {
  const graph = createDnsExample(),
    node = graph.nodes.find((n) => n.data.kind === 'routing-filter')!,
    apply = vi.fn();
  await act(() =>
    root.render(<RuleTableEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await act(() => button('Import').click());
  return { graph, node, apply };
}
it.each(['Cancel', 'Apply changes'])(
  'file import stages atomically, retains wires and supports %s',
  async (finish) => {
    const { graph, node, apply } = await editor(),
      original = structuredClone(graph);
    await file(JSON.stringify(fixture));
    expect(host.querySelector('[aria-label="Imported rule preview"]')).not.toBeNull();
    await act(() => button('Import rules').click());
    expect(graph).toEqual(original);
    expect(apply).not.toHaveBeenCalled();
    expect(button('Apply changes').disabled).toBe(false);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Rules (11)',
    );
    await act(() => button(finish).click());
    if (finish === 'Cancel') expect(apply).not.toHaveBeenCalled();
    else {
      const next = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
      expect(next.edges).toEqual(original.edges);
      expect(
        readRuleTable(next.nodes.find((n) => n.id === node.id)!.data.settings).defaultOutput,
      ).toBe('default');
      expect(
        undoWorkspaceHistory(
          commitWorkspaceHistory(initialWorkspaceHistory(graph), {
            graph: next,
          }),
        ).present.graph,
      ).toEqual(original);
    }
  },
);
it('rejects malformed imports without changing the existing draft', async () => {
  const { apply, node } = await editor();
  await file('[{"domain":"bad","outboundTag":"proxy"}]');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('array');
  expect(button('Import rules')).toBeUndefined();
  await act(() => button('Apply changes').click());
  expect(readRuleTable(apply.mock.calls[0][1].settings)).toEqual(readRuleTable(node.data.settings));
});
it('ignores an older file read after a newer selection completes', async () => {
  await editor();
  let resolve!: (v: ArrayBuffer) => void;
  await file(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await file(JSON.stringify(fixture));
  await act(async () =>
    resolve(
      new TextEncoder().encode('[{"domain":["stale.example"],"outboundTag":"proxy"}]').buffer,
    ),
  );
  expect(host.querySelector('h3')?.textContent).toContain('12 source rules');
  expect(host.textContent).not.toContain('stale.example');
});
it('URL import reviews the download and Cancel discards a pending response', async () => {
  await editor();
  const input = host.querySelector<HTMLInputElement>('[aria-label="Routing URL"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'https://example.net/list',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let resolve!: (v: string) => void;
  download.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await act(() => button('Load URL').click());
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent?.trim() === 'Cancel',
  );
  await act(() => buttons[0].click());
  await act(async () => resolve(JSON.stringify(fixture)));
  expect(host.querySelector('[aria-label="Imported rule preview"]')).toBeNull();
  expect(download).toHaveBeenCalledOnce();
});

it('distinguishes an outbound and policy group that share a tag for keyboard and screen-reader mapping', async () => {
  await editor();
  await file(
    JSON.stringify({
      rules: [
        { domain: ['a.example'], outboundTag: 'same' },
        { domain: ['b.example'], balancerTag: 'same' },
      ],
    }),
  );
  expect(host.querySelector('[aria-label="Imported output: same"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Imported policy output: same"]')).not.toBeNull();
});

it('accepts UTF-16 routing files produced by Windows PowerShell', async () => {
  await editor();
  const bytes = new Uint8Array([0xff, 0xfe, ...Buffer.from(JSON.stringify(fixture), 'utf16le')]);
  await file(Promise.resolve(bytes.buffer));
  expect(host.querySelector('[aria-label="Imported rule preview"]')).not.toBeNull();
  expect(button('Import rules').disabled).toBe(false);
});

it('keeps a file source through save/reopen and merges a manual update with local domain entries', async () => {
  const { graph, node, apply } = await editor();
  const source = (domain: string[]) =>
    JSON.stringify([{ id: 'web', remarks: 'Web', domain, outboundTag: 'proxy' }]);
  await file(source(['domain:source.example']));
  await act(() => button('Import rules').click());
  const domains = host.querySelector<HTMLTextAreaElement>(
    '[data-diagnostic-field="domain"] textarea',
  )!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      domains,
      'domain:source.example\ndomain:local.example',
    );
    domains.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => button('Apply changes').click());
  const next = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
  await act(() =>
    root.render(
      <RuleTableEditor
        key="reopen"
        node={next.nodes.find((n) => n.id === node.id)!}
        graph={next}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() => button('Import').click());
  expect(host.querySelector('[aria-label="Current rule source"]')?.textContent).toContain(
    'routing.json',
  );
  await act(() => button('Update from source').click());
  await file(source(['domain:new.example', 'domain:local.example', 'domain:local.example']));
  await act(() => button('Update rules').click());
  expect(
    host.querySelector<HTMLTextAreaElement>('[data-diagnostic-field="domain"] textarea')!.value,
  ).toBe('domain:new.example\ndomain:local.example');
  await act(() => button('Apply changes').click());
  const updated = updateGraphNode(next, node.id, apply.mock.calls[1][1]);
  expect(updated.edges).toEqual(graph.edges);
  expect(
    readRuleTable(updated.nodes.find((n) => n.id === node.id)!.data.settings).rules[0].source?.edits
      .domain?.added,
  ).toEqual(['domain:local.example']);
});

it('reuses saved URL download options on Update and allows detaching without discarding rules', async () => {
  const { graph, node, apply } = await editor();
  const input = host.querySelector<HTMLInputElement>('[aria-label="Routing URL"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'https://example.net/rules',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  download.mockResolvedValue(
    JSON.stringify([{ id: 'web', domain: ['one.example'], outboundTag: 'proxy' }]),
  );
  await act(async () => button('Load URL').click());
  await act(() => button('Import rules').click());
  await act(() => button('Import').click());
  download.mockResolvedValue(
    JSON.stringify([{ id: 'web', domain: ['two.example'], outboundTag: 'proxy' }]),
  );
  await act(async () => button('Update from source').click());
  expect(download.mock.lastCall?.slice(0, 3)).toEqual(['https://example.net/rules', false, false]);
  await act(() => button('Update rules').click());
  await act(() => button('Import').click());
  await act(() => button('Detach source').click());
  await act(() => button('Apply changes').click());
  const next = updateGraphNode(graph, node.id, apply.mock.calls[0][1]);
  const table = readRuleTable(next.nodes.find((n) => n.id === node.id)!.data.settings);
  expect(table.source).toBeUndefined();
  expect(table.rules[0].source).toBeUndefined();
  expect(table.rules[0].conditions.domain).toBe('two.example');
});
