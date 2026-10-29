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
