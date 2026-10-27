// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTrafficExample } from './graph/example';
import { bundledExamples } from './graph/examples';
import { compileRuntimeGraph } from './graph/runtime';
import { RuntimeSession } from './runtimeSession';
import type { ServiceSnapshot } from './serviceClient';
import type { RuntimeController } from './useRuntime';
import { makeNode } from './graph/catalog';
import { factoryDefaults } from './graph/defaults';
import type { GraphState } from './graph/types';
import useGraphAnalysis from './useGraphAnalysis';
import createGraphRuntimeActions from './createGraphRuntimeActions';
import GraphRuntimeToolbar from './components/GraphRuntimeToolbar';
import GraphCheckDialog from './components/GraphCheckDialog';
import RuntimePanel from './components/RuntimePanel';
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
    core: { state: 'stopped', generation: 1, pid: null, version: 'test', lastError: null },
    winDivert: { available: true, mode: 'sniffOnly', state: 'stopped', packets: 0, bytes: 0 },
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
    limits: { configBytes: 10_000_000, outbounds: 10_000, routingRules: 10_000 },
    refresh: vi.fn(async () => {}),
    run: vi.fn(async () => ({})),
    setError: vi.fn(),
    setNotice: vi.fn(),
    clearEvents: vi.fn(),
  };
}
let root: Root, host: HTMLDivElement;
const result = vi.fn(),
  failure = vi.fn(),
  check = vi.fn();
function Harness({
  runtime,
  showPanel = false,
  pending = false,
  draft = graph,
  showCheck = true,
}: {
  runtime: RuntimeController;
  showPanel?: boolean;
  pending?: boolean;
  draft?: GraphState;
  showCheck?: boolean;
}) {
  const [checkOpen, setCheckOpen] = useState(showCheck);
  const analysis = useGraphAnalysis(draft);
  const actions = createGraphRuntimeActions(draft, { ...analysis, pending }, runtime);
  return (
    <>
      <GraphRuntimeToolbar
        actions={actions}
        onCheck={() => {
          check();
          setCheckOpen(true);
        }}
        onResult={result}
        onError={failure}
      />
      {checkOpen && (
        <GraphCheckDialog actions={actions} onIssue={vi.fn()} onClose={() => setCheckOpen(false)} />
      )}
      {showPanel && (
        <RuntimePanel
          graph={draft}
          runtime={runtime}
          actions={actions}
          onClose={vi.fn()}
          onIssue={vi.fn()}
        />
      )}
    </>
  );
}
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement;
const primary = () =>
  host.querySelector<HTMLButtonElement>('.graph-runtime-actions .primary-button')!;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
