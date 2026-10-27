// @vitest-environment jsdom
import { defaultGroup } from '../profiles/stashModel';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import PolicyOutboundPicker from './PolicyOutboundPicker';
import { makeNode } from '../graph/catalog';
import { preparedEntry } from '../graph/composites';
import { createPolicyExample } from '../graph/policyExample';
import { importProfiles, type Stash } from '../profiles/import';
it('keeps manual and fallback searches, pagination and Add commands separately named and scoped', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    manual = vi.fn(),
    fallback = vi.fn();
  const imported = importProfiles(
    Array.from(
      { length: 61 },
      (_, i) => `vless://public-${i}@qa${i}.example.net:443?security=tls#QA ${i}`,
    ).join('\n'),
    'Public QA',
  );
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,

    groups: imported.groups,
  };
  try {
    await act(() =>
      root.render(
        <>
          <PolicyOutboundPicker
            label="Add outbound"
            graph={createPolicyExample()}
            stash={stash}
            onSelect={manual}
          />
          <PolicyOutboundPicker
            label="Choose fallback"
            graph={createPolicyExample()}
            stash={stash}
            onSelect={fallback}
          />
        </>,
      ),
    );
    for (const label of ['Add outbound', 'Choose fallback']) {
      await act(() =>
        [...host.querySelectorAll('button')]
          .find((b) => b.textContent === `${label} from stash…`)!
          .click(),
      );
      expect(host.querySelector(`[aria-label="${label}: search stash outbounds"]`)).not.toBeNull();
      expect(host.querySelector(`[aria-label="${label}: stash: go to page"]`)).not.toBeNull();
    }
    const manualRegion = host.querySelector('[aria-label="Add outbound picker"]')!;
    const fallbackRegion = host.querySelector('[aria-label="Choose fallback picker"]')!;
    const search = manualRegion.querySelector('input')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'qa60.example.net',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(manualRegion.querySelectorAll('.policy-picker-row')).toHaveLength(1);
    expect(fallbackRegion.querySelectorAll('.policy-picker-row')).toHaveLength(30);
    expect(manualRegion.querySelector('nav')).toBeNull();
    await act(() =>
      manualRegion
        .querySelector<HTMLButtonElement>('[aria-label="Add QA 60 to add outbound"]')!
        .click(),
    );
    expect(manual).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(manual.mock.calls[0][0].name).toBe('QA 60');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

it('names the selected prepared library scope and returns the correct composite candidate', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    select = vi.fn();
  const graph = createPolicyExample();
  const node = makeNode('policy-group', { x: 0, y: 0 }, 'prepared');
  node.data.label = 'Reusable group';
  node.data.settings.sources = JSON.stringify({
    version: 1,
    manual: [{ type: 'node', nodeId: 'test-first' }],
    subscriptions: [],
  });
  const stash: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: [
      {
        ...defaultGroup(),
        entries: [preparedEntry({ ...graph, nodes: [...graph.nodes, node] }, node.id)],
      },
    ],
  };
  try {
    await act(() =>
      root.render(
        <PolicyOutboundPicker graph={graph} stash={stash} label="Hop" onSelect={select} />,
      ),
    );
    await act(() =>
      [...host.querySelectorAll('button')]
        .find((b) => b.textContent === 'Hop from stash…')!
        .click(),
    );
    const group = host.querySelector<HTMLSelectElement>('[aria-label="Hop: stash group"]')!;
    await act(() => {
      group.value = stash.groups.find((g) => g.name === 'Default')!.id;
      group.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('Scope: Default.');
    await act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="Add Reusable group to hop"]')!.click(),
    );
    expect(select.mock.calls[0][0].profile.kind).toBe('policy-group');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
