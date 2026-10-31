import { beforeEach, expect, it, vi } from 'vitest';
import { importProfiles, parseStash, serializeStash, type Stash } from './import';
import { mergeStashDocuments, confirmStashSave } from './stashMerge';
const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../serviceClient', () => ({ serviceCall: mock.call }));
vi.mock('./importClient', () => ({
  confirmServiceStashSave: async (base: string, local: string, remote: string) =>
    confirmStashSave(base, local, remote),
}));
beforeEach(() => {
  vi.resetModules();
  mock.call.mockReset();
});

it('coalesces pending context without holding saves or route assignments behind its job', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let upload = '',
    job = 0;
  const contexts: unknown[] = [];
  mock.call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
    if (method === 'subscriptions.uploadStart') {
      upload = '';
      return { token: String(p.kind), chunkBytes: 512 };
    }
    if (method === 'subscriptions.uploadChunk') {
      upload += String(p.text);
      return {};
    }
    if (method === 'subscriptions.uploadCommit') {
      if (p.token === 'context') contexts.push(JSON.parse(upload));
      return { job: ++job };
    }
    if (method === 'subscriptions.job') {
      if (p.job === 1) {
        await held;
        return { busy: false, error: { code: 'CANCELLED', message: 'Interrupted' } };
      }
      return { busy: false, error: null };
    }
    if (method === 'subscriptions.read')
      return { initialized: true, text: 'library', nextOffset: 7, totalBytes: 7, version: 1 };
    if (method === 'subscriptions.replace') return { job: 999 };
    throw new Error('Unexpected ' + method);
  });
  const { sendSubscriptionContext, writeServiceStash, replaceRunningOutbound } =
    await import('./serviceSubscriptions');
  const pending = [sendSubscriptionContext({ draft: 'first' })];
  await vi.waitFor(() => expect(mock.call).toHaveBeenCalledWith('subscriptions.job', { job: 1 }));
  pending.push(sendSubscriptionContext({ testUrl: 'https://test.example' }));
  for (let i = 0; i < 50; i++) pending.push(sendSubscriptionContext({ draft: `draft-${i}` }));
  const saving = writeServiceStash('library');
  const replacing = replaceRunningOutbound('main', { groupId: 'g', entryId: 'e' });
  try {
    await vi.waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('subscriptions.replace', {
        nodeId: 'main',
        groupId: 'g',
        entryId: 'e',
      }),
    );
    expect(contexts).toEqual([{ draft: 'first' }]);
  } finally {
    release();
    await Promise.allSettled([...pending, saving, replacing]);
  }
  await expect(Promise.all(pending)).resolves.toBeDefined();
  expect(contexts).toEqual([
    { draft: 'first' },
    { testUrl: 'https://test.example', draft: 'draft-49' },
  ]);
});

it('orders identity-only replacement after the saved library without staging a runtime graph', async () => {
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mock.call.mockImplementation(async (method: string) => {
    if (method === 'subscriptions.uploadStart') return { token: 'save', chunkBytes: 512 };
    if (method === 'subscriptions.uploadChunk') return {};
    if (method === 'subscriptions.uploadCommit') return { job: 1 };
    if (method === 'subscriptions.job') {
      await saved;
      return { busy: false, error: null };
    }
    if (method === 'subscriptions.read')
      return { initialized: true, text: 'library', nextOffset: 7, totalBytes: 7, version: 1 };
    if (method === 'subscriptions.replace') return { job: 2 };
    throw new Error('Unexpected ' + method);
  });
  const { writeServiceStash, replaceRunningOutbound } = await import('./serviceSubscriptions');
  const saving = writeServiceStash('library');
  const choice = {
    groupId: 'group',
    entryId: 'entry',
    label: 'Favorite · Servers',
    available: true,
  };
  const replacing = replaceRunningOutbound('node', choice);
  await vi.waitFor(() => expect(mock.call).toHaveBeenCalledWith('subscriptions.job', { job: 1 }));
  expect(mock.call.mock.calls.some(([method]) => method === 'subscriptions.replace')).toBe(false);
  finish();
  await saving;
  await replacing;
  expect(mock.call).toHaveBeenCalledWith('subscriptions.replace', {
    nodeId: 'node',
    groupId: 'group',
    entryId: 'entry',
  });
  expect(mock.call.mock.calls.some(([method]) => method === 'config.refreshOutbounds')).toBe(false);
});

