// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RuntimePanel from './RuntimePanel';
import { RuntimeSession } from '../runtimeSession';
import type { RuntimeController } from '../useRuntime';
import type { ServiceSnapshot } from '../serviceClient';
import { createTrafficExample } from '../graph/example';
import { compileRuntimeGraph } from '../graph/runtime';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';

let root: Root, host: HTMLDivElement;
const graph = createTrafficExample();
graph.nodes.find((n) => n.id === 'preferred')!.data.description =
  'Synthetic configured test destination';
const compiled = compileRuntimeGraph(graph);
function fixture(): RuntimeController {
  const snapshot: ServiceSnapshot = {
    serviceVersion: 'test',
    apiVersion: 1,
    instanceId: 'fictional',
    ownerSid: 'fictional',
    uptimeSeconds: 1,
    config: { present: true, revision: 3, sha256: 'fictional' },
    core: {
      state: 'stopped',
      generation: 1,
      pid: null,
      version: 'test',
      lastError: null,
    },
    winDivert: {
      available: true,
      mode: 'sniffOnly',
      state: 'stopped',
      packets: 0,
      bytes: 0,
    },
    systemProxy: { managed: false, conflict: false, recoveryPending: false },
  };
  return {
    ...new RuntimeSession(async <T,>() => ({}) as T).getSnapshot(),
    desktop: true,
    connected: true,
    snapshot,
    savedRevision: 3,
    savedConfig: compiled.config,
    capabilities: ['config.applyAndStart', 'xray.lifecycle'],
    protocols: {
      inbound: (compiled.config.inbounds as { protocol: string }[]).map((i) => i.protocol),
      outbound: (compiled.config.outbounds as { protocol: string }[]).map((i) => i.protocol),
      adapterRuntime: false,
    },
    limits: {
      configBytes: 10_000_000,
      outbounds: 10_000,
      routingRules: 10_000,
    },
    refresh: vi.fn(async () => {}),
    run: vi.fn(async () => ({})),
    setError: vi.fn(),
    setNotice: vi.fn(),
    clearEvents: vi.fn(),
  };
}
async function render(runtime: RuntimeController) {
  await act(() =>
    root.render(
      <RuntimePanel graph={graph} runtime={runtime} onIssue={vi.fn()} onClose={vi.fn()} />,
    ),
  );
  if (button('Check')) await act(() => button('Check').click());
}
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const primary = () => host.querySelector<HTMLButtonElement>('.runtime-actions .primary-button')!;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

it('shows a matching revision without implying that the stopped core is running', async () => {
  const runtime = fixture();
  await render(runtime);
  expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    'Runtime',
    'Events (0)',
  ]);
  expect(host.querySelector('.runtime-cards')?.textContent).toContain('stopped');
  expect(host.textContent).toContain('Draft matches applied revision 3');
  expect(host.textContent).toContain('Draft preview');
  expect(button('Stop').disabled).toBe(true);
  expect(primary().disabled).toBe(false);
  await act(() => button('Validate').click());
  expect(runtime.run).toHaveBeenCalledExactlyOnceWith('config.validate', {
    config: compiled.config,
    resources: compiled.resources,
  });
  await act(() => primary().click());
  expect(runtime.run).toHaveBeenLastCalledWith('core.start', { revision: 3 });
});

it('turns stale offline cards into unknown state and disables runtime mutations', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  runtime.notice = 'Previous successful operation';
  await render(runtime);
  await render({ ...runtime, connected: false });
  expect([...host.querySelectorAll('.runtime-cards strong')].map((c) => c.textContent)).toEqual([
    'Unknown',
    'Unknown',
    'Unknown',
    'Unknown',
  ]);
  expect(host.textContent).toContain('last known: running');
  expect(host.textContent).not.toContain('Draft matches applied');
  expect(host.textContent).not.toContain('Previous successful operation');
  expect(button('Validate').disabled).toBe(true);
  expect(primary().disabled).toBe(true);
  expect(button('Stop').disabled).toBe(true);
  expect(button('Refresh').disabled).toBe(false);
});

it('keeps browser runtime unknown instead of claiming no configuration has been applied', async () => {
  await render({
    ...fixture(),
    desktop: false,
    connected: false,
    snapshot: null,
  });
  expect(host.textContent).not.toContain('Draft has not been applied');
  expect(host.textContent).toContain('Draft comparison unavailable');
  expect(button('Refresh').disabled).toBe(true);
});

it('makes proxy conflicts visible even while an ownership journal remains managed', async () => {
  const runtime = fixture();
  runtime.snapshot!.systemProxy = {
    managed: true,
    conflict: true,
    recoveryPending: false,
  };
  await render(runtime);
  expect(host.querySelector('.runtime-cards')?.textContent).toContain('External change');
  expect(host.textContent).toContain('External settings are preserved');
});

