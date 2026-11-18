import { describe, expect, it, vi } from 'vitest';
import { RuntimeSession, type ServiceRequest, type ServiceView } from './runtimeSession';
import type { ServiceError, ServiceSnapshot } from './serviceClient';

const snapshot = (revision = 1, state = 'stopped', instanceId = 'service-a'): ServiceSnapshot => ({
  serviceVersion: 'test',
  apiVersion: 1,
  instanceId,
  ownerSid: 'fictional',
  uptimeSeconds: 1,
  config: { present: true, revision, sha256: 'fictional' },
  core: { state, generation: 1, pid: null, version: 'test', lastError: null },
  winDivert: {
    available: true,
    mode: 'sniffOnly',
    state: 'stopped',
    packets: 0,
    bytes: 0,
  },
  systemProxy: { managed: false, conflict: false, recoveryPending: false },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const subscriptions = {
  version: 1,
  initialized: true,
  error: null,
  busy: false,
  automatic: false,
  statuses: {},
  appliedRevision: null,
  appliedSourceHash: null,
};
const view = (current = snapshot(), sequence = 0): ServiceView => ({
  snapshot: current,
  profile: { revision: current.config.revision, config: { marker: current.config.revision } },
  hello: { instanceId: current.instanceId, capabilities: ['test'] },
  subscriptions,
  sequence,
});
function service() {
  let current = snapshot(),
    sequence = 0;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'service.sync') return view(current, sequence);
    return {};
  });
  return {
    request,
    session: new RuntimeSession(request as ServiceRequest),
    set: (value: ServiceSnapshot) => {
      current = value;
      sequence += 1000;
    },
  };
}

