// @vitest-environment jsdom
import { stashRows, defaultGroup } from '../profiles/stashModel';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConfigurationStash from './ConfigurationStash';
import ProxyChainEditor from './ProxyChainEditor';
import useStash from '../profiles/useStash';
import { makeNode } from '../graph/catalog';
import { createPolicyExample } from '../graph/policyExample';
import { preparedEntry, readProxyChain } from '../graph/composites';
import { preparedPreview } from '../profiles/preparedPreview';
import { importProfiles, type Stash } from '../profiles/import';
import type { GraphState, RuleNode } from '../graph/types';
vi.mock('../protectedStorage', () => ({ protectedStorageAvailable: () => false }));
class PreviewWorker {
  static hold = false;
  static instances: PreviewWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  message?: { graph: GraphState; node: RuleNode; validationOnly?: boolean };
  constructor() {
    PreviewWorker.instances.push(this);
  }
  postMessage(message: NonNullable<PreviewWorker['message']>) {
    this.message = message;
    if (!PreviewWorker.hold) queueMicrotask(() => this.reply());
  }
  reply() {
    if (!this.message) return;
    try {
      const result = preparedPreview(this.message.graph, this.message.node);
      this.onmessage?.(
        new MessageEvent('message', {
          data: this.message.validationOnly ? { valid: true } : { result },
        }),
      );
    } catch (error) {
      this.onmessage?.(new MessageEvent('message', { data: { error: (error as Error).message } }));
    }
  }
  terminate() {
    this.terminated = true;
  }
}
let root: Root, container: HTMLDivElement, store: ReturnType<typeof useStash>;
const use = vi.fn(),
  close = vi.fn();
