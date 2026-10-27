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
  it('waits for the active write before sending the next document', async () => {
    let complete!: () => void;
    mock.invoke
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const first = protectedWrite('workspace', 'first'),
      second = protectedWrite('workspace', 'second');
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.invoke).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([first, second]);
    expect(mock.invoke.mock.calls.map(([, p]) => p.text)).toEqual(['first', 'second']);
  });
});

it('skips unchanged protected content after a read or a successful write', async () => {
  mock.invoke.mockResolvedValueOnce('stored').mockResolvedValue(undefined);
  expect(await protectedRead('workspace')).toBe('stored');
  await protectedWrite('workspace', 'stored');
  await protectedWrite('workspace', 'changed');
  await protectedWrite('workspace', 'changed');
  expect(mock.invoke.mock.calls).toEqual([
    ['protected_read', { key: 'workspace' }],
    ['protected_write', { key: 'workspace', text: 'changed' }],
  ]);
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
it('uses the service library without consulting the stale desktop copy', async () => {
  mock.read.mockResolvedValue('service');
  expect(await protectedRead('stash')).toBe('service');
  await protectedWrite('stash', 'edited');
  expect(mock.invoke).not.toHaveBeenCalled();
  expect(mock.write).toHaveBeenCalledWith('edited', undefined);
});

it('saves the graph while an independent service Stash write is still pending', async () => {
  let finish!: () => void;
  mock.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const saving = protectedWrite('stash', 'library');
  await vi.waitFor(() => expect(mock.write).toHaveBeenCalledOnce());
  const graph = protectedWrite('workspace', 'graph');
  try {
    await vi.waitFor(
      () =>
        expect(mock.invoke).toHaveBeenCalledWith('protected_write', {
          key: 'workspace',
          text: 'graph',
        }),
      { timeout: 300 },
    );
  } finally {
    finish();
    await Promise.all([saving, graph]);
  }
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
