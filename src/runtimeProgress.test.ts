import { describe, expect, it } from 'vitest';
import { runtimeOperation, runtimeProgress } from './runtimeProgress';
const state = {
  connected: true,
  snapshot: { core: { state: 'running' }, lifecycle: null },
};
describe('runtime progress', () => {
  it('only blocks lifecycle commands, not validation or settings', () => {
    expect(runtimeOperation('config.validate')).toBeUndefined();
    expect(runtimeOperation('startup.set')).toBeUndefined();
    expect(runtimeOperation('config.applyAndStart')).toBe('apply');
    expect(runtimeProgress(state)).toBeNull();
  });
  it('uses service phases even while the core is already running', () => {
    expect(
      runtimeProgress({
        ...state,
        snapshot: {
          ...state.snapshot,
          lifecycle: {
            operation: 'apply',
            stage: 'applySettings',
            percent: 93,
            recovering: false,
          },
        },
      }),
    ).toEqual({
      title: 'Applying graph',
      stage: 'Applying Windows settings',
      percent: 93,
    });
  });
  it('keeps recovery indeterminate and does not lock the graph to offline stale progress', () => {
    const snapshot = {
      core: { state: 'starting' },
      lifecycle: {
        operation: 'apply',
        stage: 'waitCore',
        percent: null,
        recovering: true,
      },
    } as const;
    expect(runtimeProgress({ connected: true, snapshot })?.title).toBe(
      'Restoring previous configuration',
    );
    expect(runtimeProgress({ connected: false, snapshot })).toBeNull();
    expect(runtimeProgress({ connected: false, snapshot, pendingOperation: 'apply' })?.stage).toBe(
      'Waiting for service',
    );
  });
  it('covers resource preparation, final refresh and older service transitions', () => {
    expect(
      runtimeProgress({
        ...state,
        pendingOperation: 'start',
        commandStage: 'resources',
      })?.stage,
    ).toBe('Preparing resource files');
    expect(
      runtimeProgress({
        ...state,
        pendingOperation: 'stop',
        commandStage: 'refresh',
      })?.stage,
    ).toBe('Refreshing runtime state');
    expect(
      runtimeProgress({
        connected: true,
        snapshot: { core: { state: 'stopping' } },
      })?.title,
    ).toBe('Stopping networking');
    expect(
      runtimeProgress({
        ...state,
        snapshot: { core: { state: 'stopping' }, lifecycle: null },
      }),
    ).toBeNull();
  });
});

for (const [stage, expected] of [
  ['startTun', 'Configuring TUN capture'],
  ['retireTun', 'Stopping TUN capture'],
  ['startSharing', 'Configuring Internet sharing'],
  ['retireSharing', 'Stopping sharing capture'],
  ['updateRules', 'Updating routing rules'],
] as const) {
  it(`names ${stage} without claiming unrelated work`, () =>
    expect(
      runtimeProgress({
        ...state,
        snapshot: {
          ...state.snapshot,
          lifecycle: {
            operation: 'apply',
            stage,
            percent: 70,
            recovering: false,
          },
        },
      })?.stage,
    ).toBe(expected));
}

it('names an automatic resource refresh separately from edited-graph Apply', () => {
  expect(
    runtimeProgress({
      connected: true,
      snapshot: {
        core: { state: 'running' },
        lifecycle: {
          operation: 'reloadResources',
          stage: 'validate',
          percent: 10,
          recovering: false,
        },
      },
    })?.title,
  ).toBe('Refreshing resource filters');
});

it('shows observed native sharing phases without an invented percentage', () => {
  const pending = {
    ...state,
    pendingOperation: 'start' as const,
    nativeActivity: { phase: 'enablePublic' as const, elapsedMs: 61234 },
  };
  expect(runtimeProgress(pending)).toEqual({
    title: 'Starting networking',
    stage: 'Windows is enabling public sharing',
    elapsedSeconds: 61,
    percent: null,
  });
  expect(runtimeProgress({ ...pending, connected: false })?.stage).toBe('Waiting for service');
  expect(runtimeProgress({ ...state, nativeActivity: pending.nativeActivity })).toBeNull();
});
