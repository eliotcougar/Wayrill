import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  restore: vi.fn(),
  checkpoint: false,
}));
vi.mock('./profiles/serviceSubscriptions', () => ({
  readServiceStash: mock.read,
  restoreServiceStash: mock.restore,
  writeServiceStash: mock.write,
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (name: string, args?: { key: string }) =>
    name === 'protected_read' && args?.key === 'restore' && !mock.checkpoint
      ? Promise.resolve(null)
      : mock.invoke(name, args),
}));
let protectedWrite: typeof import('./protectedStorage').protectedWrite;
let protectedRead: typeof import('./protectedStorage').protectedRead;

beforeEach(async () => {
  mock.invoke.mockReset();
  mock.read.mockReset();
  mock.write.mockReset();
  mock.restore.mockReset();
  mock.checkpoint = false;
  vi.resetModules();
  ({ protectedWrite, protectedRead } = await import('./protectedStorage'));
});
describe('serialized protected writes', () => {
  it('does not let a failed workspace write prevent the next workspace save', async () => {
    mock.invoke
      .mockRejectedValueOnce(new Error('fictional disk failure'))
      .mockResolvedValue(undefined);
    const failed = protectedWrite('workspace', 'old');
    const next = protectedWrite('workspace', 'new');
    await expect(failed).rejects.toThrow('disk failure');
    await next;
    expect(mock.invoke.mock.calls.map(([, p]) => p.key)).toEqual(['workspace', 'workspace']);
  });
});

it('writes a reverted draft after an older write finishes instead of mistaking it for saved content', async () => {
  let complete!: () => void;
  mock.invoke
    .mockResolvedValueOnce('initial')
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  await protectedRead('workspace');
  const first = protectedWrite('workspace', 'edited');
  const reverted = protectedWrite('workspace', 'initial');
  await Promise.resolve();
  await Promise.resolve();
  complete();
  await Promise.all([first, reverted]);
  expect(mock.invoke.mock.calls.map(([name, p]) => [name, p.text])).toEqual([
    ['protected_read', undefined],
    ['protected_write', 'edited'],
    ['protected_write', 'initial'],
  ]);
});

it('does not cache a failed write and serializes reads behind pending writes', async () => {
  mock.invoke
    .mockRejectedValueOnce(new Error('disk failure'))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce('retry');
  await expect(protectedWrite('workspace', 'retry')).rejects.toThrow('disk failure');
  const write = protectedWrite('workspace', 'retry');
  const read = protectedRead('workspace');
  await write;
  expect(await read).toBe('retry');
  expect(mock.invoke.mock.calls.map(([name]) => name)).toEqual([
    'protected_write',
    'protected_write',
    'protected_read',
  ]);
});
it('migrates the user library once without deleting the recovery copy', async () => {
  mock.read.mockResolvedValueOnce(null).mockResolvedValueOnce('migrated');
  mock.invoke.mockResolvedValueOnce('legacy');
  mock.write.mockResolvedValue(undefined);
  expect(await protectedRead('stash')).toBe('migrated');
  expect(mock.write).toHaveBeenCalledWith('legacy');
  expect(mock.invoke.mock.calls).toEqual([['protected_read', { key: 'stash' }]]);
});
it('does not suppress a deliberate Stash revert after an external service update', async () => {
  mock.read.mockResolvedValue('original');
  await protectedRead('stash');
  // Service-owned subscriptions can change without a protectedWrite call. The
  // service client performs the versioned merge and owns its own current base.
  mock.write.mockResolvedValue(undefined);
  await protectedWrite('stash', 'original');
  expect(mock.write).toHaveBeenCalledWith('original', undefined);
});

it('resumes the same Stash commit after an interruption before the draft is saved', async () => {
  mock.checkpoint = true;
  const files = new Map([['workspace', 'original graph']]);
  let failWorkspace = true;
  mock.invoke.mockImplementation(async (name, args) => {
    if (name === 'protected_read') return files.get(args.key) ?? null;
    if (name === 'protected_finish_restore') {
      for (const key of files.keys()) if (key.startsWith('restore')) files.delete(key);
      return;
    }
    if (args.key === 'workspace' && failWorkspace) throw new Error('disk busy');
    files.set(args.key, args.text);
  });
  let receipt: string | undefined;
  let committed = 0;
  let serviceStarting = false;
  mock.restore.mockImplementation(async (id, base, document) => {
    expect(base).toBe('original stash');
    expect(document).toBe('restored stash');
    if (serviceStarting) throw { code: 'SERVICE_UNAVAILABLE', message: 'The service is starting.' };
    if (receipt !== id) {
      receipt = id;
      committed++;
    }
    return document;
  });
  const { restoreProtectedWorkspace } = await import('./protectedStorage');
  await expect(
    restoreProtectedWorkspace({
      workspace: 'restored graph',
      stash: { base: 'original stash', document: 'restored stash' },
    }),
  ).rejects.toThrow('disk busy');
  expect(files.get('workspace')).toBe('original graph');
  await expect(protectedWrite('workspace', 'stale autosave')).rejects.toThrow('pending backup');

  failWorkspace = false;
  serviceStarting = true;
  vi.resetModules();
  const restarted = await import('./protectedStorage');
  mock.read.mockResolvedValue('restored stash');
  const unavailable = await Promise.allSettled([
    restarted.protectedRead('workspace'),
    restarted.protectedRead('stash'),
  ]);
  expect(unavailable.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(files.get('workspace')).toBe('original graph');
  expect(JSON.parse(files.get('restore')!).id).toBe(receipt);
  serviceStarting = false;
  await expect(
    Promise.all([restarted.protectedRead('workspace'), restarted.protectedRead('stash')]),
  ).resolves.toEqual(['restored graph', 'restored stash']);
  expect(committed).toBe(1);
  expect(files.has('restore')).toBe(false);
});
