// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useGraphActivity, { useGraphActivityPreference } from './useGraphActivity';
import { activityPortKey, GRAPH_ACTIVITY_KEY } from './graph/activity';
import { GraphActivityProvider, useGraphActivityLevel } from './components/GraphActivity';
import { serviceCall } from './serviceClient';
import type { RuntimeController } from './useRuntime';
import { createProxyStarter } from './graph/examples';
import { createDnsExample } from './graph/example';
import { compileRuntimeGraph } from './graph/runtime';
import type { ActivitySnapshot, GraphActivity } from './graph/activity';
import { runtimePresentation } from './runtimePresentation';

vi.mock('./serviceClient', () => ({ serviceCall: vi.fn() }));
const graph = createProxyStarter(),
  compiled = compileRuntimeGraph(graph);
const index = Number(
  Object.entries(compiled.activityInputs!).find(([, input]) => input.port === 'data')![0],
);
const snapshot = (revision = 1): ActivitySnapshot => ({
  instanceId: 'service',
  generation: 1,
  revision,
  state: 'collecting',
  rules: [{ index, matches: 2 }],
});
let root: Root, host: HTMLDivElement, activity: GraphActivity;
let preference: ReturnType<typeof useGraphActivityPreference>;
let hidden = false;
function Probe({
  enabled = true,
  revision = 1,
  applied = true,
}: {
  enabled?: boolean;
  revision?: number;
  applied?: boolean;
}) {
  const runtime = {
    connected: true,
    capabilities: ['routing.activity'],
    savedRevision: revision,
    snapshot: { instanceId: 'service', core: { state: 'running', generation: 1 } },
  } as RuntimeController;
  activity = useGraphActivity({ enabled, graph, compilation: applied ? compiled : null, runtime });
  preference = useGraphActivityPreference();
  return null;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.mocked(serviceCall).mockReset();
  localStorage.clear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const render = async (props: Parameters<typeof Probe>[0] = {}) => {
  await act(async () => root.render(<Probe {...props} />));
};
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it('does no work while off/hidden and never overlaps reads; stale and late replies cannot relight the graph', async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(serviceCall).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render({ enabled: false });
  await tick(3000);
  expect(serviceCall).not.toHaveBeenCalled();
  await render();
  await tick(5000);
  expect(serviceCall).toHaveBeenCalledTimes(1);
  await act(async () => finish(snapshot()));
  expect(activity.edges.has('proxy-data')).toBe(true);
  await tick(1000);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await tick(4000);
  expect(activity.edges.size).toBe(0); // Hung next read expires the last result.
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => finish(snapshot()));
  await tick(5000);
  expect(activity.edges.size).toBe(0);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(serviceCall).toHaveBeenCalledTimes(3);
  const oldReply = finish;
  await render({ revision: 2 });
  expect(serviceCall).toHaveBeenCalledTimes(3);
  await act(async () => oldReply(snapshot()));
  expect(activity.edges.size).toBe(0);
  await tick(1000);
  await act(async () => finish(snapshot(2)));
  expect(activity.edges.has('proxy-data')).toBe(true);
  await render({ revision: 2, applied: false });
  expect(activity.edges.size).toBe(0);
  const calls = vi.mocked(serviceCall).mock.calls.length;
  await tick(5000);
  expect(serviceCall).toHaveBeenCalledTimes(calls);
});

it('keeps the toggle outside the graph, persists it, and follows restored preferences', async () => {
  await render({ enabled: false });
  expect(preference.enabled).toBe(false);
  await act(async () => preference.setEnabled(true));
  expect(localStorage.getItem(GRAPH_ACTIVITY_KEY)).toBe('true');
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent('storage', { key: GRAPH_ACTIVITY_KEY, newValue: 'false' }),
    ),
  );
  expect(preference.enabled).toBe(false);
});