it('uploads Unicode by byte offsets without splitting a code point', async () => {
  let result = '',
    expected = 0;
  mock.call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
    if (method === 'subscriptions.uploadStart') return { token: 'token', chunkBytes: 5 };
    if (method === 'subscriptions.uploadChunk') {
      expect(p.offset).toBe(expected);
      expected += new TextEncoder().encode(String(p.text)).length;
      result += p.text;
      return {};
    }
    if (method === 'subscriptions.uploadCommit') return { sourceGraphToken: 'source' };
    throw new Error(`Unexpected ${method}`);
  });
  const { stageSubscriptionGraph } = await import('./serviceSubscriptions');
  expect(await stageSubscriptionGraph('abc🛰Привет🌎')).toBe('source');
  expect(result).toBe('abc🛰Привет🌎');
});
it('restarts a chunked read instead of joining different library revisions', async () => {
  let reads = 0;
  mock.call.mockImplementation(async (_method: string, p: { offset: number; version?: number }) => {
    reads++;
    if (reads === 1)
      return { text: 'old', initialized: true, nextOffset: 3, totalBytes: 6, version: 1 };
    if (reads === 2) {
      expect(p.version).toBe(1);
      throw Object.assign(new Error('Changed'), { code: 'REVISION_CONFLICT' });
    }
    expect(p.offset).toBe(0);
    return { text: 'new', initialized: true, nextOffset: 3, totalBytes: 3, version: 2 };
  });
  const { readSubscriptionDocument } = await import('./serviceSubscriptions');
  expect(await readSubscriptionDocument('stash')).toEqual({ text: 'new', version: 2 });
});
it('aborts an incomplete transfer and preserves the original upload failure', async () => {
  mock.call.mockImplementation(async (method: string) => {
    if (method === 'subscriptions.uploadStart') return { token: 'token', chunkBytes: 512 };
    if (method === 'subscriptions.uploadChunk') throw new Error('Disconnected');
    return {};
  });
  const { stageSubscriptionGraph } = await import('./serviceSubscriptions');
  await expect(stageSubscriptionGraph('graph')).rejects.toThrow('Disconnected');
  expect(mock.call).toHaveBeenLastCalledWith('subscriptions.uploadAbort', { token: 'token' });
});

function libraryServer(initialized = true) {
  const original: Stash = {
    format: 'wayrill.stash',
    version: 3,
    groups: importProfiles('socks://192.0.2.1:1080#Original').groups,
  };
  let remote: string | null = initialized ? serializeStash(original) : null,
    version = 1,
    upload = '',
    failCommit: 'before' | 'after' | undefined;
  mock.call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
    if (method === 'subscriptions.read')
      return {
        text: remote ?? '',
        version,
        initialized: remote !== null,
        nextOffset: new TextEncoder().encode(remote ?? '').length,
        totalBytes: new TextEncoder().encode(remote ?? '').length,
      };
    if (method === 'subscriptions.uploadStart') {
      upload = '';
      return { token: 'save', chunkBytes: 512 * 1024 };
    }
    if (method === 'subscriptions.uploadChunk') {
      upload += String(p.text);
      return {};
    }
    if (method === 'subscriptions.uploadCommit') {
      if (failCommit === 'before') {
        failCommit = undefined;
        throw new Error('Disconnected before commit');
      }
      const save = JSON.parse(upload) as { base: string; document: string };
      remote =
        remote === null
          ? serializeStash(parseStash(save.document))
          : mergeStashDocuments(save.base, save.document, remote);
      version++;
      if (failCommit === 'after') {
        failCommit = undefined;
        throw new Error('Reply lost after commit');
      }
      return { job: version };
    }
    if (method === 'subscriptions.job') return { busy: false, error: null };
    throw new Error(`Unexpected ${method}`);
  });
  return {
    original,
    get: () => parseStash(remote!),
    failNextSave: (when: 'before' | 'after' = 'before') => {
      failCommit = when;
    },
    replace(value: Stash) {
      remote = serializeStash(value);
      version++;
      return version;
    },
  };
}