const graph = createPolicyExample();
const empty: Stash = { format: 'wayrill.stash', version: 3, groups: [] };
function chainFixture() {
  const node = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
  node.data.label = 'Prepared chain';
  node.data.settings.steps = JSON.stringify({
    version: 1,
    steps: [
      { id: 'a', outbound: { type: 'node', nodeId: 'test-first' } },
      { id: 'b', outbound: { type: 'node', nodeId: 'test-second' } },
    ],
  });
  return { node, context: { ...graph, nodes: [...graph.nodes, node] } };
}
function Harness({ replace = false }: { replace?: boolean }) {
  store = useStash();
  return (
    <ConfigurationStash
      store={store}
      graph={graph}
      replaceLabel={replace ? 'Destination' : undefined}
      onUse={use}
      onClose={close}
    />
  );
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
async function value(input: HTMLInputElement | HTMLSelectElement, next: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, next);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  vi.useFakeTimers();
  PreviewWorker.hold = false;
  PreviewWorker.instances = [];
  vi.stubGlobal('Worker', PreviewWorker);
  use.mockReset();
  close.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('creates and edits a reusable policy in its tab, saves an independent graph snapshot, and keeps nested Cancel inside the stash', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => button('Policy groups').click());
  await act(async () => button('New policy group').click());
  const draftName = container.querySelector<HTMLInputElement>(
    '.policy-editor input[maxlength="128"]',
  )!;
  await value(draftName, 'Friendly 🧭 group');
  await value(
    container.querySelector<HTMLSelectElement>('[aria-label="Add outbound from graph"]')!,
    'test-first',
  );
  await act(async () => button('Save to stash').click());
  expect(stashRows(store.stash, 'policy-group').map((r) => r.entry)).toHaveLength(1);
  expect(stashRows(store.stash, 'policy-group').map((r) => r.entry)[0].name).toBe(
    'Friendly 🧭 group',
  );
  expect(container.querySelectorAll('dialog')).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
  const sources = JSON.parse(
    String(stashRows(store.stash, 'policy-group').map((r) => r.entry)[0].profile!.settings.sources),
  );
  expect(sources.manual[0].type).toBe('profile');
  expect(
    [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
  ).toContain('Edit Friendly 🧭 group');
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.getAttribute('aria-label') === 'Edit Friendly 🧭 group')!
      .click(),
  );
  await value(
    container.querySelector<HTMLInputElement>('.policy-editor input[maxlength="128"]')!,
    'Discarded name',
  );
  await act(async () => button('Cancel').click());
  expect(stashRows(store.stash, 'policy-group').map((r) => r.entry)[0].name).toBe(
    'Friendly 🧭 group',
  );
  expect(close).not.toHaveBeenCalled();
});
it.each(['policy-group', 'proxy-chain'] as const)(
  'saves a %s edit after the service replaces its library entry object',
  async (kind) => {
    await act(async () => root.render(<Harness />));
    const fixture = chainFixture();
    const entry =
      kind === 'policy-group'
        ? preparedEntry(graph, 'test-group')
        : preparedEntry(fixture.context, fixture.node.id);
    const result = importProfiles('socks://127.0.0.1:16001#Unused');
    result.groups[0].entries = [entry];
    await act(async () => store.importResult(result));
    await act(async () =>
      button(kind === 'policy-group' ? 'Policy groups' : 'Proxy chains').click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[aria-label="Edit ${entry.name}"]`)!.click(),
    );
    await value(
      container.querySelector<HTMLInputElement>('.policy-editor input[maxlength="128"]')!,
      'Renamed prepared',
    );
    await act(async () =>
      store.update((current) => {
        const next = structuredClone(current);
        next.groups.find((g) => g.entries.some((e) => e.id === entry.id))!.entries[0].locked = true;
        return next;
      }),
    );
    await act(async () => vi.advanceTimersByTime(100));
    expect(button('Save to stash').disabled).toBe(false);
    await act(async () => button('Save to stash').click());
    expect(container.querySelector('.policy-editor')).toBeNull();
    expect(stashRows(store.get(), kind)[0].entry).toMatchObject({
      id: entry.id,
      name: 'Renamed prepared',
      locked: true,
    });
  },
);

it('uses one replacement action across all three tabs and cannot confuse subscriptions with library IDs', async () => {
  await act(async () => root.render(<Harness replace />));
  const { node, context } = chainFixture();
  const result = importProfiles('socks://127.0.0.1:16001#Plain');
  result.groups[0].id = 'policy-group';
  result.groups[0].entries[0].id = 'same-entry';
  result.groups.push(
    { ...defaultGroup(), entries: [{ ...preparedEntry(graph, 'test-group'), id: 'same-entry' }] },
    {
      ...defaultGroup(),
      id: 'proxy-chain',
      name: 'Chains',
      entries: [{ ...preparedEntry(context, node.id), id: 'same-entry' }],
    },
  );
  await act(async () => store.importResult(result));
  expect(new Set(store.stash.groups.map((g) => g.id)).size).toBe(4);
  for (const [tab, expected] of [
    ['Outbounds', stashRows(store.stash)[0].entry],
    ['Policy groups', stashRows(store.stash, 'policy-group').map((r) => r.entry)[0]],
    ['Proxy chains', stashRows(store.stash, 'proxy-chain').map((r) => r.entry)[0]],
  ] as const) {
    await act(async () => button(tab).click());
    expect(button('Replace').disabled).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[role="tabpanel"]:not([hidden]) input[type="radio"]')!
        .click(),
    );
    expect(button('Replace').disabled).toBe(false);
    await act(async () => button('Replace').click());
    expect(use).toHaveBeenLastCalledWith(
      expected,
      true,
      expect.objectContaining({ groupId: expect.any(String), entryId: expected.id }),
    );
  }
});

it('reorders hops by keyboard with stable reference identity and retains a failed save for correction', async () => {
  const { node, context } = chainFixture(),
    apply = vi.fn((_graph: GraphState) => {
      throw new Error('Save failed');
    });
  await act(async () =>
    root.render(
      <ProxyChainEditor
        node={node}
        graph={context}
        stash={empty}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
  await act(async () => vi.advanceTimersByTime(100));
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.rule-list-item')];
  await act(async () =>
    rows[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(100));
  expect(container.querySelector('[role=alert]')?.textContent).toBeUndefined();
  await act(async () => button('Apply changes').click());
  const next = apply.mock.calls[0][0] as GraphState;
  expect(
    readProxyChain(next.nodes.find((n) => n.id === node.id)!.data).steps.map((s) => s.id),
  ).toEqual(['b', 'a']);
  expect(readProxyChain(node.data).steps.map((s) => s.id)).toEqual(['a', 'b']);
  expect(container.textContent).toContain('Save failed');
  expect(close).not.toHaveBeenCalled();
});

it('blocks save during validation, ignores a stale worker, and cancels without changing the graph', async () => {
  PreviewWorker.hold = true;
  const { node, context } = chainFixture(),
    before = JSON.stringify(context);
  await act(async () =>
    root.render(
      <ProxyChainEditor node={node} graph={context} stash={empty} onApply={use} onClose={close} />,
    ),
  );
  await act(async () => vi.advanceTimersByTime(100));
  const first = PreviewWorker.instances[0];
  expect(button('Apply changes').disabled).toBe(true);
  const tag = [...container.querySelectorAll<HTMLInputElement>('input')].find(
    (i) => i.value === 'proxy-chain',
  )!;
  await value(tag, 'edited-chain');
  expect(first.terminated).toBe(true);
  await act(async () => first.reply());
  expect(button('Apply changes').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(100));
  await act(async () => PreviewWorker.instances.at(-1)!.reply());
  expect(container.querySelector('[role=alert]')?.textContent).toBeUndefined();
  expect(button('Apply changes').disabled).toBe(false);
  await act(async () => button('Cancel').click());
  expect(use).not.toHaveBeenCalled();
  expect(JSON.stringify(context)).toBe(before);
});

it('blocks a previously valid chain while a referenced outbound is revalidated', async () => {
  PreviewWorker.hold = true;
  const { node, context } = chainFixture();
  const render = (graph: GraphState) =>
    root.render(
      <ProxyChainEditor node={node} graph={graph} stash={empty} onApply={use} onClose={close} />,
    );
  await act(async () => render(context));
  await act(async () => vi.advanceTimersByTime(100));
  const first = PreviewWorker.instances[0];
  await act(async () => first.reply());
  expect(button('Apply changes').disabled).toBe(false);
  const changed = { ...context, nodes: context.nodes.filter((n) => n.id !== 'test-first') };
  await act(async () => render(changed));
  expect(button('Apply changes').disabled).toBe(true);
  await act(async () => first.reply());
  expect(button('Apply changes').disabled).toBe(true);
});

it('collapses rapid chain edits before copying their graph and releases a timed-out worker', async () => {
  PreviewWorker.hold = true;
  const { node, context } = chainFixture();
  await act(async () =>
    root.render(
      <ProxyChainEditor node={node} graph={context} stash={empty} onApply={use} onClose={close} />,
    ),
  );
  const tag = [...container.querySelectorAll<HTMLInputElement>('input')].find(
    (i) => i.value === 'proxy-chain',
  )!;
  for (const name of ['a', 'ab', 'abc']) await value(tag, name);
  expect(PreviewWorker.instances).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(100));
  expect(PreviewWorker.instances).toHaveLength(1);
  expect(PreviewWorker.instances[0].message!.node.data.settings.tag).toBe('abc');
  await act(async () => vi.advanceTimersByTime(60000));
  expect(container.textContent).toContain('timed out');
  expect(PreviewWorker.instances[0].terminated).toBe(true);
  await act(async () => PreviewWorker.instances[0].reply());
  expect(button('Apply changes').disabled).toBe(true);
});

it('holds chain fields and tabs while saving, then releases them after a failed save', async () => {
  const { node, context } = chainFixture();
  let reject!: (e: Error) => void;
  const apply = () =>
    new Promise<void>((_, no) => {
      reject = no;
    });
  await act(async () =>
    root.render(
      <ProxyChainEditor
        node={node}
        graph={context}
        stash={empty}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
  await act(async () => vi.advanceTimersByTime(100));
  await act(async () => button('Apply changes').click());
  expect(container.querySelector('[role=tabpanel]:not([hidden])')!.hasAttribute('inert')).toBe(
    true,
  );
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')].every(
      (t) => t.getAttribute('aria-disabled') === 'true',
    ),
  ).toBe(true);
  await act(async () => reject(new Error('Retry save')));
  expect(container.querySelector('[role=tabpanel]:not([hidden])')!.hasAttribute('inert')).toBe(
    false,
  );
  expect(container.textContent).toContain('Retry save');
  expect(close).not.toHaveBeenCalled();
});
