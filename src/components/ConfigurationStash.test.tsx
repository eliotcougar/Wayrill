// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConfigurationStash from './ConfigurationStash';
import useStash from '../profiles/useStash';
import {
  SubscriptionMaintenanceContext,
  type SubscriptionMaintenanceController,
} from '../profiles/useSubscriptionMaintenance';
import { importProfiles, type ImportResult } from '../profiles/import';
import { maintenanceDefaults } from '../profiles/subscriptionState';
import { policyProfileId } from '../graph/profileIdentity';
import { stashEditorNode, snapshotGraphEntry } from '../profiles/workspace';
import { putStashEntry } from '../profiles/stashModel';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  fetch: vi.fn(),
  desktop: false,
  export: vi.fn(),
}));
vi.mock('../exportFile', () => ({ exportFile: mocks.export }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.fetch }));
vi.mock('../profiles/importClient', () => ({
  parseImport: mocks.parse,
  prepareImport: async (
    request: import('../profiles/refreshPreparation').RefreshRequest,
    signal: AbortSignal,
  ) => {
    const result = (await mocks.parse(request.text, request.name, false, signal)) as ImportResult;
    signal.throwIfAborted();
    const { prepareRefresh } = await import('../profiles/refreshPreparation');
    return prepareRefresh(request, result);
  },
}));
vi.mock('../protectedStorage', () => ({
  protectedStorageAvailable: () => mocks.desktop,
  protectedRead: async () => null,
  protectedWrite: async () => {},
}));
let root: Root, container: HTMLDivElement, store: ReturnType<typeof useStash>;
const use = vi.fn(),
  close = vi.fn();