describe('runtime synchronization', () => {
  it('keeps installer receipts in Events without replacing the runtime snapshot', async () => {
    const env = service();
    await env.session.refresh();
    const before = env.session.getSnapshot().snapshot;
    const receipt = {
      type: 'event' as const,
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 1,
      timestampMs: 1,
      kind: 'upgrade.completed',
      payload: {
        transactionId: 'upgrade-a',
        ok: false,
        error: { code: 'ICS_KEEPER', message: 'Previous routing could not resume.' },
        core: 'failed',
        revision: 1,
        serviceVersion: '0.37.15',
      },
    };
    env.session.message(receipt);
    expect(env.session.getSnapshot().snapshot).toBe(before);
    expect(env.session.getEvents()).toContain(receipt);
  });

  it('updates live snapshots without evicting diagnostic events or duplicating replay', async () => {
    const env = service();
    await env.session.refresh();
    const failure = {
      type: 'event' as const,
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 1,
      timestampMs: 1,
      kind: 'core.log',
      payload: { message: 'Connection failed.' },
    };
    env.session.message(failure);
    const history = env.session.getEvents();
    for (let sequence = 2; sequence <= 202; sequence++)
      env.session.message({
        ...failure,
        sequence,
        kind: 'service.snapshot',
        payload: { ...snapshot(1, 'running'), uptimeSeconds: sequence },
      });
    env.session.message(failure);
    expect(env.session.getSnapshot().snapshot).toMatchObject({
      uptimeSeconds: 202,
      core: { state: 'running' },
    });
    expect(env.session.getEvents()).toBe(history);
    expect(history).toEqual([failure]);
    expect(env.request).toHaveBeenCalledTimes(1);
  });
  it('keeps core log bursts out of live runtime updates while retaining recent events', async () => {
    const { session } = service();
    await session.refresh();
    const onRuntime = vi.fn();
    const onEvents = vi.fn();
    session.subscribe(onRuntime);
    session.subscribeEvents(onEvents);
    for (let sequence = 1; sequence <= 300; sequence++)
      session.message({
        type: 'event',
        apiVersion: 1,
        instanceId: 'service-a',
        sequence,
        timestampMs: sequence,
        kind: 'core.log',
        payload: { message: 'Connection failed.' },
      });
    expect(session.getEvents()).toHaveLength(150);
    expect(session.getEvents()[0]?.sequence).toBe(151);
    expect(session.getEvents().at(-1)?.sequence).toBe(300);
    expect(onEvents).toHaveBeenCalledTimes(300);
    session.clearEvents();
    expect(session.getEvents()).toEqual([]);
    expect(onEvents).toHaveBeenCalledTimes(301);
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it('keeps a newer live snapshot when an older status reply finishes afterward', async () => {
    const env = service(),
      old = deferred<ServiceView>();
    env.request.mockImplementationOnce(() => old.promise);
    const refresh = env.session.refresh();
    env.set(snapshot(2, 'running'));
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 5,
      timestampMs: 1,
      kind: 'config.applied',
      payload: snapshot(2, 'running'),
    });
    old.resolve(view(snapshot(1)));
    await refresh;
    expect(env.session.getSnapshot().snapshot?.core.state).toBe('running');
    expect(env.session.getSnapshot().savedRevision).toBe(2);
    expect(env.request.mock.calls.filter(([m]) => m === 'service.sync')).toHaveLength(2);
  });
  it('treats the reconnection acknowledgement as authoritative over replayed snapshots', async () => {
    const env = service();
    env.set(snapshot(1, 'running', 'service-b'));
    env.session.message({
      type: 'response',
      ok: true,
      result: {
        sequence: 100,
        replayGap: true,
        snapshot: snapshot(1, 'running', 'service-b'),
      },
    });
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-b',
      sequence: 2,
      timestampMs: 1,
      kind: 'core.state',
      payload: snapshot(1, 'stopped', 'service-b'),
    });
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 1000,
      timestampMs: 1,
      kind: 'core.state',
      payload: snapshot(9),
    });
    await env.session.refresh();
    expect(env.session.getSnapshot().snapshot?.core.state).toBe('running');
    expect(env.session.getSnapshot().snapshot?.instanceId).toBe('service-b');
  });
  it('discards a refresh from the service instance that disconnected', async () => {
    const env = service(),
      old = deferred<ServiceView>();
    env.request.mockImplementationOnce(() => old.promise);
    const refreshing = env.session.refresh();
    env.set(snapshot(0, 'stopped', 'service-b'));
    env.session.message({
      type: 'response',
      ok: true,
      result: {
        snapshot: snapshot(0, 'stopped', 'service-b'),
        sequence: 2,
        subscriptions: { ...subscriptions, version: 9 },
      },
    });
    old.resolve(view());
    await refreshing;
    expect(env.session.getSnapshot().snapshot?.instanceId).toBe('service-b');
    expect(env.session.getSnapshot().savedRevision).toBe(0);
  });
  it.each([false, true])(
    'discards a pre-disconnect reply and honors a fresh queued read (%s)',
    async (queued) => {
      const env = service();
      await env.session.refresh();
      const delayed = deferred<ServiceView>();
      env.request.mockImplementationOnce(() => delayed.promise);
      const refreshing = env.session.refresh();
      env.session.transport({
        connected: false,
        error: { code: 'DISCONNECTED', message: 'Service closed.', retryable: true },
      });
      if (queued) {
        env.set(snapshot(2, 'running'));
        void env.session.refresh();
      }
      delayed.resolve(view(snapshot(1, 'running')));
      if (queued) {
        await refreshing;
        expect(env.session.getSnapshot()).toMatchObject({ connected: true, savedRevision: 2 });
        return;
      }
      await expect(refreshing).rejects.toMatchObject({ code: 'DISCONNECTED' });
      expect(env.session.getSnapshot().connected).toBe(false);
      expect(env.session.getSnapshot().snapshot?.core.state).toBe('stopped');
    },
  );
  it('services the reconnect refresh even when the old in-flight sync fails', async () => {
    const env = service();
    await env.session.refresh();
    const delayed = deferred<ServiceView>();
    env.request.mockImplementationOnce(() => delayed.promise);
    const refreshing = env.session.refresh();
    env.session.transport({ connected: false });
    env.set(snapshot(2, 'running', 'service-b'));
    env.session.transport({ connected: true });
    env.session.message({
      type: 'response',
      ok: true,
      result: { snapshot: snapshot(2, 'running', 'service-b'), sequence: 1000 },
    });
    delayed.reject(Object.assign(new Error('Old pipe closed.'), { code: 'DISCONNECTED' }));
    await refreshing;
    expect(env.session.getSnapshot()).toMatchObject({
      connected: true,
      savedRevision: 2,
      snapshot: { instanceId: 'service-b' },
    });
    expect(env.request.mock.calls.filter(([method]) => method === 'service.sync')).toHaveLength(3);
  });
  it('does not overwrite newer subscription progress with an in-flight refresh', async () => {
    const env = service(),
      old = deferred<ServiceView>();
    env.request.mockImplementationOnce(() => old.promise);
    const refreshing = env.session.refresh();
    const newer = { ...subscriptions, version: 4, busy: true };
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 5,
      timestampMs: 1,
      kind: 'subscriptions.progress',
      payload: newer,
    });
    env.request.mockResolvedValueOnce({ ...view(), sequence: 5, subscriptions: newer });
    old.resolve(view());
    await refreshing;
    expect(env.session.getSnapshot().subscriptions).toEqual(newer);
    expect(env.request).toHaveBeenCalledTimes(2);
  });
  it('finishes synchronization despite newer progress while preserving the latest live state', async () => {
    const env = service();
    await env.session.refresh();
    const delayed = deferred<ServiceView>(),
      fallback = deferred<ServiceView>();
    env.request
      .mockImplementationOnce(() => delayed.promise)
      .mockImplementationOnce(() => fallback.promise);
    let completed = false;
    const refreshing = env.session.refresh().then(() => {
      completed = true;
    });
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 10,
      timestampMs: 1,
      kind: 'subscriptions.progress',
      payload: { ...subscriptions, version: 4, busy: true },
    });
    delayed.resolve(view(snapshot(), 1));
    try {
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 300 });
      expect(env.session.getSnapshot().subscriptions).toMatchObject({ version: 4, busy: true });
      expect(env.session.getSnapshot().savedRevision).toBe(1);
      expect(env.request).toHaveBeenCalledTimes(2);
    } finally {
      fallback.resolve({
        ...view(snapshot(), 10),
        subscriptions: { ...subscriptions, version: 4, busy: true },
      });
      await refreshing;
    }
  });
  it('rejects overlapping mutations and does not retry an acknowledged command after a refresh failure', async () => {
    const env = service(),
      pending = deferred<object>();
    env.request.mockImplementationOnce(() => pending.promise);
    const command = env.session.run('core.stop');
    await expect(env.session.run('core.start')).rejects.toThrow(/Wait/);
    env.request.mockImplementationOnce(async () => {
      throw new Error('fictional disconnect');
    });
    pending.resolve({});
    await expect(command).rejects.toThrow(/disconnect/);
    expect(env.session.getSnapshot().error).toContain('command completed');
    expect(env.session.getSnapshot().busy).toBe(false);
    expect(env.request.mock.calls.filter(([m]) => m === 'core.stop')).toHaveLength(1);
  });
  it.each([true, false])(
    'retries only the busy status read after a restart (recovers: %s)',
    async (recovers) => {
      const env = service();
      await env.session.refresh();
      env.set(snapshot(1, 'running'));
      const original = env.request.getMockImplementation()!;
      const busy: ServiceError = { code: 'BUSY', message: 'The service is busy.', retryable: true };
      let reads = 0;
      env.request.mockClear().mockImplementation(async (method: string) => {
        if (method === 'service.sync' && (++reads <= 2 || !recovers)) throw busy;
        return original(method);
      });

      vi.useFakeTimers();
      try {
        const restart = env.session.run('core.restart');
        const result = recovers
          ? expect(restart).resolves.toEqual({})
          : expect(restart).rejects.toEqual(busy);
        await vi.advanceTimersByTimeAsync(0);
        expect(env.session.getSnapshot()).toMatchObject({ connected: true, busy: true, error: '' });
        const queued = env.session.refresh();
        expect(queued).toBe(env.session.refresh());
        void queued.catch(() => {});
        await vi.runAllTimersAsync();
        await result;

        expect(env.request.mock.calls.filter(([method]) => method === 'core.restart')).toHaveLength(
          1,
        );
        expect(env.session.getSnapshot()).toMatchObject({ connected: true, busy: false });
        if (recovers) {
          expect(env.session.getSnapshot().notice).toContain('Restart completed.');
          expect(env.session.getSnapshot().snapshot?.core.state).toBe('running');
          expect(env.session.getSnapshot().error).toBe('');
        } else {
          expect(reads).toBe(6);
          expect(env.session.getSnapshot().error).toContain('The command completed');
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('reports the observed state after activation instead of promising a running core', async () => {
    const env = service();
    env.set(snapshot(2, 'failed'));
    await env.session.run('config.applyAndStart');
    expect(env.session.getSnapshot().notice).toContain('Service reported revision 2; Xray: failed');
    expect(env.session.getSnapshot().notice).not.toContain('Xray is running');
  });
  it('keeps a lost mutation reply unknown even when a readonly refresh finds a running core', async () => {
    const env = service();
    env.set(snapshot(2, 'running'));
    const error = {
      code: 'TIMEOUT',
      message: 'Fictional lost reply',
      retryable: false,
    };
    env.request.mockRejectedValueOnce(error);
    await expect(env.session.run('config.applyAndStart')).rejects.toEqual(error);
    expect(env.session.getSnapshot()).toMatchObject({
      connected: true,
      notice: '',
    });
    expect(env.session.getSnapshot().error).toContain('command outcome is unknown');
    expect(env.session.getSnapshot().snapshot?.core.state).toBe('running');
    expect(env.request.mock.calls.filter(([m]) => m === 'config.applyAndStart')).toHaveLength(1);
  });
});

describe('resource preparation before activation', () => {
  it('waits for asynchronous downloads and preserves the running config when preparation fails', async () => {
    vi.useFakeTimers();
    const env = service();
    const original = env.request.getMockImplementation()!;
    let attempts = 0;
    env.request.mockImplementation(async (method: string) => {
      if (method === 'resources.ensure') {
        if (++attempts === 1) return { ready: false, busy: true };
        throw { code: 'RESOURCE_DOWNLOAD', message: 'Invalid DAT file.' };
      }
      return original(method);
    });
    const running = env.session.run('config.applyAndStart', {
      config: { routing: { domain: ['geosite:private'] } },
      resources: [],
    });
    const rejected = expect(running).rejects.toMatchObject({ code: 'RESOURCE_DOWNLOAD' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    vi.useRealTimers();
    expect(env.request.mock.calls.some(([m]) => m === 'config.applyAndStart')).toBe(false);
    expect(env.session.getSnapshot().busy).toBe(false);
  });
});

describe('lifecycle command blocking', () => {
  it('blocks immediately before the first service event and clears after a rejected command', async () => {
    const env = service();
    const command = deferred<unknown>();
    const original = env.request.getMockImplementation()!;
    env.request.mockImplementation((method: string) =>
      method === 'core.start' ? command.promise : original(method),
    );
    const running = env.session.run('core.start');
    expect(env.session.getSnapshot().pendingOperation).toBe('start');
    expect(env.session.getSnapshot().busy).toBe(true);
    command.resolve({});
    await running;
    expect(env.session.getSnapshot().pendingOperation).toBeUndefined();
    env.request.mockRejectedValueOnce({ code: 'REVISION_CONFLICT', message: 'Stale revision.' });
    await expect(env.session.run('core.restart')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(env.session.getSnapshot().pendingOperation).toBeUndefined();
    expect(env.session.getSnapshot().busy).toBe(false);
  });
});
