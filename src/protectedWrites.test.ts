import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('./profiles/serviceSubscriptions', () => ({
  readServiceStash: mock.read,
  writeServiceStash: mock.write,
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mock.invoke,
}));
let protectedWrite: typeof import('./protectedStorage').protectedWrite;
let protectedRead: typeof import('./protectedStorage').protectedRead;

beforeEach(async () => {
  mock.invoke.mockReset();
  mock.read.mockReset();
  mock.write.mockReset();
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