const serviceRun: SubscriptionMaintenanceController['run'] = async (
  id,
  operation,
  _entries,
  signal,
) => {
  const group = store.get().groups.find((g) => g.id === id)!;
  const text = await mocks.fetch('subscriptions.run', { groupId: id, operation });
  if (operation === 'refresh') await store.importText(text, group.name, group, signal);
};
function Harness({
  replace = false,
  maintenance,
}: {
  replace?: boolean;
  maintenance?: SubscriptionMaintenanceController;
}) {
  store = useStash();
  maintenance ??= {
    appliedRevision: null,
    appliedSourceHash: null,
    statuses: {},
    run: serviceRun,
    cancel: vi.fn(),
    cancelAutomatic: vi.fn(),
    clearStatus: vi.fn(),
    available: true,
    foregroundBusy: false,
    withForeground: async (action) => action(),
  };
  const content = (
    <ConfigurationStash
      store={store}
      replaceLabel={replace ? 'Selected destination' : undefined}
      onUse={use}
      onClose={close}
    />
  );
  return maintenance ? (
    <SubscriptionMaintenanceContext.Provider value={maintenance}>
      {content}
    </SubscriptionMaintenanceContext.Provider>
  ) : (
    content
  );
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.parse.mockReset();
  mocks.fetch.mockReset();
  mocks.export.mockReset().mockResolvedValue(true);
  mocks.desktop = false;
  use.mockReset();
  close.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const imported = () =>
  importProfiles('vless://public@a.example.net:443?security=tls#Public', 'Public source');
it('offers persistent Star buttons on regular outbounds, policy groups and chains', async () => {
  await act(() => root.render(<Harness />));
  await act(() => {
    store.importResult(imported());
    for (const kind of ['policy-group', 'proxy-chain'] as const) {
      const node = makeNode(kind, { x: 0, y: 0 });
      node.data.label = kind === 'policy-group' ? 'Favorite group' : 'Favorite chain';
      const graph = { name: 'Prepared', nodes: [node], edges: [], defaults: factoryDefaults() };
      store.update((current) => putStashEntry(current, snapshotGraphEntry(graph, node)));
    }
  });
  for (const [tab, name] of [
    ['Outbounds', 'Public'],
    ['Policy groups', 'Favorite group'],
    ['Proxy chains', 'Favorite chain'],
  ]) {
    await act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent === tab)!
        .click(),
    );
    const star = container.querySelector<HTMLButtonElement>(`[aria-label="Star ${name}"]`)!;
    expect(star).not.toBeNull();
    await act(() => star.click());
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(
      store
        .get()
        .groups.flatMap((group) => group.entries)
        .find((entry) => entry.name === name)?.starred,
    ).toBe(true);
  }
});
it('keeps both test modes together in the shared toolbar on all three tabs', async () => {
  await act(async () => root.render(<Harness />));
  for (const tab of ['Outbounds', 'Policy groups', 'Proxy chains']) {
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent === tab)!
        .click(),
    );
    const group = container.querySelector('.stash-toolbar > .outbound-test-buttons')!;
    expect(group.closest('.stash-body')).toBeNull();
    expect(group.previousElementSibling?.textContent).toContain('Export stash');
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Test all',
      'Speed test all',
    ]);
  }
});
const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
it('saves an outbound edit after background health refresh without losing its current lock or health', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  // A previously saved outbound has the editor's complete profile representation.
  await act(async () =>
    store.update((current) => {
      const group = current.groups.find((g) => g.name === 'Public source')!,
        entry = group.entries[0];
      const graph = { name: 'Saved', nodes: [], edges: [], defaults: factoryDefaults() };
      const node = stashEditorNode(entry, graph, 'saved-outbound');
      return putStashEntry(
        current,
        snapshotGraphEntry({ ...graph, nodes: [node] }, node, entry.id, entry),
        { groupId: group.id, entryId: entry.id },
      );
    }),
  );
  const group = store.get().groups.find((g) => g.name === 'Public source')!,
    entry = group.entries[0];
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Edit Public from Public source"]')!
      .click(),
  );
  await setValue(container.querySelector<HTMLInputElement>('#node-label')!, 'Renamed');
  const health = {
    status: 'dead' as const,
    checkedAt: 1234,
    profileId: policyProfileId(entry.profile!),
    latencyMs: null,
  };
  await act(async () =>
    store.update((current) => {
      const next = structuredClone(current);
      Object.assign(next.groups.find((g) => g.id === group.id)!.entries[0], {
        locked: true,
        health,
      });
      return next;
    }),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Save to Stash')!
      .click(),
  );
  expect(container.querySelector('.stash-entry-editor')).toBeNull();
  expect(store.get().groups.find((g) => g.id === group.id)!.entries[0]).toMatchObject({
    id: entry.id,
    name: 'Renamed',
    locked: true,
    health,
  });
});
it.each(['changed', 'removed'] as const)(
  'keeps the editor draft when its outbound was %s while open',
  async (action) => {
    await act(async () => root.render(<Harness />));
    await act(async () => store.importResult(imported()));
    const group = store.get().groups.find((g) => g.name === 'Public source')!,
      original = group.entries[0];
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Edit Public from Public source"]')!
        .click(),
    );
    await setValue(container.querySelector<HTMLInputElement>('#node-label')!, 'My draft');
    await act(async () =>
      store.update((current) => ({
        ...current,
        groups: current.groups.map((g) =>
          g.id !== group.id
            ? g
            : {
                ...g,
                entries:
                  action === 'removed'
                    ? []
                    : g.entries.map((e) => ({
                        ...e,
                        profile: {
                          ...e.profile!,
                          settings: { ...e.profile!.settings, address: 'provider-updated.example' },
                        },
                      })),
              },
        ),
      })),
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Save to Stash')!
        .click(),
    );
    expect(container.querySelector('.stash-entry-editor')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('#node-label')!.value).toBe('My draft');
    expect(container.querySelector('.stash-entry-editor [role="alert"]')?.textContent).toMatch(
      /changed|no longer exists/,
    );
    const entries = store.get().groups.find((g) => g.id === group.id)!.entries;
    if (action === 'removed') expect(entries).toHaveLength(0);
    else
      expect(entries[0]).toMatchObject({
        id: original.id,
        name: original.name,
        profile: { settings: { address: 'provider-updated.example' } },
      });
  },
);
it('bounds 50,000 stash entries to 60 visible rows and navigates/searches without widening an action scope', async () => {
  await act(async () => root.render(<Harness />));
  const group = imported().groups[0];
  group.entries = Array.from({ length: 50000 }, (_, i) => ({
    ...group.entries[0],
    id: String(i),
    name: `Node ${String(i).padStart(5, '0')}`,
  }));
  await act(async () =>
    store.importResult({
      groups: [group],
      duplicates: 0,
      rejected: 0,
      problems: [],
    }),
  );
  expect(container.querySelectorAll('.stash-row:not(.stash-header)')).toHaveLength(60);
  await act(async () =>
    (container.querySelector('[aria-label="Stash: last page"]') as HTMLButtonElement).click(),
  );
  expect(container.textContent).toContain('Page 834');
  expect(container.querySelectorAll('.stash-row:not(.stash-header)')).toHaveLength(20);
  await setValue(
    container.querySelector('[aria-label="Search configurations"]') as HTMLInputElement,
    'NODE 49999',
  );
  expect(container.textContent).toContain('1 result');
  expect(container.querySelector('.result-pager button')).toBeNull();
  expect(container.querySelectorAll('.stash-row:not(.stash-header)')).toHaveLength(1);
  const add = container.querySelector(
    '[aria-label="Add Node 49999 from Public source to graph"]',
  ) as HTMLButtonElement;
  await act(async () => add.click());
  expect(use).toHaveBeenCalledExactlyOnceWith(group.entries[49999], false, {
    groupId: group.id,
    entryId: group.entries[49999].id,
  });
});
it('updates only the group selected when the file chooser opened and reports a scoped refresh', async () => {
  await act(async () => root.render(<Harness />));
  const first = imported(),
    second = importProfiles('vless://other@b.example.net:443?security=tls#Other', 'Other source');
  await act(async () => {
    store.importResult(first);
    store.importResult(second);
  });
  const before = store.stash.groups[1],
    untouched = store.stash.groups[2];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    before.id,
  );
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Update group from file…')!
      .click(),
  );
  // The chooser's captured target must not follow a subsequent group selection.
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    untouched.id,
  );
  mocks.parse.mockResolvedValue(
    importProfiles('vless://public@changed.example.net:443?security=tls#Public'),
  );
  const file = container.querySelector('input[type="file"]')!;
  Object.defineProperty(file, 'files', {
    configurable: true,
    value: [
      {
        size: 120,
        name: 'public.txt',
        arrayBuffer: async () => new TextEncoder().encode('public fixture').buffer,
      },
    ],
  });
  await act(async () => file.dispatchEvent(new Event('change', { bubbles: true })));
  expect(store.stash.groups[1].entries[0].id).toBe(before.entries[0].id);
  expect(store.stash.groups[1].entries[0].address).toBe('changed.example.net');
  expect(store.stash.groups[2]).toBe(untouched);
  expect(container.textContent).toContain('updated:');
  expect(container.textContent).toContain('1 updated');
});
it('serializes overlapping import clicks and preserves the existing stash on failure', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  const previous = store.stash;
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Import / add subscription'))!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Paste configurations')!
      .click(),
  );
  const text = container.querySelector(
    'textarea[aria-label="Configurations / subscription content"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      text,
      'public fixture',
    );
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let reject!: (error: Error) => void;
  mocks.parse.mockReturnValue(
    new Promise<ImportResult>((_, r) => {
      reject = r;
    }),
  );
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Import into stash',
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(mocks.parse).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Malformed subscription. Existing group kept.')));
  expect(store.stash).toBe(previous);
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Malformed');
});
it('cancels without changing the stash and ignores a late result while another import runs', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  const previous = store.stash;
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Import / add subscription'))!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Paste configurations')!
      .click(),
  );
  const text = container.querySelector(
    'textarea[aria-label="Configurations / subscription content"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      text,
      'public fixture',
    );
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let finishOld!: (value: ImportResult) => void, finishNew!: (value: ImportResult) => void;
  mocks.parse
    .mockReturnValueOnce(
      new Promise<ImportResult>((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise<ImportResult>((resolve) => {
        finishNew = resolve;
      }),
    );
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Import into stash',
  )!;
  await act(async () => button.click());
  const signal = mocks.parse.mock.calls[0][3] as AbortSignal;
  const event = new Event('cancel', { cancelable: true });
  await act(async () => container.querySelector('dialog')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(store.stash).toBe(previous);
  expect(container.textContent).toContain('Operation cancelled');
  await act(async () => button.click());
  await act(async () => finishOld(imported()));
  expect(button.disabled).toBe(true);
  expect(store.stash).toBe(previous);
  await act(async () =>
    finishNew(importProfiles('vless://other@b.example.net:443?security=tls#Other')),
  );
  expect(store.stash.groups).toHaveLength(3);
  expect(container.textContent).not.toContain('Processing…');
  expect(container.textContent).not.toContain('Cancel operation');
});