it('distinguishes deferred user settings from failed routing and hides stale notices offline', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  runtime.snapshot!.userSettings = { waitingForUser: true, lastError: null };
  await render(runtime);
  expect(host.textContent).toContain('User proxy settings will resume after sign-in.');
  expect(button('Stop').disabled).toBe(false);
  runtime.snapshot!.userSettings = {
    waitingForUser: false,
    lastError: {
      code: 'SETTINGS_CONFLICT',
      message: 'External user settings were preserved.',
      retryable: false,
    },
  };
  await render(runtime);
  expect(host.textContent).not.toContain('User proxy settings will resume after sign-in.');
  expect(host.textContent).toContain('External user settings were preserved.');
  await render({ ...runtime, connected: false });
  expect(host.textContent).not.toContain('User proxy settings need attention');
  runtime.snapshot!.userSettings = { waitingForUser: false, lastError: null };
  await render(runtime);
  expect(host.textContent).not.toContain('User proxy settings will resume after sign-in.');
  expect(host.textContent).not.toContain('User proxy settings need attention');
});

it.each(['failed core', 'pending proxy recovery'])(
  'keeps Stop available to clean up a %s',
  async (scenario) => {
    const runtime = fixture();
    if (scenario === 'failed core') runtime.snapshot!.core.state = 'failed';
    else
      runtime.snapshot!.systemProxy = {
        managed: true,
        conflict: false,
        recoveryPending: true,
      };
    await render(runtime);
    expect(button('Stop').disabled).toBe(false);
    await act(() => button('Stop').click());
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith('core.stop', {});
  },
);

