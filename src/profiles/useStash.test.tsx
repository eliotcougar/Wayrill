// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useStash from './useStash';
import { importProfiles, serializeStash, type Stash } from './import';
const storage = vi.hoisted(() => ({
  available: false,
  read: vi.fn(),
  write: vi.fn(),
  parse: vi.fn(),
  prepare: vi.fn(),
  merge: vi.fn(),
  save: vi.fn(),
  change: undefined as
    ((change: { base: string; text: string }) => void | Promise<void>) | undefined,
}));
vi.mock('../protectedStorage', () => ({
  protectedStorageAvailable: () => storage.available,
  protectedRead: storage.read,
  protectedWrite: storage.write,
}));
vi.mock('./importClient', () => ({
  parseImport: storage.parse,
  prepareImport: storage.prepare,
  mergeServiceStash: storage.merge,
}));
vi.mock('./serviceSubscriptions', () => ({
  writeServiceStash: storage.save,
  subscribeLibrary: (listener: NonNullable<typeof storage.change>) => {
    storage.change = listener;
    return () => {
      storage.change = undefined;
    };
  },
}));
let root: Root, latest: ReturnType<typeof useStash>;
function Harness() {
  latest = useStash();
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  storage.available = false;
  storage.read.mockReset();
  storage.write.mockReset();
  storage.parse.mockReset();
  storage.prepare.mockReset();
  storage.merge.mockReset();
  storage.save.mockReset();
  storage.change = undefined;
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
const result = () => importProfiles('vless://public@a.example.net:443?security=tls#Public');
it('flushes the latest shared edit before a replacement even before the next render', async () => {
  await act(async () => root.render(<Harness />));
  const definition = result();
  storage.save.mockResolvedValue(undefined);
  await act(async () => {
    const current = latest.importResult(definition);
    await latest.flush();
    expect(storage.save).toHaveBeenCalledWith(serializeStash(current), '');
  });
});
it('keeps a corrupt protected stash unwritable after a worker rejection', async () => {
  storage.available = true;
  storage.read.mockResolvedValue('bad payload');
  storage.parse.mockRejectedValue(new Error('Unsupported stash file.'));
  await act(async () => root.render(<Harness />));
  expect(latest.ready).toBe(false);
  expect(latest.error).toMatch(/Unsupported stash/);
  expect(storage.write).not.toHaveBeenCalled();
  expect(() => latest.update((s) => s)).toThrow(/not available/);
});

it('does not overwrite a newer library edit or commit an aborted prepared refresh', async () => {
  await act(async () => root.render(<Harness />));
  let complete!: (value: import('./refreshPreparation').PreparedRefresh) => void;
  storage.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const before = latest.stash,
    controller = new AbortController();
  const { prepareRefresh } = await import('./refreshPreparation');
  const prepared = prepareRefresh({
    text: 'socks://example.net:1080#Public',
    name: 'Public',
    stash: before,
  });
  let pending!: Promise<unknown>;
  await act(() => {
    pending = latest.importText('fixture', 'Public', undefined, controller.signal);
  });
  const rejected = expect(pending).rejects.toThrow(/stash changed/);
  await act(() =>
    latest.update((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, name: 'Edited' })) })),
  );
  await act(() => complete(prepared));
  await rejected;
  expect(latest.stash.groups[0].name).toBe('Edited');
  const current = latest.stash;
  await act(() => {
    pending = latest.importText('fixture', 'Public', undefined, controller.signal);
  });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await act(() => complete(prepared));
  await cancelled;
  expect(latest.stash).toBe(current);
});

it('autosaves the matching renderer base while a newer service merge is pending', async () => {
  vi.useFakeTimers();
  storage.available = true;
  storage.write.mockResolvedValue(undefined);
  const original: Stash = { format: 'wayrill.stash', version: 3, groups: result().groups };
  const base = serializeStash(original);
  storage.read.mockResolvedValue(base);
  storage.parse.mockResolvedValue(result());
  // Preserve fixture identities between the on-load result and the saved text.
  storage.parse.mockResolvedValue({ ...result(), groups: original.groups });
  await act(async () => root.render(<Harness />));
  const remote = structuredClone(original);
  remote.groups[0].entries.push({ ...remote.groups[0].entries[0], id: 'new-server' });
  const remoteText = serializeStash(remote);
  let complete!: (value: { groups: Stash['groups'] }) => void;
  storage.merge.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  let delivery!: void | Promise<void>;
  await act(() => {
    delivery = storage.change!({ base, text: remoteText });
  });
  await act(() =>
    latest.update((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, name: 'Local name' })),
    })),
  );
  await act(() => vi.advanceTimersByTimeAsync(350));
  expect(storage.write).toHaveBeenLastCalledWith('stash', latest.serialize(), base);
  const merged = structuredClone(remote);
  merged.groups[0].name = 'Local name';
  await act(async () => {
    complete({ groups: merged.groups });
    await delivery;
  });
  expect(latest.stash.groups[0].entries).toHaveLength(2);
  await act(() => vi.advanceTimersByTimeAsync(350));
  expect(storage.write).toHaveBeenLastCalledWith('stash', latest.serialize(), remoteText);
});

it('settles an outstanding service acknowledgement when the Stash unmounts', async () => {
  storage.available = true;
  const parsed = result();
  const base = serializeStash({ format: 'wayrill.stash', version: 3, groups: parsed.groups });
  storage.read.mockResolvedValue(base);
  storage.parse.mockResolvedValue(parsed);
  let complete!: (value: { groups: Stash['groups'] }) => void;
  storage.merge.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await act(async () => root.render(<Harness />));
  let delivery!: void | Promise<void>;
  await act(() => {
    delivery = storage.change!({ base, text: 'newer service data' });
  });
  await act(() => root.unmount());
  complete({ groups: parsed.groups });
  await delivery;
  expect(latest.getBase()).toBe(base);
  expect(storage.change).toBeUndefined();
});