it.each([false, true])(
  'restores a removed import action without stealing a moved focus (%s)',
  async (moved) => {
    await act(async () => root.render(<Harness />));
    const trigger = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Import / add subscription'),
    )!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Paste configurations')!
        .click(),
    );
    const text = container.querySelector(
      'textarea[aria-label="Configurations / subscription content"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        text,
        'public fixture',
      );
      text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let finish!: (value: ImportResult) => void;
    mocks.parse.mockReturnValue(
      new Promise<ImportResult>((resolve) => {
        finish = resolve;
      }),
    );
    const action = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Import into stash',
    )!;
    await act(async () => {
      action.focus();
      action.click();
    });
    const other = container.querySelector<HTMLInputElement>(
      '[aria-label="Search configurations"]',
    )!;
    if (moved) await act(async () => other.focus());
    await act(async () => finish(imported()));
    expect(container.contains(action)).toBe(false);
    expect(document.activeElement).toBe(moved ? other : trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  },
);

const action = (label: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!;
it('reveals a subscription URL for focused editing and selection, then masks it without changing its value', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub/public-token';
  await act(async () => store.importResult(result));
  const original = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    original.id,
  );
  await act(async () => action('Subscription settings…').click());
  const input = container.querySelector<HTMLInputElement>('.stash-subscription input')!;
  expect(input.type).toBe('password');
  await act(async () => input.focus());
  expect(input.type).toBe('text');
  expect(document.activeElement).toBe(input);
  await act(async () => input.select());
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(original.url.length);
  expect(input.type).toBe('text');
  await act(async () => input.blur());
  expect(input.type).toBe('password');
  expect(input.value).toBe(original.url);
  await act(async () => input.focus());
  const changed = 'https://public.example.net/sub/edited-token';
  await setValue(input, changed);
  await act(async () => action('Save settings').click());
  expect(store.stash.groups[1]).toEqual({ ...original, url: changed });
  expect(store.stash.groups[1].entries).toBe(original.entries);
  expect(mocks.parse).not.toHaveBeenCalled();
});
it.each([false, true])(
  'renames URL and file groups without replacing their identity, settings or configurations (%s)',
  async (subscription) => {
    await act(async () => root.render(<Harness />));
    const result = imported();
    if (subscription) result.groups[0].url = 'https://public.example.net/sub/public-token';
    result.groups[0].updatedAt = 1234567890000;
    await act(async () => store.importResult(result));
    const original = store.stash.groups[1];
    await setValue(
      container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
      original.id,
    );
    const trigger = action('Subscription settings…');
    await act(async () => trigger.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Group name"]')!;
    expect(document.activeElement).toBe(input);
    await setValue(input, '  ');
    expect(action('Save settings').disabled).toBe(true);
    await setValue(input, '  Friendly group  ');
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(store.stash.groups[1]).toEqual({
      ...original,
      name: 'Friendly group',
    });
    expect(store.stash.groups[1].entries).toBe(original.entries);
    expect((container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement).value).toBe(
      original.id,
    );
    expect(container.querySelector('.stash-row:not(.stash-header)')!.textContent).toContain(
      'Friendly group',
    );
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.parse).not.toHaveBeenCalled();
    await setValue(
      container.querySelector('[aria-label="Search configurations"]') as HTMLInputElement,
      'Friendly group',
    );
    expect(container.querySelectorAll('.stash-row:not(.stash-header)')).toHaveLength(1);
  },
);
it('cancels a group rename with Escape without closing the stash or saving the draft', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  const original = store.stash;
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    original.groups[1].id,
  );
  await act(async () => action('Subscription settings…').click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Group name"]')!;
  await setValue(input, 'Cancelled draft');
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(container.querySelector('dialog')!.open).toBe(true);
  expect(store.stash).toBe(original);
  expect(container.querySelector('form')).toBeNull();
  expect(document.activeElement).toBe(action('Subscription settings…'));
});

