// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PolicyEditor from './PolicyEditor';
import PolicySourcesEditor from './PolicySourcesEditor';
import { makeEditorNode } from '../graph/catalog';
import { compileRuntimeGraph } from '../graph/runtime';
import { generatedTag } from '../graph/tags';
import { createPolicyExample } from '../graph/policyExample';
import {
  emptyPolicySources,
  policyProfile,
  readPolicySources,
  refreshPolicySources,
  subscriptionSource,
} from '../graph/policySources';
import { importProfiles, type Stash } from '../profiles/import';

let root: Root, container: HTMLDivElement;
const emptyStash: Stash = {
  format: 'wayrill.stash',
  version: 3,

  groups: [],
};
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

it('previews filtering, all candidate origins, exclusions and fallback across tabs without activation', async () => {
  const sub = importProfiles(
    'vless://public-a@a.example.net:443?security=tls#EU public',
    'Public subscription',
  ).groups[0];
  sub.updatedAt = 1234567890000;
  sub.entries.push({
    id: 'unsupported',
    name: 'EU unsupported',
    protocol: 'unknown',
    address: 'unknown.example',
    profile: null,
    problem: 'Unsupported',
    raw: 'public fixture',
  });
  const graph = createPolicyExample(),
    group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  const sources = readPolicySources(group.data);
  sources.manual = [policyProfile(sub.entries[0])];
  sources.subscriptions = [subscriptionSource(sub)];
  group.data.settings.selection = 'combined';
  group.data.settings.sources = JSON.stringify(sources);
  const before = structuredClone(graph),
    apply = vi.fn();
  await act(async () =>
    root.render(
      <PolicyEditor
        node={group}
        graph={graph}
        stash={{ ...emptyStash, groups: [sub] }}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  const totals = container.querySelector('[aria-label="Candidate source totals"]')!;
  expect([...totals.querySelectorAll('dd')].map((e) => e.textContent)).toEqual([
    '1',
    '1',
    '1',
    '1',
  ]);
  const table = container.querySelector('.policy-candidate-table')!;
  expect(table.textContent).toContain('Manual set · Public subscription');
  const search = [...container.querySelectorAll('input')].find((e) =>
    e.parentElement?.textContent?.includes('Search resulting outbounds'),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'Public subscription',
    );
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
  const filter = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      filter,
      'No match',
    );
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect([...totals.querySelectorAll('dd')].map((e) => e.textContent)).toEqual(['1', '0']);
  expect(totals.textContent).not.toContain('Duplicate entries merged');
  expect(totals.textContent).not.toContain('Unsupported matches excluded');
  expect(container.querySelector('[aria-label="Draft policy summary"]')!.textContent).toContain(
    '1 candidate',
  );
  await act(async () => button('Health checks').click());
  expect(container.querySelector('[aria-label="Draft policy summary"]')!.textContent).toContain(
    'Fallback · Block',
  );
  await act(async () => button('Members').click());
  expect(filter.value).toBe('No match');
  expect(filter.getAttribute('aria-label')).toBe('Include names · Public subscription');
  expect(container.querySelector('[aria-label="Add subscription group"]')).not.toBeNull();
  await act(async () => button('Cancel').click());
  expect(graph).toEqual(before);
  expect(apply).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;

it('creates a lowest-latency group from a name with a working Block fallback', async () => {
  const graph = createPolicyExample();
  const original = graph.nodes.find((node) => node.data.kind === 'policy-group')!;
  const node = makeEditorNode('policy-group', original.position, original.id);
  const sources = readPolicySources(node.data);
  sources.manual = readPolicySources(original.data).manual;
  node.data.settings.sources = JSON.stringify(sources);
  graph.nodes = graph.nodes.map((item) => (item.id === node.id ? node : item));
  const before = JSON.stringify(graph);
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <PolicyEditor
        node={node}
        graph={graph}
        stash={emptyStash}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Selection mode"]')!.value).toBe(
    'leastPing',
  );
  expect(
    container.querySelector<HTMLSelectElement>('[aria-label="Fallback from graph"]')!.value,
  ).toBe('preset:block');
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('.policy-name-field input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Europe · Fastest',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Apply changes').click());
  const saved = apply.mock.calls[0][0];
  const edited = saved.nodes.find((item: typeof node) => item.id === node.id)!;
  expect(edited.data.label).toBe('Europe · Fastest');
  expect(edited.data.settings.tag).toBe(node.data.settings.tag);
  const compiled = compileRuntimeGraph(saved).config;
  const balancer = (
    compiled.routing as { balancers: { strategy: { type: string }; fallbackTag: string }[] }
  ).balancers[0];
  expect(balancer.strategy.type).toBe('leastPing');
  expect(
    (compiled.outbounds as { tag: string; protocol: string }[]).find(
      ({ tag }) => tag === balancer.fallbackTag,
    )?.protocol,
  ).toBe('blackhole');
  expect(JSON.stringify(graph)).toBe(before);
});

it('keeps saved automatic tags stable when a Stash editor uses a temporary node identity', async () => {
  const graph = createPolicyExample();
  const node = graph.nodes.find((item) => item.data.kind === 'policy-group')!;
  node.data.label = 'Saved group';
  node.data.settings.tag = generatedTag('pg', node.data.label, 'previous-stash-editor');
  const tag = node.data.settings.tag;
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <PolicyEditor
        node={node}
        graph={graph}
        stash={emptyStash}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('.policy-name-field input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'Temporary rename');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('.policy-name-field input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Saved group',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Apply changes').click());
  expect(
    apply.mock.calls[0][0].nodes.find((item: typeof node) => item.id === node.id).data.settings.tag,
  ).toBe(tag);
});

describe('policy group editor', () => {
  it('retains a missing subscription snapshot and relinks its filters to a replacement group', async () => {
    const sub = importProfiles(
      'vless://public-a@a.example.net:443?security=tls#JP fast',
      'Removed source',
    ).groups[0];
    const source = subscriptionSource(sub);
    source.filter.name = 'JP';
    source.filter.protocol = 'vless';
    const sources = refreshPolicySources(
      { ...emptyPolicySources(), subscriptions: [source] },
      { ...emptyStash, groups: [sub] },
    );
    sources.subscriptions[0].missing = true;
    const replacement = { ...sub, id: 'replacement', name: 'Replacement source' };
    const graph = createPolicyExample(),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    group.data.settings.selection = 'subscription';
    group.data.settings.sources = JSON.stringify(sources);
    const changed = vi.fn();
    await act(async () =>
      root.render(
        <PolicySourcesEditor
          graph={graph}
          node={group}
          stash={{ ...emptyStash, groups: [replacement] }}
          sources={readPolicySources(group.data)}
          onChange={changed}
        />,
      ),
    );
    expect(container.textContent).toContain('saved snapshot');
    expect(container.querySelector('textarea')!.disabled).toBe(true);
    const relink = [...container.querySelectorAll('select')].find((s) =>
      s.parentElement!.textContent!.includes('Relink'),
    )!;
    await act(async () => {
      relink.value = 'replacement';
      relink.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const next = refreshPolicySources(changed.mock.calls[0][0], {
      ...emptyStash,
      groups: [replacement],
    });
    expect(next.subscriptions[0].filter).toEqual(source.filter);
    expect(next.subscriptions[0].missing).toBe(false);
    expect(next.subscriptions[0].entries).toHaveLength(1);
  });
});

it('holds policy fields during an asynchronous save and preserves the draft on failure', async () => {
  const graph = createPolicyExample(),
    node = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  let reject!: (e: Error) => void;
  const close = vi.fn();
  const apply = () =>
    new Promise<void>((_, no) => {
      reject = no;
    });
  await act(async () =>
    root.render(
      <PolicyEditor node={node} graph={graph} stash={emptyStash} onApply={apply} onClose={close} />,
    ),
  );
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Apply changes',
  )!;
  await act(async () => button.click());
  expect(container.querySelector<HTMLInputElement>('.policy-name-field input')!.disabled).toBe(
    true,
  );
  expect(container.querySelector('[role=tabpanel]:not([hidden])')!.hasAttribute('inert')).toBe(
    true,
  );
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')].every(
      (t) => t.getAttribute('aria-disabled') === 'true',
    ),
  ).toBe(true);
  await act(async () => reject(new Error('Retry save')));
  expect(container.querySelector<HTMLInputElement>('.policy-name-field input')!.disabled).toBe(
    false,
  );
  expect(container.textContent).toContain('Retry save');
  expect(close).not.toHaveBeenCalled();
});