it('opens Validate through Check and applies a new draft on Start', async () => {
  const runtime = fixture();
  runtime.savedConfig = null;
  await act(() => root.render(<Harness runtime={runtime} showCheck={false} />));
  expect(button('Validate')).toBeUndefined();
  expect(
    [...host.querySelectorAll('.graph-runtime-actions button')].map((b) => b.textContent?.trim()),
  ).toEqual(['Check', 'Start', 'Stop']);
  await act(() => button('Check').click());
  expect(check).toHaveBeenCalledOnce();
  expect(runtime.run).not.toHaveBeenCalled();
  await act(() => button('Validate').click());
  expect(runtime.run).toHaveBeenLastCalledWith('config.validate', {
    config: compiled.config,
    resources: compiled.resources,
  });
  await act(() => primary().click());
  expect(runtime.run).toHaveBeenLastCalledWith(
    'config.applyAndStart',
    {
      config: compiled.config,
      resources: compiled.resources,
      expectedRevision: 3,
    },
    undefined,
  );
  expect(button('Stop').disabled).toBe(true);
});
it('disables validation and activation for pending checks, offline state and capacity failure', async () => {
  const runtime = fixture();
  await act(() => root.render(<Harness runtime={runtime} pending />));
  expect(button('Validate').disabled).toBe(true);
  expect(primary().disabled).toBe(true);
  expect(button('Check').disabled).toBe(false);
  await act(() => root.render(<Harness runtime={{ ...runtime, connected: false }} />));
  expect(button('Validate').disabled).toBe(true);
  expect(primary().disabled).toBe(true);
  await act(() =>
    root.render(
      <Harness
        runtime={{ ...runtime, limits: { configBytes: 1, outbounds: 1, routingRules: 1 } }}
      />,
    ),
  );
  expect(button('Validate').disabled).toBe(true);
  expect(runtime.run).not.toHaveBeenCalled();
});
it('keeps Stop available when an invalid graph is being edited', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'failed';
  await act(() =>
    root.render(
      <Harness
        runtime={runtime}
        draft={{ name: 'Empty', defaults: factoryDefaults(), nodes: [], edges: [] }}
      />,
    ),
  );
  expect(primary().disabled).toBe(true);
  expect(button('Stop').disabled).toBe(false);
  await act(() => button('Stop').click());
  expect(runtime.run).toHaveBeenLastCalledWith('core.stop', {});
});
it('activation leaves proxy assignment to central capture settings', async () => {
  const runtime = fixture();
  await act(() => root.render(<Harness runtime={runtime} showPanel />));
  expect(host.textContent).not.toContain('Use Windows proxy when applying');
  await act(() => primary().click());
  expect(runtime.run).toHaveBeenLastCalledWith('core.start', { revision: 3 });
});
it('blocks foreign capture, permits revalidation and never auto-starts after it clears', async () => {
  const input = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture'),
    direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  const draft = {
    name: 'Capture',
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
    availability: { state: 'unknown', message: 'Ownership is unknown.' },
  };
  await act(() => root.render(<Harness runtime={runtime} draft={draft} />));
  expect(primary().disabled).toBe(true);
  expect(button('Validate').disabled).toBe(false);
  runtime.snapshot!.capture.availability = { state: 'available', message: null };
  await act(() => root.render(<Harness runtime={{ ...runtime }} draft={draft} />));
  expect(primary().disabled).toBe(false);
  expect(runtime.run).not.toHaveBeenCalled();
});
it('reports a failed runtime action without a success message', async () => {
  const runtime = fixture();
  runtime.run = vi.fn(async () => {
    throw new Error('Busy listener');
  });
  await act(() => root.render(<Harness runtime={runtime} />));
  await act(() => primary().click());
  expect(failure).toHaveBeenCalledOnce();
  expect(result).not.toHaveBeenCalled();
});
it('permits syntax validation but prevents starting a fictional example', async () => {
  const runtime = fixture();
  await act(() => root.render(<Harness runtime={runtime} draft={createTrafficExample()} />));
  expect(button('Validate').disabled).toBe(false);
  expect(primary().disabled).toBe(true);
  expect(primary().title).toContain('working profile');
  await act(() => primary().click());
  expect(runtime.run).not.toHaveBeenCalled();
});
it.each([
  ['configured.example.org', 'wayrill-example', true],
  ['edge.example.net', 'configured-user', true],
  ['configured.example.org', 'configured-user', false],
])('checks edited example destination %s / %s', async (address, id, blocked) => {
  const draft = createTrafficExample();
  Object.assign(draft.nodes.find((n) => n.id === 'preferred')!.data.settings, { address, id });
  await act(() => root.render(<Harness runtime={fixture()} draft={draft} />));
  expect(primary().disabled).toBe(blocked);
});

it.each(bundledExamples.filter((example) => ['traffic', 'policy', 'chain'].includes(example.id)))(
  'requires replacing sample servers in $label before activation',
  async (example) => {
    const runtime = fixture();
    runtime.capabilities.push('xray.observatory');
    runtime.protocols = { ...runtime.protocols!, inbound: ['mixed'] };
    await act(() => root.render(<Harness runtime={runtime} draft={example.create()} />));
    expect(primary().disabled).toBe(true);
    expect(primary().title).toContain('working profile');
    await act(() => primary().click());
    expect(runtime.run).not.toHaveBeenCalled();
  },
);