it('saves name, download and maintenance changes together without fetching or losing entries', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub/public-token';
  await act(async () => store.importResult(result));
  const original = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    original.id,
  );
  await act(async () => action('Subscription settings…').click());
  const url = container.querySelector<HTMLInputElement>('.stash-subscription input')!;
  await setValue(url, 'https://public.example.net/sub/draft-token');
  await setValue(
    container.querySelector('[aria-label="Group name"]') as HTMLInputElement,
    'Friendly subscription',
  );
  await setValue(
    container.querySelector('.stash-subscription select') as HTMLSelectElement,
    'proxy',
  );
  const remove = container.querySelector<HTMLInputElement>(
    '.subscription-health-fields input[type=checkbox]',
  )!;
  await act(async () => remove.click());
  expect(store.stash.groups[1]).toBe(original);
  await act(async () => action('Save settings').click());
  expect(store.stash.groups[1]).toEqual({
    ...original,
    name: 'Friendly subscription',
    url: 'https://public.example.net/sub/draft-token',
    maintenance: { ...maintenanceDefaults, viaProxy: true, removeUnreachable: true },
    lastTestAt: undefined,
    testCycleAt: undefined,
  });
  expect(store.stash.groups[1].entries).toBe(original.entries);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('starts in URL mode and retains a selected retryable group when Add & download fails', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Import / add subscription'))!
      .click(),
  );
  expect(action('Subscription URL').getAttribute('aria-pressed')).toBe('true');
  expect(
    container.querySelector('textarea[aria-label="Configurations / subscription content"]'),
  ).toBeNull();
  const input = container.querySelector<HTMLInputElement>('.stash-subscription input')!;
  await setValue(input, 'https://public.example.net/test-subscription');
  await act(async () => action('Add & download').click());
  expect(store.stash.groups).toHaveLength(2);
  expect(store.stash.groups[1]).toMatchObject({
    url: 'https://public.example.net/test-subscription',
    entries: [],
  });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Stash group"]')!.value).toBe(
    store.stash.groups[1].id,
  );
  expect(container.textContent).toContain('Download subscriptions in the Windows app');
  expect(container.querySelector('.stash-import')).toBeNull();
  expect(mocks.parse).not.toHaveBeenCalled();
});

it('uses a single explicit Replace action with a selected executable profile and closes only on success', async () => {
  await act(async () => root.render(<Harness replace />));
  const importedGroup = imported().groups[0];
  const bad = {
    ...importedGroup.entries[0],
    id: 'bad',
    profile: null,
    problem: 'Unsupported',
  };
  await act(async () =>
    store.importResult({
      groups: [{ ...importedGroup, entries: [...importedGroup.entries, bad] }],
      duplicates: 0,
      rejected: 0,
      problems: [],
    }),
  );
  const replacementButton = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Replace',
  )!;
  expect(
    [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Replace'),
  ).toHaveLength(1);
  expect((replacementButton as HTMLButtonElement).disabled).toBe(true);
  const choices = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(choices[1].disabled).toBe(true);
  await act(async () => choices[0].click());
  expect(use).not.toHaveBeenCalled();
  expect(container.querySelector('.stash-replacement-summary')?.textContent).toContain(
    'Selected destination with Public',
  );
  use.mockImplementationOnce(() => {
    throw new Error('Target was removed.');
  });
  await act(async () => replacementButton.click());
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Target was removed.');
  await act(async () => replacementButton.click());
  expect(use).toHaveBeenLastCalledWith(importedGroup.entries[0], true, {
    groupId: importedGroup.id,
    entryId: importedGroup.entries[0].id,
  });
  expect(close).toHaveBeenCalledOnce();
});

it('does not follow an identically named/id profile in another group when the chosen entry disappears', async () => {
  await act(async () => root.render(<Harness replace />));
  const first = imported().groups[0];
  const other = {
    ...first,
    id: 'other-group',
    name: 'Other source',
    entries: [{ ...first.entries[0], address: 'other.example.net' }],
  };
  await act(async () =>
    store.importResult({
      groups: [first, other],
      duplicates: 0,
      rejected: 0,
      problems: [],
    }),
  );
  await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await act(async () =>
    store.update((current) => ({
      ...current,
      groups: current.groups.filter((g) => g.id !== first.id),
    })),
  );
  const replacement = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Replace',
  )!;
  expect(replacement.disabled).toBe(true);
  await act(async () => replacement.click());
  expect(use).not.toHaveBeenCalled();
});

