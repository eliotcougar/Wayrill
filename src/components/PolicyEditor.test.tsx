// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PolicyEditor from './PolicyEditor';
import PolicySourcesEditor from './PolicySourcesEditor';
import { DiagnosticFocusContext } from './DiagnosticNavigation';
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
  await act(async () => button('Strategy').click());
  expect(container.querySelector('[aria-label="Draft policy summary"]')!.textContent).toContain(
    'Fallback · Block',
  );
  await act(async () => button('Outbound set').click());
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

describe('policy group editor', () => {
  it('keeps invalid numeric drafts across sections and reviews the exact field before correction', async () => {
    const graph = createPolicyExample('leastPing', 'burst'),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!,
      before = structuredClone(graph),
      apply = vi.fn();
    await act(async () =>
      root.render(
        <PolicyEditor
          node={group}
          graph={graph}
          stash={emptyStash}
          onApply={apply}
          onClose={() => {}}
        />,
      ),
    );
    const tab = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (b) => b.textContent === name,
      )!;
    await act(async () => tab('Observatory').click());
    const input = container.querySelector<HTMLInputElement>('[id$="-sampling"]')!;
    const enter = async (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await enter('0');
    expect(button('Apply changes').disabled).toBe(true);
    await act(async () => tab('Strategy').click());
    expect(button('Apply changes').disabled).toBe(true);
    expect(container.querySelector('[id$="-sampling"]')).toBe(input);
    expect(input.value).toBe('0');
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button.diagnostic')]
        .find((b) => b.textContent!.includes('Samples per health window'))!
        .click(),
    );
    expect(tab('Observatory').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await enter('2');
    expect(button('Apply changes').disabled).toBe(false);
    expect(graph).toEqual(before);
    await act(async () => button('Apply changes').click());
    expect(
      apply.mock.calls[0][0].nodes.find((n: { id: string }) => n.id === 'test-observatory').data
        .settings.sampling,
    ).toBe(2);
  });
  it('opens an external strategy diagnostic in its own section', async () => {
    const graph = createPolicyExample(),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    await act(async () =>
      root.render(
        <DiagnosticFocusContext.Provider
          value={{
            surface: 'editor',
            issue: {
              severity: 'error',
              message: 'Localized',
              nodeId: group.id,
              fieldKey: 'strategy',
            },
          }}
        >
          <PolicyEditor
            node={group}
            graph={graph}
            stash={emptyStash}
            onApply={vi.fn()}
            onClose={vi.fn()}
          />
        </DiagnosticFocusContext.Provider>,
      ),
    );
    expect(document.activeElement!.id).toContain('-strategy');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe(
      'Strategy',
    );
  });
  it('preserves an optional canvas observatory connection when applying an ordinary round-robin group', async () => {
    const graph = createPolicyExample('roundRobin'),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    group.data.settings.fallbackEnabled = false;
    group.data.settings.observe = false;
    const apply = vi.fn();
    await act(async () =>
      root.render(
        <PolicyEditor
          node={group}
          graph={graph}
          stash={emptyStash}
          onApply={apply}
          onClose={() => {}}
        />,
      ),
    );
    expect(button('Apply changes').disabled).toBe(false);
    await act(async () => button('Apply changes').click());
    expect(apply.mock.calls[0][0].edges).toEqual(graph.edges);
    expect(
      apply.mock.calls[0][0].nodes.find((n: { id: string }) => n.id === group.id).data.settings
        .observe,
    ).toBe(true);
  });
  it('keeps draft source-mode edits out of the graph when cancelled', async () => {
    const graph = createPolicyExample(),
      group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
    const before = structuredClone(graph),
      apply = vi.fn(),
      close = vi.fn();
    await act(async () =>
      root.render(
        <PolicyEditor
          node={group}
          graph={graph}
          stash={emptyStash}
          onApply={apply}
          onClose={close}
        />,
      ),
    );
    const mode = container.querySelector<HTMLSelectElement>('[id$="-selection"]')!;
    await act(async () => {
      mode.value = 'combined';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button('Apply changes').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    expect(close).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(graph).toEqual(before);
  });
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

it('keeps the fallback visible in the graph picker and stages Block/graph selections without changing candidates', async () => {
  const graph = createPolicyExample(),
    group = graph.nodes.find((n) => n.data.kind === 'policy-group')!,
    original = readPolicySources(group.data),
    apply = vi.fn();
  await act(async () =>
    root.render(
      <PolicyEditor
        node={group}
        graph={graph}
        stash={emptyStash}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="Choose fallback from graph"]',
  )!;
  expect(select.selectedOptions[0].textContent).toContain('Block');
  const direct = graph.nodes.find((n) => n.data.kind === 'direct-outbound')!;
  await act(async () => {
    select.value = direct.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe(direct.id);
  expect(select.selectedOptions[0].textContent).toContain(direct.data.label);
  await act(async () => button('Use Block fallback').click());
  expect(select.value).toBe('__current__');
  expect(select.selectedOptions[0].textContent).toContain('Block');
  await act(async () => button('Apply changes').click());
  const result = readPolicySources(
    apply.mock.calls[0][0].nodes.find((n: { id: string }) => n.id === group.id).data,
  );
  expect(result.manual).toEqual(original.manual);
  expect(result.subscriptions).toEqual(original.subscriptions);
  expect(result.fallback?.type).toBe('profile');
});

it('places an automatically created observatory outside existing cards', async () => {
  const { makeNode } = await import('../graph/catalog');
  const graph = createPolicyExample(),
    group = graph.nodes.find((n) => n.data.kind === 'policy-group')!,
    oldObserver = graph.nodes.find((n) => n.data.kind === 'observatory')!;
  graph.nodes = graph.nodes.filter((n) => n.id !== oldObserver.id);
  graph.edges = graph.edges.filter(
    (e) => e.source !== oldObserver.id && e.target !== oldObserver.id,
  );
  const blocker = makeNode('direct-outbound', { x: group.position.x, y: group.position.y + 320 });
  blocker.measured = { width: 250, height: 230 };
  graph.nodes.push(blocker);
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <PolicyEditor
        node={group}
        graph={graph}
        stash={emptyStash}
        onApply={apply}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(async () => button('Apply changes').click());
  expect(apply).toHaveBeenCalledOnce();
  const next: typeof graph = apply.mock.calls[0][0];
  const observer = next.nodes.find((n) => n.data.kind === 'observatory')!;
  expect(observer).toBeDefined();
  for (const other of graph.nodes) {
    const width = other.measured?.width ?? 250,
      height = other.measured?.height ?? 230;
    expect(
      observer.position.x + 250 + 32 <= other.position.x ||
        observer.position.x >= other.position.x + width + 32 ||
        observer.position.y + 230 + 32 <= other.position.y ||
        observer.position.y >= other.position.y + height + 32,
    ).toBe(true);
  }
  expect(next.edges.some((e) => e.source === group.id && e.target === observer.id)).toBe(true);
  expect(blocker.position).toEqual({ x: group.position.x, y: group.position.y + 320 });
});

it('guides an untouched empty group without displaying its asynchronous empty-set error', async () => {
  const graph = createPolicyExample();
  const group = graph.nodes.find((n) => n.data.kind === 'policy-group')!;
  Object.assign(group.data.settings, {
    sources: JSON.stringify(emptyPolicySources()),
    selection: 'manual',
    fallbackEnabled: false,
    observe: false,
  });
  graph.edges = graph.edges.filter((e) => e.source !== group.id);
  await act(async () => {
    root.render(
      <PolicyEditor
        node={group}
        graph={graph}
        stash={emptyStash}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.textContent).toContain('Choose candidates to continue');
  expect(container.querySelector('.rule-editor-diagnostics')!.textContent).not.toMatch(
    /No outbound matches|no candidate destinations match/i,
  );
  expect(button('Apply changes').disabled).toBe(true);
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