it('blocks validation and activation while current graph checks are pending and keeps Stop available', async () => {
  const runtime = fixture();
  runtime.snapshot = {
    ...runtime.snapshot!,
    core: { ...runtime.snapshot!.core, state: 'running' },
  };
  await act(async () =>
    root.render(
      <RuntimePanel
        graph={graph}
        runtime={runtime}
        analysis={{
          issues: [],
          compilation: null,
          configBytes: 0,
          pending: true,
        }}
        onIssue={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() => button('Check').click());
  expect(button('Validate').disabled).toBe(true);
  expect(primary().disabled).toBe(true);
  expect(button('Stop').disabled).toBe(false);
  expect(host.textContent).toContain('Checking graph…');
  expect(runtime.run).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <RuntimePanel
        graph={graph}
        runtime={runtime}
        analysis={{
          issues: [],
          compilation: compiled,
          configBytes: 100,
          pending: false,
        }}
        onIssue={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(button('Validate').disabled).toBe(false);
  expect(primary().disabled).toBe(false);
});

it('identifies an earlier failed command separately from the current draft', async () => {
  const runtime = fixture();
  runtime.error = 'Capture preflight failed';
  runtime.errorAction = 'config.applyAndStart';
  await render(runtime);
  expect(host.textContent).toContain('Last command: Apply');
  expect(host.textContent).toContain('Capture preflight failed');
  runtime.error = 'Service disconnected';
  runtime.errorAction = undefined;
  await render(runtime);
  expect(host.textContent).not.toContain('Last command:');
});

it.each(['blocked', 'unknown'] as const)(
  'warns about %s capture ownership while preserving ordinary proxy use',
  async (state) => {
    const runtime = fixture();
    runtime.snapshot!.capture = {
      state: 'stopped',
      mode: 'routing',
      inputs: [],
      availability: {
        state,
        message: 'v2rayN is using WinDivert. Wayrill capture remains off.',
      },
    };
    await render(runtime);
    expect(host.textContent).toContain('v2rayN is using WinDivert');
    expect(primary().disabled).toBe(false); // No WinDivert inbound in this graph.
    await act(() => button('Refresh').click());
    expect(runtime.refresh).toHaveBeenCalledOnce();
    expect(runtime.run).not.toHaveBeenCalled();
  },
);

it('disables capture activation, permits revalidation, and never auto-starts after a conflict clears', async () => {
  const input = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture');
  const direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  const captureGraph = {
    name: 'Capture test',
    defaults: factoryDefaults(),
    nodes: [input, direct],
    edges: ['data', 'dns'].map((port) => ({
      id: port,
      source: input.id,
      sourceHandle: port,
      target: direct.id,
      targetHandle: 'in',
    })),
  };
  const runtime = fixture();
  runtime.capabilities.push('windivert.ruleProcesses');
  runtime.snapshot!.capture = {
    state: 'stopped',
    mode: 'routing',
    inputs: [],
    availability: { state: 'blocked', message: 'Another router owns capture.' },
  };
  const draw = async () =>
    act(() =>
      root.render(
        <RuntimePanel
          graph={captureGraph}
          runtime={{ ...runtime }}
          onIssue={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
  await draw();
  await act(() => button('Check').click());
  expect(primary().disabled).toBe(true);
  expect(button('Validate').disabled).toBe(false);
  runtime.snapshot!.capture.availability = {
    state: 'available',
    message: null,
  };
  await draw();
  expect(primary().disabled).toBe(false);
  expect(runtime.run).not.toHaveBeenCalled();
});

it('shows one explanation when the command, core and capture report the same current conflict', async () => {
  const runtime = fixture();
  const message = 'v2rayN is using WinDivert. Wayrill capture remains off.';
  runtime.snapshot!.capture = {
    state: 'stopped',
    mode: 'routing',
    inputs: [],
    lastError: `WINDIVERT_CONFLICT: ${message}`,
    availability: { state: 'blocked', message },
  };
  runtime.snapshot!.core.lastError = {
    code: 'CAPTURE_FAILED',
    message: `WINDIVERT_CONFLICT: ${message}`,
    retryable: false,
  };
  runtime.error = `WINDIVERT_CONFLICT: ${message}`;
  runtime.errorAction = 'config.applyAndStart';
  await render(runtime);
  expect(host.textContent!.split(message)).toHaveLength(2);
});

it('identifies a retained capture error as previous after ownership is available again', async () => {
  const runtime = fixture();
  runtime.snapshot!.capture = {
    state: 'stopped',
    mode: 'routing',
    inputs: [],
    lastError: 'Old capture error',
    availability: { state: 'available', message: null },
  };
  await render(runtime);
  expect(host.textContent).toContain('Previous capture failure');
  expect(host.textContent).not.toContain('WinDivert is in use');
});

it('keeps damaged-profile recovery actionable while the service and Stop remain available', async () => {
  const runtime = fixture();
  runtime.snapshot!.config.present = false;
  runtime.snapshot!.config.recoveryError = {
    code: 'STATE_INTEGRITY',
    message:
      'Routing is stopped. Open your saved graph, run Check and Validate, then Start to restore routing. The original profile was preserved.',
    retryable: false,
  };
  runtime.snapshot!.core.lastError = runtime.snapshot!.config.recoveryError;
  await render(runtime);
  expect(host.textContent).toContain('Saved configuration needs recovery');
  expect(host.textContent).toContain('original profile was preserved');
  expect(host.textContent).not.toContain('Previous core failure');
  expect(primary().disabled).toBe(false);
  await act(() => button('Stop').click());
  await render(runtime);
  expect(host.textContent).toContain('Saved configuration needs recovery');
});

it('shows service phases in an open Run graph dialog while Close stays available', async () => {
  const runtime = fixture();
  runtime.snapshot!.lifecycle = {
    operation: 'stop',
    stage: 'restoreSettings',
    percent: 65,
    recovering: false,
  };
  await render(runtime);
  expect(host.querySelector('[role="status"].runtime-progress-card')?.textContent).toContain(
    'Restoring Windows settings',
  );
  expect(
    host.querySelector('.runtime-body')?.closest('.workspace-body')?.hasAttribute('inert'),
  ).toBe(true);
  expect((host.querySelector('[aria-label="Close Run graph"]') as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(button('Close').disabled).toBe(false);
  expect(primary().disabled).toBe(true);
});

it('shows uplink waiting separately from a retained running TUN worker', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  runtime.snapshot!.tun = {
    state: 'running',
    pid: 3,
    name: 'WayrillTUN',
    interfaceIndex: 5,
    uplink: 'Wi-Fi',
  };
  runtime.snapshot!.network = {
    state: 'waiting',
    lastError: {
      code: 'TUN_UPLINK_UNAVAILABLE',
      message: 'Waiting for Wi-Fi.',
      retryable: true,
    },
    uplinks: [],
  };
  await render(runtime);
  expect(host.textContent).toContain('Waiting for uplink');
  expect(host.textContent).toContain('Waiting for Wi-Fi.');
  expect(button('Stop').disabled).toBe(false);
  runtime.snapshot!.network.state = 'reconnecting';
  await render(runtime);
  expect(host.textContent).toContain('Reconnecting');
});

it('shows unattended recovery and leaves Stop available even between attempts', async () => {
  const runtime = fixture();
  runtime.snapshot!.recovery = {
    desiredState: 'running',
    state: 'waiting',
    attempts: 4,
    nextAttemptMs: 123,
    lastError: null,
  };
  await render(runtime);
  expect(host.textContent).toContain('Recovering routing automatically');
  expect(button('Stop').disabled).toBe(false);
  await act(async () => button('Stop').click());
  expect(runtime.run).toHaveBeenCalledWith('core.stop', {});
});
it('distinguishes automatic stopped-state cleanup from restarting routing', async () => {
  const runtime = fixture();
  runtime.snapshot!.recovery = {
    desiredState: 'stopped',
    state: 'waiting',
    attempts: 2,
    nextAttemptMs: 123,
    lastError: null,
  };
  await render(runtime);
  expect(host.textContent).toContain('Finishing system restoration automatically');
  expect(host.textContent).not.toContain('Recovering routing automatically');
});