it('downloads a newly added URL group once and commits into its normalized identity', async () => {
  await act(async () => root.render(<Harness />));
  mocks.desktop = true;
  mocks.fetch.mockResolvedValue('public subscription');
  mocks.parse.mockResolvedValue(imported());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Import / add subscription'))!
      .click(),
  );
  await setValue(
    container.querySelector<HTMLInputElement>('.stash-subscription input')!,
    'https://public.example.net/sub',
  );
  await act(async () => action('Add & download').click());
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(store.stash.groups).toHaveLength(2);
  expect(store.stash.groups[1].entries).toHaveLength(1);
  expect(store.stash.groups[1].updatedAt).not.toBeNull();
  expect(container.textContent).not.toContain('changed while');
  expect(container.textContent).not.toContain('Subscription group added');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('has one settings entry point and discards all edits together on Cancel', async () => {
  await act(async () => root.render(<Harness />));
  const group = imported().groups[0];
  group.url = 'https://public.example.net/sub';
  group.maintenance = {
    autoRefresh: true,
    refreshMinutes: 60,
    removeUnreachable: true,
    maxRetries: 2,
    viaProxy: false,
  };
  await act(async () =>
    store.importResult({ groups: [group], duplicates: 0, rejected: 0, problems: [] }),
  );
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  const original = store.stash;
  expect(action('Maintenance…')).toBeUndefined();
  expect(action('Edit subscription')).toBeUndefined();
  expect(action('Rename group…')).toBeUndefined();
  await act(async () => action('Subscription settings…').click());
  const panel = container.querySelector('[aria-label="Subscription settings"]')!;
  expect(container.querySelectorAll('.stash-subscription select')).toHaveLength(1);
  const retry = [...panel.querySelectorAll<HTMLLabelElement>('label')]
    .find((label) => label.textContent?.includes('Max retries'))!
    .querySelector('input')!;
  await setValue(retry, '');
  expect(action('Save settings').disabled).toBe(true);
  await setValue(retry, '5');
  await setValue(panel.querySelector('.stash-subscription select') as HTMLSelectElement, 'proxy');
  await act(async () => action('Cancel').click());
  expect(store.stash).toBe(original);
  await act(async () => action('Subscription settings…').click());
  const fresh = container.querySelector('[aria-label="Subscription settings"]')!;
  expect((fresh.querySelector('.stash-subscription select') as HTMLSelectElement).value).toBe(
    'direct',
  );
  expect(
    [...fresh.querySelectorAll('input')].find(
      (input) => input.type === 'number' && input.max === '5',
    )!.value,
  ).toBe('2');
});

it('does not leave an invisible invalid field after switching off health testing', async () => {
  await act(async () => root.render(<Harness />));
  const group = imported().groups[0];
  group.maintenance = {
    autoRefresh: false,
    refreshMinutes: 60,
    removeUnreachable: true,
    maxRetries: 2,
    viaProxy: false,
  };
  await act(async () =>
    store.importResult({ groups: [group], duplicates: 0, rejected: 0, problems: [] }),
  );
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  await act(async () => action('Subscription settings…').click());
  const panel = container.querySelector('[aria-label="Subscription settings"]')!;
  const retry = [...panel.querySelectorAll<HTMLLabelElement>('label')]
    .find((label) => label.textContent?.includes('Max retries'))!
    .querySelector('input')!;
  await setValue(retry, '');
  await act(async () =>
    panel
      .querySelector<HTMLInputElement>('.subscription-health-fields input[type=checkbox]')!
      .click(),
  );
  const save = panel.querySelector<HTMLButtonElement>('.primary-button')!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(store.stash.groups.find((g) => g.id === group.id)?.maintenance).toMatchObject({
    removeUnreachable: false,
    maxRetries: 2,
  });
});

it('retains independent download routes in each group settings editor', async () => {
  await act(async () => root.render(<Harness />));
  const first = imported().groups[0],
    second = { ...first, id: 'second', name: 'Second' };
  first.url = 'https://public.example.net/one';
  second.url = 'https://public.example.net/two';
  await act(async () =>
    store.importResult({ groups: [first, second], duplicates: 0, rejected: 0, problems: [] }),
  );
  const choose = (id: string) =>
    setValue(container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement, id);
  await choose(first.id);
  await act(async () => action('Subscription settings…').click());
  await setValue(
    container.querySelector('.stash-subscription select') as HTMLSelectElement,
    'proxy',
  );
  await act(async () => action('Save settings').click());
  expect(store.stash.groups.find((group) => group.id === first.id)?.maintenance?.viaProxy).toBe(
    true,
  );
  expect(container.querySelector('.stash-subscription select')).toBeNull();
  expect(container.querySelector('.stash-download-options')).toBeNull();
  await choose(second.id);
  await act(async () => action('Subscription settings…').click());
  expect((container.querySelector('.stash-subscription select') as HTMLSelectElement).value).toBe(
    'direct',
  );
  await act(async () => action('Cancel').click());
  await choose(first.id);
  await act(async () => action('Subscription settings…').click());
  expect((container.querySelector('.stash-subscription select') as HTMLSelectElement).value).toBe(
    'proxy',
  );
});
it('refreshes the latest group snapshot after foreground handoff applies completed background metadata', async () => {
  async function withForeground<T>(action: () => T | Promise<T>) {
    store.update((stash) => ({
      ...stash,
      groups: stash.groups.map((group) => ({
        ...group,
        entries: group.entries.map((entry) => ({ ...entry, locked: true })),
      })),
    }));
    return action();
  }
  const maintenance: SubscriptionMaintenanceController = {
    appliedRevision: null,
    appliedSourceHash: null,
    statuses: {},
    cancelAutomatic: vi.fn(),
    clearStatus: vi.fn(),
    run: serviceRun,
    cancel: vi.fn(),
    withForeground,
    foregroundBusy: false,
    available: true,
  };
  await act(async () => root.render(<Harness maintenance={maintenance} />));
  const group = imported().groups[0];
  group.url = 'https://public.example.net/sub';
  await act(async () =>
    store.importResult({ groups: [group], duplicates: 0, rejected: 0, problems: [] }),
  );
  mocks.desktop = true;
  mocks.fetch.mockResolvedValue('public subscription');
  mocks.parse.mockResolvedValue(imported());
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Refresh group'))!
      .click(),
  );
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(store.stash.groups.find((g) => g.id === group.id)?.entries[0].locked).toBe(true);
});

