import { describe, expect, it, vi } from 'vitest';
import { RuntimeSession, type ServiceRequest, type ServiceView } from './runtimeSession';
import type { ServiceSnapshot } from './serviceClient';

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
  it('reads profile, runtime, subscriptions and capabilities in one coherent request', async () => {
    const env = service();
    env.set(snapshot(3, 'running'));
    await env.session.refresh();
    expect(env.request.mock.calls).toEqual([['service.sync']]);
    expect(env.session.getSnapshot()).toMatchObject({
      savedRevision: 3,
      savedConfig: { marker: 3 },
      subscriptions,
      snapshot: { config: { revision: 3 }, core: { state: 'running' } },
    });
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
  it('uses live subscription events and ignores replay preceding the acknowledged state', async () => {
    const env = service();
    await env.session.refresh();
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 5,
      timestampMs: 1,
      kind: 'subscriptions.progress',
      payload: { ...subscriptions, version: 4, busy: true },
    });
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 4,
      timestampMs: 1,
      kind: 'subscriptions.changed',
      payload: { ...subscriptions, version: 3 },
    });
    expect(env.session.getSnapshot().subscriptions).toMatchObject({ version: 4, busy: true });
    expect(env.request).toHaveBeenCalledTimes(1);
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
  it('keeps the live connection when an older refresh fails after a newer service frame', async () => {
    const env = service();
    await env.session.refresh();
    const delayed = deferred<ServiceView>();
    env.request.mockImplementationOnce(() => delayed.promise);
    const refreshing = env.session.refresh();
    env.session.message({
      type: 'event',
      apiVersion: 1,
      instanceId: 'service-a',
      sequence: 10,
      timestampMs: 1,
      kind: 'core.state',
      payload: snapshot(1, 'running'),
    });
    delayed.reject(new Error('Old status request timed out'));
    await expect(refreshing).rejects.toThrow('timed out');
    expect(env.session.getSnapshot()).toMatchObject({
      connected: true,
      snapshot: { core: { state: 'running' } },
    });
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
  it('reports the observed state after activation instead of promising a running core', async () => {
    const env = service();
    env.set(snapshot(2, 'failed'));
    await env.session.run('config.applyAndStart');
    expect(env.session.getSnapshot().notice).toContain('Service reported revision 2; Xray: failed');
    expect(env.session.getSnapshot().notice).not.toContain('Xray is running');
  });
  it.each([
    [
      { managed: true, conflict: true, recoveryPending: false },
      'External Windows proxy settings were preserved',
    ],
    [{ managed: true, conflict: false, recoveryPending: true }, 'restoration needs attention'],
    [
      { managed: false, conflict: false, recoveryPending: false },
      'no longer owns Windows proxy settings',
    ],
  ])('reports proxy ownership truthfully after Stop: %j', async (systemProxy, expected) => {
    const env = service();
    env.set({ ...snapshot(), systemProxy });
    await env.session.run('core.stop');
    expect(env.session.getSnapshot().notice).toContain(expected);
    expect(env.session.getSnapshot().notice).not.toContain('were restored');
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
  it('retains a confirmed service rejection instead of calling it a lost reply', async () => {
    const env = service();
    const error = {
      code: 'ACTIVATION_ROLLED_BACK',
      message: 'Previous runtime recovered.',
      retryable: false,
    };
    env.request.mockRejectedValueOnce(error);
    await expect(env.session.run('config.applyAndStart')).rejects.toEqual(error);
    expect(env.session.getSnapshot().error).toBe(error.message);
    expect(env.session.getSnapshot().errorAction).toBe('config.applyAndStart');
    env.session.update({ error: 'Local file error' });
    expect(env.session.getSnapshot().errorAction).toBeUndefined();
  });
});

describe('resource preparation before activation', () => {
  it('prepares referenced files and strips frontend resource plans from the config API payload', async () => {
    const env = service();
    const original = env.request.getMockImplementation()!;
    env.request.mockImplementation(async (method: string) =>
      method === 'resources.ensure' ? { ready: true, busy: false } : original(method),
    );
    const config = { routing: { rules: [{ domain: ['ext:office.dat:work'] }] } };
    const resources = [
      {
        file: 'office.dat',
        kind: 'geosite',
        url: 'https://example.net/data',
        autoUpdate: false,
        intervalHours: 24,
      },
    ];
    await env.session.run('config.validate', { config, resources });
    expect(env.request).toHaveBeenCalledWith('resources.ensure', {
      files: resources,
      required: ['office.dat'],
    });
    expect(env.request).toHaveBeenCalledWith('config.validate', { config });
  });
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
  it('blocks the graph during source preparation and reports preparation errors centrally', async () => {
    const env = service();
    const source = deferred<Record<string, unknown>>();
    const running = env.session.run('config.applyAndStart', {}, () => source.promise);
    expect(env.session.getSnapshot().busy).toBe(true);
    const failed = expect(running).rejects.toThrow('Source upload failed');
    source.reject(new Error('Source upload failed'));
    await failed;
    expect(env.session.getSnapshot()).toMatchObject({
      busy: false,
      error: 'Source upload failed',
      errorAction: 'config.applyAndStart',
    });
    expect(env.request.mock.calls.some(([method]) => method === 'config.applyAndStart')).toBe(
      false,
    );
  });
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
  it('does not create a startup overlay for config validation', async () => {
    const env = service();
    const command = deferred<unknown>();
    env.request.mockReturnValueOnce(command.promise);
    const validation = env.session.run('config.validate');
    expect(env.session.getSnapshot().pendingOperation).toBeUndefined();
    command.resolve({});
    await validation;
  });
});

it('clears native activity on subsequent stages and rejects stale reports', async () => {
  const env = service();
  await env.session.refresh();
  env.session.message({
    type: 'event',
    apiVersion: 1,
    instanceId: 'service-a',
    sequence: 10,
    timestampMs: 1,
    kind: 'runtime.activity',
    payload: { phase: 'enablePublic', elapsedMs: 45000 },
  });
  expect(env.session.getSnapshot().nativeActivity?.elapsedMs).toBe(45000);
  env.session.message({
    type: 'event',
    apiVersion: 1,
    instanceId: 'service-a',
    sequence: 11,
    timestampMs: 2,
    kind: 'runtime.progress',
    payload: snapshot(),
  });
  expect(env.session.getSnapshot().nativeActivity).toBeUndefined();
  env.session.message({
    type: 'event',
    apiVersion: 1,
    instanceId: 'service-a',
    sequence: 10,
    timestampMs: 1,
    kind: 'runtime.activity',
    payload: { phase: 'enablePublic', elapsedMs: 45000 },
  });
  expect(env.session.getSnapshot().nativeActivity).toBeUndefined();
  env.session.transport({ connected: false });
  expect(env.session.getSnapshot().nativeActivity).toBeUndefined();
});
