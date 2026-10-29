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