it('preserves a provider refresh while its renderer merge is still pending', async () => {
  const server = libraryServer();
  const { readServiceStash, refreshServiceStash, subscribeLibrary, writeServiceStash } =
    await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const remote = structuredClone(server.original);
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  remote.groups[0].entries.push({ ...remote.groups[0].entries[0], id: 'new-server' });
  const revision = server.replace(remote);
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = vi.fn(() => delivery);
  const remove = subscribeLibrary(received);
  const refresh = refreshServiceStash(revision);
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  const local = structuredClone(server.original);
  local.groups[0].name = 'My provider';
  // The UI still contains its old snapshot while its merge worker runs.
  const save = writeServiceStash(serializeStash(local), base);
  release();
  await Promise.all([refresh, save]);
  remove();
  const result = server.get().groups[0];
  expect(result.name).toBe('My provider');
  expect(result.entries).toHaveLength(2);
  expect(result.entries[0].profile!.settings.port).toBe(2080);
});

it('waits for renderer acknowledgement before acknowledging a subscription refresh', async () => {
  const server = libraryServer();
  const { readServiceStash, refreshServiceStash, subscribeLibrary } =
    await import('./serviceSubscriptions');
  await readServiceStash();
  const remote = structuredClone(server.original);
  remote.groups[0].name = 'Updated';
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = vi.fn(() => delivery);
  const remove = subscribeLibrary(received);
  let finished = false;
  const refresh = refreshServiceStash(server.replace(remote)).then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  expect(finished).toBe(false);
  release();
  await refresh;
  expect(finished).toBe(true);
  remove();
});

it('preserves a deliberate reversion queued behind an in-flight local save', async () => {
  const server = libraryServer();
  const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const changed = structuredClone(server.original);
  changed.groups[0].name = 'Temporary';
  const first = writeServiceStash(serializeStash(changed), base);
  const reverted = writeServiceStash(base, base);
  await Promise.all([first, reverted]);
  expect(server.get().groups[0].name).toBe(server.original.groups[0].name);
});

it('rejects a stale conflicting edit after a newer service document was read', async () => {
  const server = libraryServer();
  const { readServiceStash, refreshServiceStash, writeServiceStash } =
    await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const remote = structuredClone(server.original),
    local = structuredClone(server.original);
  remote.groups[0].entries[0].profile!.settings.port = 2080;
  local.groups[0].entries[0].profile!.settings.port = 3080;
  await refreshServiceStash(server.replace(remote));
  await expect(writeServiceStash(serializeStash(local), base)).rejects.toThrow(
    /same subscription item changed/,
  );
  expect(server.get().groups[0].entries[0].profile!.settings.port).toBe(2080);
});

it('does not acknowledge a service revision when its renderer merge fails', async () => {
  const server = libraryServer();
  const { readServiceStash, refreshServiceStash, subscribeLibrary } =
    await import('./serviceSubscriptions');
  await readServiceStash();
  const remote = structuredClone(server.original);
  remote.groups[0].name = 'Updated';
  const revision = server.replace(remote);
  const remove = subscribeLibrary(() => Promise.reject(new Error('Merge failed')));
  await expect(refreshServiceStash(revision)).rejects.toThrow('Merge failed');
  remove();
  const before = mock.call.mock.calls.filter(([method]) => method === 'subscriptions.read').length;
  await refreshServiceStash(revision);
  expect(mock.call.mock.calls.filter(([method]) => method === 'subscriptions.read')).toHaveLength(
    before + 1,
  );
});

