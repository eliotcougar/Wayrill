import type { GraphState } from './graph/types';
import { expect, it } from 'vitest';
import { runtimePresentation } from './runtimePresentation';
import { RuntimeSession } from './runtimeSession';
import type { ServiceSnapshot } from './serviceClient';
import { compileRuntimeGraph } from './graph/runtime';
import { makeNode } from './graph/catalog';
import { factoryDefaults } from './graph/defaults';

function fixture() {
  const input = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture');
  const direct = makeNode('direct-outbound', { x: 400, y: 0 }, 'direct');
  const graph: GraphState = {
    name: 'Fictional test capture',
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
  const draft = compileRuntimeGraph(graph);
  const snapshot: ServiceSnapshot = {
    serviceVersion: 'test',
    apiVersion: 1,
    instanceId: 'test',
    ownerSid: 'fictional',
    uptimeSeconds: 1,
    config: { present: true, revision: 7, sha256: 'fictional' },
    core: {
      state: 'running',
      generation: 1,
      pid: 123,
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
    capture: {
      state: 'running',
      mode: 'routing',
      inputs: [draft.capture!.inputs[0].tag],
    },
    systemProxy: { managed: false, conflict: false, recoveryPending: false },
  };
  const runtime = {
    ...new RuntimeSession(async <T>() => ({}) as T).getSnapshot(),
    desktop: true,
    connected: true,
    snapshot,
    savedRevision: 7,
    savedConfig: draft.config,
    savedCapture: draft.capture!,
  };
  return { graph, draft, snapshot, runtime };
}

it('requires Apply for missing or changed log metadata even when routing JSON is identical', () => {
  const { draft, runtime } = fixture();
  runtime.capabilities = [...runtime.capabilities, 'xray.routingLog'];
  draft.displayNames = {
    inbound: {},
    outbound: {},
    routing: {
      '0': [
        { filterId: 'filter', ruleId: 'rule', rule: 'Browser', outputId: 'proxy', output: 'Proxy' },
      ],
    },
  };
  expect(runtimePresentation(runtime, draft).appliedMatch).toBe(false);
  runtime.savedDisplayNames = structuredClone(draft.displayNames);
  expect(runtimePresentation(runtime, draft).appliedMatch).toBe(true);
  draft.displayNames.routing!['0'][0].output = 'Renamed connection';
  expect(runtimePresentation(runtime, draft).appliedMatch).toBe(false);
});
it('detects capture-only edits even when Xray JSON is identical', () => {
  const { graph, draft, runtime } = fixture();
  expect(runtimePresentation(runtime, draft).appliedMatch).toBe(true);
  graph.captureOptions = {
    interfaces: { monitorNewInterfaces: false, interfaces: [] },
    bypassLocalTraffic: true,
  };
  const edited = compileRuntimeGraph(graph);
  expect(edited.config).toEqual(draft.config);
  expect(runtimePresentation(runtime, edited)).toMatchObject({
    appliedMatch: false,
    draftState: 'Draft has unapplied changes',
    capture: { detail: '1 active inputs · 1 applied inputs' },
  });
});

it('retains a matched applied revision independently of a stopped core', () => {
  const { draft, runtime } = fixture();
  runtime.snapshot.core.state = 'stopped';
  runtime.snapshot.core.pid = null;
  runtime.snapshot.capture!.state = 'stopped';
  expect(runtimePresentation(runtime, draft)).toMatchObject({
    running: false,
    appliedMatch: true,
    footer: 'Xray stopped · r7 · Draft matches',
    capture: { detail: '0 active inputs · 1 applied inputs' },
  });
});

it('labels cached offline state as last known instead of active, applied or unmanaged', () => {
  const { draft, runtime } = fixture();
  runtime.connected = false;
  const view = runtimePresentation(runtime, draft);
  expect(view).toMatchObject({
    running: false,
    appliedMatch: false,
    core: { value: 'Unknown' },
    applied: { value: 'Unknown' },
    proxy: { value: 'Unknown' },
    capture: { value: 'Unknown' },
    footer: 'Runtime unknown · service offline',
  });
  expect(view.core.detail).toContain('last known: running');
  expect(view.applied.detail).toContain('Last known: revision 7');
});

it('keeps unknown state distinct from a confirmed absent applied profile', () => {
  const { draft, runtime } = fixture();
  const empty = { ...runtime, snapshot: null };
  expect(runtimePresentation(empty, draft).applied.value).toBe('Unknown');
  runtime.snapshot.config.present = false;
  expect(runtimePresentation(runtime, draft)).toMatchObject({
    appliedMatch: false,
    applied: { value: 'Not applied' },
    draftState: 'Draft has not been applied',
  });
});

it('waits for a synchronized profile before comparing an event revision', () => {
  const { draft, runtime } = fixture();
  runtime.savedRevision = 6;
  expect(runtimePresentation(runtime, draft)).toMatchObject({
    appliedMatch: false,
    draftState: 'Refreshing draft comparison',
    footer: 'Xray running · r7 · Comparing draft…',
  });
});

it('prioritizes external changes and pending recovery over a managed journal', () => {
  const { draft, runtime } = fixture();
  runtime.snapshot.systemProxy = {
    managed: true,
    conflict: true,
    recoveryPending: true,
  };
  expect(runtimePresentation(runtime, draft).proxy.value).toBe('External change');
  runtime.snapshot.systemProxy.conflict = false;
  expect(runtimePresentation(runtime, draft).proxy.value).toBe('Recovery pending');
});

it('does not present a browser draft as a known stopped or applied runtime', () => {
  const { draft, runtime } = fixture();
  expect(runtimePresentation({ ...runtime, desktop: false }, draft)).toMatchObject({
    current: false,
    running: false,
    appliedMatch: false,
    footer: 'Draft only · browser session',
    core: { value: 'Unknown', detail: 'Desktop app required' },
  });
});

it('reports an invalid graph without mislabelling a synchronized revision as pending', () => {
  const { runtime } = fixture();
  expect(runtimePresentation(runtime, null).draftState).toBe(
    'Fix graph errors to compare the draft',
  );
});

it.each([false, true])(
  'keeps resource freshness separate from the draft (automatic reload=%s)',
  (reloadPending) => {
    const { runtime, draft, snapshot } = fixture();
    snapshot.resources = { busy: false, generation: 2, restartRequired: true, reloadPending };
    const view = runtimePresentation(runtime, draft);
    expect(view.running).toBe(true);
    expect(view.appliedMatch).toBe(true);
    expect(view.footer).toContain('Draft matches');
    expect(view.footer).toContain(
      reloadPending ? 'Resource reload pending' : 'Resource reload required',
    );
    expect(view.draftState).toBe('Draft matches applied revision 7');
    // A pending reload does not conceal a real edit, or clear it when it finishes.
    const edited = { ...draft, config: { ...draft.config, dns: { servers: ['1.1.1.1'] } } };
    expect(runtimePresentation(runtime, edited).draftState).toBe('Draft has unapplied changes');
    snapshot.resources.restartRequired = false;
    snapshot.core.generation++;
    expect(runtimePresentation(runtime, draft).footer).toBe('Xray running · r7 · Draft matches');
    expect(runtimePresentation(runtime, edited).draftState).toBe('Draft has unapplied changes');
  },
);