it('focuses unified settings and returns focus to its trigger on Cancel', async () => {
  await act(async () => root.render(<Harness />));
  const group = imported().groups[0];
  await act(async () =>
    store.importResult({ groups: [group], duplicates: 0, rejected: 0, problems: [] }),
  );
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  const trigger = action('Subscription settings…');
  await act(async () => trigger.click());
  const panel = container.querySelector('[aria-label="Subscription settings"]')!;
  expect(panel.contains(document.activeElement)).toBe(true);
  await act(async () =>
    [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Cancel')!
      .click(),
  );
  expect(document.activeElement).toBe(trigger);
});

it('preserves refreshed entries and locks while saving open group settings', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub';
  await act(async () => store.importResult(result));
  const group = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  await act(async () => action('Subscription settings…').click());
  await setValue(
    container.querySelector('[aria-label="Group name"]') as HTMLInputElement,
    'Edited name',
  );
  await act(async () =>
    store.update((stash) => ({
      ...stash,
      groups: stash.groups.map((g) =>
        g.id === group.id
          ? {
              ...g,
              updatedAt: 1234567890000,
              entries: g.entries.map((entry) => ({
                ...entry,
                locked: true,
                address: 'new.example.net',
              })),
            }
          : g,
      ),
    })),
  );
  const latest = store.stash.groups[1];
  await act(async () => action('Save settings').click());
  expect(store.stash.groups[1]).toEqual({ ...latest, name: 'Edited name' });
  expect(store.stash.groups[1].entries).toBe(latest.entries);
});

it('cannot recreate a removed subscription when saving its open draft', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  const group = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    group.id,
  );
  await act(async () => action('Subscription settings…').click());
  await act(async () =>
    store.update((stash) => ({ ...stash, groups: stash.groups.filter((g) => g.id !== group.id) })),
  );
  const before = store.stash;
  await act(async () => action('Save settings').click());
  expect(store.stash).toBe(before);
  expect(
    container.querySelector('[aria-label="Subscription settings"] [role="alert"]')?.textContent,
  ).toContain('no longer exists');
  expect(container.querySelector('[aria-label="Group name"]')).not.toBeNull();
});

it('reveals advanced request errors and retains their draft for correction', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.stash-toolbar .primary-button')!.click(),
  );
  await setValue(
    container.querySelector('.stash-subscription input') as HTMLInputElement,
    'http://public.example.net/sub',
  );
  await act(async () => action('Add & download').click());
  const details = container.querySelector<HTMLDetailsElement>('.subscription-request-settings')!;
  expect(details.open).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Allow unencrypted HTTP',
  );
  const allow = details.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => allow.click());
  const headers = details.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      headers,
      '{"Header": 1}',
    );
    headers.dispatchEvent(new Event('input', { bubbles: true }));
    details.open = false;
  });
  await act(async () => action('Add & download').click());
  expect(details.open).toBe(true);
  expect(headers.value).toBe('{"Header": 1}');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('text values');
  expect(store.stash.groups).toHaveLength(1);
});

it('can clear a subscription URL without a hidden invalid refresh field blocking Save', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub';
  result.groups[0].maintenance = { ...maintenanceDefaults, autoRefresh: true };
  await act(async () => store.importResult(result));
  const original = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    original.id,
  );
  await act(async () => action('Subscription settings…').click());
  await setValue(
    container.querySelector(
      '.subscription-refresh-fields input[type="number"]',
    ) as HTMLInputElement,
    '',
  );
  expect(action('Save settings').disabled).toBe(true);
  await setValue(container.querySelector('.stash-subscription input') as HTMLInputElement, '');
  expect(action('Save settings').disabled).toBe(false);
  await act(async () => action('Save settings').click());
  expect(store.stash.groups[1].url).toBe('');
  expect(store.stash.groups[1].maintenance?.autoRefresh).toBe(false);
  expect(store.stash.groups[1].entries).toBe(original.entries);
});

const selectTab = async (label: string) =>
  act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.trim() === label)!
      .click(),
  );