it('retains cumulative queued edits when their preceding save failed before commit', async () => {
  const server = libraryServer();
  const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const firstDraft = structuredClone(server.original);
  firstDraft.groups[0].name = 'My provider';
  const secondDraft = structuredClone(firstDraft);
  secondDraft.groups[0].entries[0].name = 'Preferred server';
  server.failNextSave();
  const first = writeServiceStash(serializeStash(firstDraft), base);
  const second = writeServiceStash(serializeStash(secondDraft), base);
  const results = await Promise.allSettled([first, second]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expect(results[1].status).toBe('fulfilled');
  expect(server.get().groups[0]).toMatchObject({
    name: 'My provider',
    entries: [expect.objectContaining({ name: 'Preferred server' })],
  });
});

it('keeps remote additions through consecutive local saves authored before their acknowledgement', async () => {
  const server = libraryServer();
  const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const remote = structuredClone(server.original);
  remote.groups[0].entries.push({ ...remote.groups[0].entries[0], id: 'new-server' });
  server.replace(remote);
  const firstDraft = structuredClone(server.original);
  firstDraft.groups[0].name = 'My provider';
  const secondDraft = structuredClone(firstDraft);
  secondDraft.groups[0].entries[0].name = 'Preferred server';
  await Promise.all([
    writeServiceStash(serializeStash(firstDraft), base),
    writeServiceStash(serializeStash(secondDraft), base),
  ]);
  const group = server.get().groups[0];
  expect(group.name).toBe('My provider');
  expect(group.entries).toHaveLength(2);
  expect(group.entries[0].name).toBe('Preferred server');
  expect(group.entries[1].id).toBe('new-server');
});

it('confirms a lost commit reply before applying a queued deliberate reversion', async () => {
  const server = libraryServer();
  const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const changed = structuredClone(server.original);
  changed.groups[0].name = 'Temporary';
  server.failNextSave('after');
  const first = writeServiceStash(serializeStash(changed), base);
  const reverted = writeServiceStash(base, base);
  const outcomes = await Promise.allSettled([first, reverted]);
  expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expect(outcomes[1].status).toBe('fulfilled');
  expect(server.get().groups[0].name).toBe(server.original.groups[0].name);
});

it.each(['before', 'after'] as const)(
  'recovers first-library initialization after a failure %s commit',
  async (when) => {
    const server = libraryServer(false);
    const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
    expect(await readServiceStash()).toBeNull();
    const next = structuredClone(server.original);
    next.groups[0].name = 'My provider';
    server.failNextSave(when);
    const first = writeServiceStash(serializeStash(server.original), '');
    const second = writeServiceStash(serializeStash(next), '');
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0].status).toBe('rejected');
    expect(outcomes[1].status).toBe('fulfilled');
    expect(server.get().groups[0].name).toBe('My provider');
  },
);

it('allows a corrected draft after an uncertain save discovers a genuine conflict', async () => {
  const server = libraryServer();
  const { readServiceStash, writeServiceStash } = await import('./serviceSubscriptions');
  const base = (await readServiceStash())!;
  const local = structuredClone(server.original);
  local.groups[0].name = 'My provider';
  server.failNextSave('after');
  await expect(writeServiceStash(serializeStash(local), base)).rejects.toThrow(/Reply lost/);
  const remote = server.get();
  remote.groups[0].name = 'Other edit';
  server.replace(remote);
  await expect(writeServiceStash(serializeStash(local), base)).rejects.toThrow(
    /could not be confirmed/,
  );
  const corrected = structuredClone(server.original);
  corrected.groups[0].entries[0].name = 'Preferred server';
  await writeServiceStash(serializeStash(corrected), base);
  expect(server.get().groups[0]).toMatchObject({
    name: 'Other edit',
    entries: [expect.objectContaining({ name: 'Preferred server' })],
  });
});
