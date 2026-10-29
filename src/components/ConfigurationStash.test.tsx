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
import { policyProfileId } from '../graph/profileIdentity';
import { stashEditorNode, snapshotGraphEntry } from '../profiles/workspace';
import { putStashEntry } from '../profiles/stashModel';
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

const action = (label: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!;

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