it.each([
  ['stopped', false, 'Start', 'core.start'],
  ['stopped', true, 'Start', 'config.applyAndStart'],
  ['running', false, 'Restart', 'core.restart'],
  ['running', true, 'Apply', 'config.applyAndStart'],
  ['failed', false, 'Restart', 'core.restart'],
  ['failed', true, 'Apply', 'config.applyAndStart'],
] as const)('uses %s / changed=%s → %s', async (state, changed, label, method) => {
  const runtime = fixture();
  runtime.snapshot!.core.state = state;
  if (changed) runtime.savedConfig = null;
  await act(() => root.render(<Harness runtime={runtime} showCheck={false} />));
  expect(primary().textContent).toBe(label);
  await act(() => primary().click());
  expect(runtime.run).toHaveBeenCalledExactlyOnceWith(
    method,
    method === 'config.applyAndStart'
      ? { config: compiled.config, resources: compiled.resources, expectedRevision: 3 }
      : { revision: 3 },
    ...(method === 'config.applyAndStart' ? [undefined] : []),
  );
});
it('reloads resource contents with Restart without reapplying an unchanged graph', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  runtime.snapshot!.resources = { restartRequired: true } as ServiceSnapshot['resources'];
  await act(() => root.render(<Harness runtime={runtime} />));
  expect(primary().textContent).toBe('Restart');
  await act(() => primary().click());
  expect(runtime.run).toHaveBeenCalledWith('core.restart', { revision: 3 });
});
it('does not reuse an applied profile when only its capture scope differs', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  runtime.savedCapture = {
    version: 2,
    inputs: [],
    interfaces: { monitorNewInterfaces: false, interfaces: [] },
    bypassLocalTraffic: true,
  };
  await act(() => root.render(<Harness runtime={runtime} />));
  expect(primary().textContent).toBe('Apply');
});
it('allows warnings, blocks errors, and clears validation success when the graph changes', async () => {
  const runtime = fixture();
  const warningDraft = structuredClone(graph);
  const unused = makeNode('direct-outbound', { x: 900, y: 800 }, 'unused');
  unused.data.settings.tag = 'unused';
  warningDraft.nodes.push(unused);
  await act(() => root.render(<Harness runtime={runtime} draft={warningDraft} />));
  expect(host.textContent).toContain('warning');
  expect(button('Validate').disabled).toBe(false);
  await act(() => button('Validate').click());
  expect(host.textContent).toContain('Xray validation passed.');
  await act(() =>
    root.render(<Harness runtime={runtime} draft={{ ...warningDraft, edges: [] }} />),
  );
  expect(button('Validate').disabled).toBe(true);
  expect(host.textContent).not.toContain('Xray validation passed.');
});
it('ignores a validation reply belonging to the previous graph', async () => {
  const runtime = fixture();
  let complete!: () => void;
  runtime.run = vi.fn(
    () =>
      new Promise<object>((resolve) => {
        complete = () => resolve({});
      }),
  );
  await act(() => root.render(<Harness runtime={runtime} />));
  await act(() => button('Validate').click());
  expect(button('Validating…').disabled).toBe(true);
  await act(() => root.render(<Harness runtime={runtime} draft={{ ...graph, edges: [] }} />));
  await act(() => complete());
  expect(host.textContent).not.toContain('Xray validation passed.');
  expect(button('Validate').disabled).toBe(true);
});
it('shows Xray validation errors inside the Check window', async () => {
  const runtime = fixture();
  runtime.run = vi.fn(async () => {
    throw new Error('Invalid Xray option');
  });
  await act(() => root.render(<Harness runtime={runtime} />));
  await act(() => button('Validate').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid Xray option');
  expect(host.textContent).not.toContain('Xray validation passed.');
});

it('Stop respects a disabled ICS TUN draft without requiring that draft to compile', async () => {
  const runtime = fixture();
  runtime.snapshot!.core.state = 'running';
  const draft = structuredClone(graph);
  const shared = makeNode('ics-tun', { x: 0, y: 0 }, 'sharing');
  shared.data.enabled = false;
  draft.nodes.push(shared);
  const actions = createGraphRuntimeActions(
    draft,
    { compilation: null, issues: [], pending: false } as unknown as ReturnType<
      typeof useGraphAnalysis
    >,
    runtime,
  );
  expect(await actions.stop()).toBe(true);
  expect(runtime.run).toHaveBeenCalledWith('core.stop', { disableSharing: true });
});

it('keeps validation successful and identifies unavailable geodata rules in Check', async () => {
  const runtime = fixture();
  vi.mocked(runtime.run).mockResolvedValue({
    resourceWarnings: {
      skippedSelectorCount: 1,
      skippedSelectors: [{ selector: 'geoip:retired', context: 'Traffic rule 3 · ip' }],
    },
  });
  await act(() => root.render(<Harness runtime={runtime} />));
  await act(async () => button('Validate').click());
  expect(host.textContent).toContain('Xray validation passed.');
  expect(host.textContent).toContain('1 unavailable geodata entry skipped');
  expect(host.textContent).toContain('geoip:retired');
});