async function groupAction(group: string, label: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[aria-label="More actions for ${group}"]`)!.click(),
  );
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.trim() === label,
  )!;
  await act(async () => item.click());
}

it('never mounts duplicate settings dialogs after visiting the other Stash tabs', async () => {
  await act(async () => root.render(<Harness />));
  for (const tab of ['Policy groups', 'Proxy chains', 'Subscriptions', 'Outbounds'])
    await selectTab(tab);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.stash-toolbar .primary-button')!.click(),
  );
  expect(container.querySelectorAll('.subscription-settings-window')).toHaveLength(1);
  expect(container.querySelectorAll('[aria-label="Group name"]')).toHaveLength(1);
  expect(container.querySelectorAll('[aria-label="Stash group"]')).toHaveLength(1);
});

it('reveals a new import even when the library was filtered to a different group and supported configurations', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => store.importResult(imported()));
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    store.stash.groups[1].id,
  );
  await setValue(
    container.querySelector('[aria-label="Search configurations"]') as HTMLInputElement,
    'does-not-match',
  );
  await setValue(
    container.querySelector('[aria-label="Configuration type"]') as HTMLSelectElement,
    'available',
  );
  mocks.parse.mockResolvedValue(importProfiles('socks://new.example:1080#New', 'New provider'));
  const input = container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [
      {
        size: 50,
        name: 'new.txt',
        arrayBuffer: async () => new TextEncoder().encode('new source').buffer,
      },
    ],
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  const added = store.stash.groups.at(-1)!;
  expect((container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement).value).toBe(
    added.id,
  );
  expect(
    (container.querySelector('[aria-label="Search configurations"]') as HTMLInputElement).value,
  ).toBe('');
  expect(
    (container.querySelector('[aria-label="Configuration type"]') as HTMLSelectElement).value,
  ).toBe('all');
  expect(container.querySelector('.stash-row:not(.stash-header)')?.textContent).toContain('New');
});

it('warns before creating a duplicate source and permits an explicitly separate group', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub';
  await act(async () => store.importResult(result));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.stash-toolbar .primary-button')!.click(),
  );
  await setValue(
    container.querySelector('.stash-subscription input') as HTMLInputElement,
    ' https://PUBLIC.example.net:443/sub ',
  );
  expect(container.querySelector('.subscription-duplicate')?.textContent).toContain(
    'Public source',
  );
  expect(action('Add & download').disabled).toBe(true);
  await act(async () =>
    container.querySelector<HTMLInputElement>('.subscription-duplicate input')!.click(),
  );
  expect(action('Add & download').disabled).toBe(false);
  await act(async () => action('Add & download').click());
  expect(store.stash.groups).toHaveLength(3);
  expect(store.stash.groups[2].url).toBe('https://PUBLIC.example.net:443/sub');
});

it('saves edited source settings before refreshing and retains profiles when the new download fails', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/old';
  await act(async () => store.importResult(result));
  const original = store.stash.groups[1];
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    original.id,
  );
  await act(async () => action('Subscription settings…').click());
  await setValue(
    container.querySelector('.stash-subscription input') as HTMLInputElement,
    'https://public.example.net/new',
  );
  mocks.desktop = true;
  mocks.fetch.mockRejectedValue(new Error('Provider unavailable'));
  await act(async () => action('Save & refresh').click());
  expect(store.stash.groups[1].url).toBe('https://public.example.net/new');
  expect(store.stash.groups[1].entries).toBe(original.entries);
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
    'subscriptions.run',
    expect.objectContaining({ groupId: original.id, operation: 'refresh' }),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider unavailable');
});

it('pauses and resumes a group without replacing settings or locked entries', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub';
  result.groups[0].maintenance = {
    ...maintenanceDefaults,
    autoRefresh: true,
    removeUnreachable: true,
  };
  result.groups[0].entries[0].locked = true;
  await act(async () => store.importResult(result));
  const original = store.stash.groups[1];
  await selectTab('Subscriptions');
  await groupAction('Public source', 'Pause automatic maintenance');
  expect(store.stash.groups[1].maintenancePaused).toBe(true);
  expect(store.stash.groups[1].maintenance).toBe(original.maintenance);
  expect(store.stash.groups[1].entries).toBe(original.entries);
  await groupAction('Public source', 'Resume automatic maintenance');
  expect(store.stash.groups[1].maintenancePaused).toBe(false);
});

it('removes the group chosen in the overview rather than the unrelated library selection', async () => {
  await act(async () => root.render(<Harness />));
  const first = imported().groups[0],
    second = { ...first, id: 'second', name: 'Other provider' };
  await act(async () =>
    store.importResult({ groups: [first, second], duplicates: 0, rejected: 0, problems: [] }),
  );
  await setValue(
    container.querySelector('[aria-label="Stash group"]') as HTMLSelectElement,
    first.id,
  );
  await selectTab('Subscriptions');
  await groupAction('Other provider', 'Remove group…');
  expect(container.querySelector('.stash-remove-confirmation')?.textContent).toContain(
    'Other provider',
  );
  await act(async () => action('Remove group').click());
  expect(store.stash.groups.some((group) => group.id === first.id)).toBe(true);
  expect(store.stash.groups.some((group) => group.id === second.id)).toBe(false);
});

it('exports just the chosen group, including its pause and lock metadata', async () => {
  await act(async () => root.render(<Harness />));
  const first = imported().groups[0],
    second = { ...first, id: 'second', name: 'Export this', maintenancePaused: true };
  second.entries = [{ ...first.entries[0], locked: true }];
  await act(async () =>
    store.importResult({ groups: [first, second], duplicates: 0, rejected: 0, problems: [] }),
  );
  await selectTab('Subscriptions');
  await groupAction('Export this', 'Export group…');
  expect(mocks.export).toHaveBeenCalledOnce();
  const { parseStash } = await import('../profiles/import');
  const exported = parseStash(mocks.export.mock.calls[0][1]);
  expect(exported.groups).toHaveLength(1);
  expect(exported.groups[0]).toEqual(second);
});

it('bounds a 499-provider, 49,900-entry overview to 30 rows and searches without changing groups', async () => {
  await act(async () => root.render(<Harness />));
  const source = imported().groups[0];
  const groups = Array.from({ length: 499 }, (_, i) => ({
    ...source,
    id: `provider-${i}`,
    name: `Provider ${String(i).padStart(3, '0')}`,
    entries: Array.from({ length: 100 }, (_, j) => ({ ...source.entries[0], id: `entry-${j}` })),
  }));
  await act(async () => store.importResult({ groups, duplicates: 0, rejected: 0, problems: [] }));
  await selectTab('Subscriptions');
  expect(container.querySelectorAll('.subscription-group-row')).toHaveLength(30);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Subscription groups: last page"]')!
      .click(),
  );
  expect(container.querySelectorAll('.subscription-group-row')).toHaveLength(19);
  await setValue(
    container.querySelector('[aria-label="Find subscription group"]') as HTMLInputElement,
    'Provider 498',
  );
  expect(container.querySelectorAll('.subscription-group-row')).toHaveLength(1);
  expect(container.querySelector('.subscription-group-name')?.textContent).toBe('Provider 498');
  expect(store.stash.groups).toHaveLength(500);
});

it('clears an irrelevant URL error when switching to pasted configurations', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.stash-toolbar .primary-button')!.click(),
  );
  await setValue(
    container.querySelector('.stash-subscription input') as HTMLInputElement,
    'http://public.example.net/sub',
  );
  await act(async () => action('Add & download').click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => action('Paste configurations').click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('refreshes all URL groups, includes explicitly requested paused groups, and retains a failed source', async () => {
  await act(async () => root.render(<Harness />));
  const base = imported().groups[0];
  const groups = ['Good', 'Failed', 'Paused', 'Manual'].map((name) => ({
    ...base,
    id: name,
    name,
    url: name === 'Manual' ? '' : `https://${name.toLowerCase()}.example/sub`,
    maintenancePaused: name === 'Paused',
  }));
  await act(async () => store.importResult({ groups, duplicates: 0, rejected: 0, problems: [] }));
  const failed = store.stash.groups.find((group) => group.id === 'Failed')!;
  mocks.desktop = true;
  mocks.fetch.mockImplementation(async (_method, args) => {
    if (args.groupId === 'Failed') throw new Error('Provider down');
    return 'updated';
  });
  mocks.parse.mockResolvedValue(imported());
  await selectTab('Subscriptions');
  await act(async () => action('Refresh all').click());
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
  expect(store.stash.groups.find((group) => group.id === 'Failed')).toBe(failed);
  expect(container.textContent).toContain('2 groups updated · 1 failed');
  const row = [...container.querySelectorAll('.subscription-group-row')].find(
    (value) => value.querySelector('.subscription-group-name')?.textContent === 'Failed',
  )!;
  expect(row.textContent).toContain('Provider down');
});