it('keeps one in-flight read across rapid toggles and visibility changes', async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(serviceCall).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  for (let i = 0; i < 4; i++) {
    await render({ enabled: false });
    await render();
  }
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(serviceCall).toHaveBeenCalledTimes(1);
  await act(async () => finish(snapshot()));
  expect(activity.edges.size).toBe(0);
  await tick(1000);
  expect(serviceCall).toHaveBeenCalledTimes(2);
  await act(async () => finish(snapshot()));
  expect(activity.edges.has('proxy-data')).toBe(true);
});

it('lights a retained DNS profile after upgrade without repainting the editor', async () => {
  let editorRenders = 0;
  const rendered = new Map<string, number>();
  const dnsGraph = createDnsExample();
  const compilation = compileRuntimeGraph(dnsGraph);
  const edge = dnsGraph.edges.find((item) => item.id === 'dns-local')!;
  const resolver = Object.entries(compilation.resolverActivity!).find(([, hops]) =>
    hops.some(({ nodeId, port }) => nodeId === edge.source && port === edge.sourceHandle),
  )![0];
  const target = activityPortKey(edge.target, 'target', edge.targetHandle ?? 'in');
  const idle = { ...snapshot(), rules: [] };
  const priorConfig = structuredClone(compilation.config);
  const priorDns = priorConfig.dns as { servers: Record<string, unknown>[] };
  priorDns.servers.forEach((server, index) => {
    // A retained 0.37.20 profile has the IDs that used to be saved with the graph.
    server.id = `wra-${String(index).padStart(22, 'A')}`;
  });
  vi.mocked(serviceCall).mockResolvedValue(idle);
  function Decoration({ id, kind }: { id: string; kind: 'edges' | 'ports' }) {
    const level = useGraphActivityLevel(kind, id);
    rendered.set(id, (rendered.get(id) ?? 0) + 1);
    return <span data-edge={id}>{level}</span>;
  }
  function Editor() {
    editorRenders++;
    const runtime = {
      desktop: true,
      connected: true,
      capabilities: ['routing.activity', 'xray.routingLog'],
      savedConfig: priorConfig,
      savedCapture: compilation.capture,
      savedDisplayNames: compilation.displayNames,
      savedRevision: 1,
      snapshot: {
        instanceId: 'service',
        config: { present: true, revision: 1 },
        core: { state: 'running', generation: 1 },
        systemProxy: {},
      },
    } as RuntimeController;
    const applied = runtimePresentation(runtime, compilation).appliedMatch;
    return (
      <GraphActivityProvider
        enabled
        graph={dnsGraph}
        compilation={applied ? compilation : null}
        runtime={runtime}
      >
        <Decoration kind="edges" id={edge.id} />
        <Decoration kind="edges" id="unrelated" />
        <Decoration kind="ports" id={target} />
      </GraphActivityProvider>
    );
  }
  await act(async () => root.render(<Editor />));
  await tick(5000);
  expect(serviceCall).toHaveBeenCalledTimes(6);
  expect(editorRenders).toBe(1);
  expect(rendered.get(edge.id)).toBe(1);
  const renders = () => [...rendered.values()].reduce((sum, count) => sum + count, 0);
  const before = renders();
  vi.mocked(serviceCall).mockResolvedValue({ ...idle, resolvers: [{ id: resolver, attempts: 2 }] });
  await tick(1000);
  const lit = renders() - before;
  const decoration = host.querySelector('[data-edge="dns-local"]')!;
  expect(Number(decoration.textContent)).toBeGreaterThan(0);
  const first = renders();
  await tick(1000);
  const repeated = renders() - first;
  vi.mocked(serviceCall).mockResolvedValue(idle);
  const last = renders();
  await tick(1000);
  const cleared = renders() - last;
  expect(decoration.textContent).toBe('0');
  expect(editorRenders).toBe(1);
  expect([lit, repeated, cleared]).toEqual([2, 0, 2]);
  expect(rendered.get('unrelated')).toBe(1);
});