it('lets intentionally duplicate sources be renamed without re-acknowledging an unchanged URL', async () => {
  await act(async () => root.render(<Harness />));
  const first = imported().groups[0];
  first.url = 'https://public.example.net/sub';
  const second = { ...first, id: 'intentional-copy', name: 'Separate network' };
  await act(async () =>
    store.importResult({ groups: [first, second], duplicates: 0, rejected: 0, problems: [] }),
  );
  await selectTab('Subscriptions');
  const row = [...container.querySelectorAll('.subscription-group-row')].find(
    (row) => row.querySelector('.subscription-group-name')?.textContent === 'Separate network',
  )!;
  await act(async () =>
    [...row.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Settings…')!
      .click(),
  );
  await setValue(
    container.querySelector('[aria-label="Group name"]') as HTMLInputElement,
    'Renamed source',
  );
  expect(container.querySelector('.subscription-duplicate')).toBeNull();
  expect(action('Save settings').disabled).toBe(false);
  await act(async () => action('Save settings').click());
  expect(store.stash.groups.find((group) => group.id === second.id)?.name).toBe('Renamed source');
});

it('reports the same provider count in both library and overview, excluding manual Default', async () => {
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('.stash-toolbar > span')?.textContent).toContain(
    '0 subscription groups',
  );
  await act(async () => store.importResult(imported()));
  expect(container.querySelector('.stash-toolbar > span')?.textContent).toContain(
    '1 subscription group',
  );
  await selectTab('Subscriptions');
  expect(container.querySelector('.stash-toolbar > span')?.textContent).toBe(
    '1 subscription group',
  );
});

it('clears a previous action error after successful export while retaining the provider failure', async () => {
  await act(async () => root.render(<Harness />));
  const result = imported();
  result.groups[0].url = 'https://public.example.net/sub';
  await act(async () => store.importResult(result));
  mocks.desktop = true;
  mocks.fetch.mockRejectedValue(new Error('Source timeout'));
  await selectTab('Subscriptions');
  await act(async () => action('Refresh').click());
  expect(container.querySelector('.notice--error')?.textContent).toContain('Source timeout');
  await groupAction('Public source', 'Export group…');
  expect(container.querySelector('.notice--error')).toBeNull();
  expect(container.querySelector('.stash-problem')?.textContent).toContain('Source timeout');
  expect(container.textContent).toContain('Public source exported');
});
