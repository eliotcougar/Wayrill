import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { desktopServiceAvailable, serviceCall, errorText } from './serviceClient';
import type { GraphState } from './graph/types';
import { toDocument } from './graph/model';
import { serializeStash, type Stash, type StashEntry } from './profiles/import';
import { entryLink } from './profiles/stashModel';
import { stageOutboundTests } from './profiles/serviceSubscriptions';
import {
  mergeTestPlans,
  stashTestKey,
  type TestPlan,
  type TestRow,
  type TestSelection,
} from './outboundTestPlan';
import { useOutboundTestSettings } from './outboundTestSettings';
import { ObservatoryContext } from './observatorySummary';
import { drainTestJob } from './outboundTestJobs';
import { sameTestLibrary } from './profiles/library';
import { Gauge } from 'lucide-react';
import UdpTestBadge from './components/UdpTestBadge';

export type TestMode = 'latency' | 'speed';

export interface OutboundTestResult {
  id: string;
  latencyMs: number | null;
  ip: string | null;
  country: string | null;
  error: string | null;
  countryError: string | null;
  speed?: { bytesPerSecond: number; bytes: number; elapsedMs: number };
  udp?: { reachable: boolean; error: string | null };
}
interface Job {
  job: number;
  busy: boolean;
  total: number;
  completed: number;
  results: OutboundTestResult[];
  cancelled: boolean;
  planReady?: boolean;
  totalRows?: number;
  rows?: TestPlan['rows'];
  targets?: TestPlan['targets'];
  error?: { message: string } | null;
}
interface TestRun {
  controller: AbortController;
  mode: TestMode;
  job?: number;
  wake?: () => void;
}
function cancelRun(run: TestRun) {
  run.controller.abort();
  run.wake?.();
  if (run.job !== undefined)
    void serviceCall('outbounds.testCancel', { job: run.job }).catch(() => {});
}
interface TestSummary {
  text: string;
  title: string;
  state: string;
  udp?: { reachable: boolean; title: string };
}
export function summarizeTest(
  row: TestRow,
  results: ReadonlyMap<string, OutboundTestResult>,
  mode: TestMode = 'latency',
): TestSummary {
  if (row.error) return { text: 'Unavailable', title: row.error, state: 'failed' };
  const checked = row.targets
    .map((id) => results.get(id))
    .filter((r): r is OutboundTestResult => !!r);
  if (mode === 'speed') {
    if (!checked.length) return { text: 'Not tested', title: '', state: 'untested' };
    const result = checked[0];
    const speed = result.speed;
    return speed && Number.isFinite(speed.bytesPerSecond) && speed.bytesPerSecond > 0
      ? {
          text: `${((speed.bytesPerSecond * 8) / 1e6).toFixed(2)} Mbit/s`,
          title: `${(speed.bytes / 1048576).toFixed(1)} MiB in ${(speed.elapsedMs / 1000).toFixed(2)} s`,
          state: 'passed',
        }
      : {
          text: 'Failed',
          title: result.error ?? 'No download measurement.',
          state: 'failed',
        };
  }
  const live = checked.filter((r) => r.latencyMs !== null);
  const group = row.kind === 'policy-group';
  if (!checked.length) return { text: 'Not tested', title: '', state: 'untested' };
  const best = ['leastPing', 'leastLoad'].includes(row.strategy ?? '');
  const latency = live.length
    ? best
      ? Math.min(...live.map((r) => r.latencyMs!))
      : Math.round(live.reduce((n, r) => n + r.latencyMs!, 0) / live.length)
    : null;
  const text = group
    ? `${latency === null ? 'Failed' : `${best ? 'Min' : 'Avg'} ${latency} ms`} · ${live.length}/${row.targets.length} live`
    : `${live[0]?.latencyMs === undefined ? 'Failed' : `${live[0].latencyMs} ms`}`;
  const title = group
    ? `${checked.length}/${row.targets.length} checked.`
    : [
        [checked[0]?.ip, checked[0]?.country].filter(Boolean).join(' · '),
        checked[0]?.error,
        checked[0]?.countryError ? `Country lookup: ${checked[0].countryError}` : null,
      ]
        .filter(Boolean)
        .join('\n');
  const udp = checked.flatMap((result) => (result.udp ? [result.udp] : []));
  const udpSummary =
    udp.length === row.targets.length && udp.length
      ? {
          reachable: udp.every((r) => r.reachable),
          title: group
            ? `UDP: ${udp.filter((r) => r.reachable).length}/${udp.length} reachable`
            : (udp[0].error ?? 'UDP reply received.'),
        }
      : undefined;
  return {
    text,
    title,
    state: live.length ? 'passed' : 'failed',
    udp: udpSummary,
  };
}
interface TestRecord {
  plan?: TestPlan;
  results: Map<string, OutboundTestResult>;
  status: string;
  error: string;
}
const emptyRecord = (): TestRecord => ({
  results: new Map(),
  status: '',
  error: '',
});
const emptyRecords = (): Record<TestMode, TestRecord> => ({
  latency: emptyRecord(),
  speed: emptyRecord(),
});
export default function useOutboundTests(graph: GraphState, stash: Stash, egress = '') {
  const settings = useOutboundTestSettings();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<TestMode>('latency');
  const [records, setRecords] = useState(emptyRecords);
  const { plan, results, status, error } = records[mode];
  const patch = useCallback((mode: TestMode, value: Partial<TestRecord>) => {
    setRecords((current) =>
      Object.entries(value).every(([key, next]) =>
        Object.is(current[mode][key as keyof TestRecord], next),
      )
        ? current
        : { ...current, [mode]: { ...current[mode], ...value } },
    );
  }, []);
  const active = useRef<TestRun>(undefined);
  const current = useRef({ graph, stash });
  current.current = { graph, stash };
  const cancel = useCallback(() => {
    const run = active.current;
    if (!run) return;
    cancelRun(run);
    patch(run.mode, { status: 'Cancelled. Completed results are retained.' });
  }, [patch]);
  useEffect(
    () => () => {
      const run = active.current;
      if (run) cancelRun(run);
    },
    [],
  );
  // Layout/selection changes retain tests; edited settings, dependencies and subscriptions invalidate them.
  const connections = graph.edges
    .map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle].join(':'))
    .join('|');
  const source = useRef({
    settings: graph.nodes.map((n) => n.data),
    defaults: graph.defaults,
    library: stash.groups,
    pool: graph.xray?.outboundPool,
    connections,
    egress,
  });
  useEffect(() => {
    const next = {
      settings: graph.nodes.map((n) => n.data),
      defaults: graph.defaults,
      library: stash.groups,
      pool: graph.xray?.outboundPool,
      connections,
      egress,
    };
    const previous = source.current;
    const same =
      next.egress === previous.egress &&
      next.connections === previous.connections &&
      next.defaults === previous.defaults &&
      sameTestLibrary(previous.library, next.library) &&
      next.pool === previous.pool &&
      next.settings.length === previous.settings.length &&
      next.settings.every((v, i) => v === previous.settings[i]);
    source.current = next;
    if (same) return;
    cancel();
    setRecords(emptyRecords());
  }, [
    graph.nodes,
    graph.defaults,
    graph.xray?.outboundPool,
    stash.groups,
    connections,
    egress,
    cancel,
  ]);
  const start = useCallback(
    async (
      entries?: StashEntry[],
      nodeIds?: string[],
      testMode: TestMode = 'latency',
      selection?: TestSelection,
    ) => {
      if (active.current) return;
      const run: TestRun = { controller: new AbortController(), mode: testMode };
      const { signal } = run.controller;
      active.current = run;
      setMode(testMode);
      const setStatus = (status: string) => patch(testMode, { status });
      const setError = (error: string) => patch(testMode, { error });
      const setPlan = (plan: TestPlan) =>
        setRecords((current) => ({
          ...current,
          [testMode]: {
            ...current[testMode],
            plan: mergeTestPlans(current[testMode].plan, plan),
          },
        }));
      const publishResults = (fresh: OutboundTestResult[]) => {
        if (!fresh.length) return;
        setRecords((current) => {
          const results = new Map(current[testMode].results);
          for (const result of fresh)
            results.set(result.id, { ...result, udp: result.udp ?? results.get(result.id)?.udp });
          return { ...current, [testMode]: { ...current[testMode], results } };
        });
      };
      setOpen(true);
      setBusy(true);
      setError('');
      setStatus('Preparing outbound tests…');
      let staged: string | undefined;
      const wait = () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            run.wake = undefined;
            resolve();
          }, 400);
          run.wake = () => {
            clearTimeout(timer);
            run.wake = undefined;
            resolve();
          };
        });
      try {
        const draft = current.current;
        staged = await stageOutboundTests(
          {
            graph: JSON.stringify(toDocument(draft.graph)),
            stash: serializeStash(draft.stash),
            entries: entries?.map((entry) => entryLink(draft.stash, entry)),
            nodeIds,
            selection,
          },
          signal,
        );
        signal.throwIfAborted();
        let job = await serviceCall<Job>('outbounds.testPlanStart', {
          sourceToken: staged,
          settings: {
            testUrl: settings.value.testUrl,
            countryUrl: settings.value.countryUrl,
            mode: testMode,
            ...(testMode === 'speed'
              ? { speedUrl: settings.value.speedUrl }
              : settings.value.udpEnabled
                ? { udpUrl: settings.value.udpUrl }
                : {}),
          },
        });
        staged = undefined;
        run.job = job.job;
        const plan: TestPlan = { rows: [], targets: [] };
        let offset = 0,
          planPublished = false;
        while (!signal.aborted) {
          publishResults(job.results);
          offset += job.results.length;
          if (job.error) throw new Error(job.error.message);
          if (job.cancelled) {
            setStatus('Cancelled. Completed results are retained.');
            break;
          }
          if (job.planReady && !planPublished) {
            plan.rows.push(...(job.rows ?? []));
            plan.targets.push(...(job.targets ?? []));
            if (plan.rows.length === job.totalRows && plan.targets.length === job.total) {
              setPlan(plan);
              planPublished = true;
            }
          }
          const readingPlan = job.planReady && !planPublished;
          const readingResults = offset < job.completed;
          if (!job.busy && !readingPlan && !readingResults) {
            run.job = undefined;
            setStatus(
              offset
                ? `${offset} ${offset === 1 ? 'outbound' : 'outbounds'} tested`
                : 'No testable outbounds.',
            );
            break;
          }
          if (job.planReady) setStatus(`${job.completed}/${job.total} tested`);
          if (!readingPlan && !readingResults) await wait();
          if (signal.aborted) break;
          job = await serviceCall<Job>('outbounds.testGet', {
            job: run.job,
            offset,
            ...(readingPlan
              ? { rowOffset: plan.rows.length, targetOffset: plan.targets.length }
              : {}),
          });
        }
      } catch (e) {
        if (!signal.aborted) setError(errorText(e));
      } finally {
        if (staged)
          await serviceCall('subscriptions.uploadAbort', { token: staged }).catch(() => {});
        if (run.job !== undefined) await drainTestJob(run.job);
        active.current = undefined;
        setBusy(false);
      }
    },
    [settings.value, patch],
  );
  const summaries = useMemo(
    () =>
      new Map(
        records.latency.plan?.rows.map((row) => [
          row.key,
          summarizeTest(row, records.latency.results),
        ]) ?? [],
      ),
    [records.latency.plan, records.latency.results],
  );
  const speedSummaries = useMemo(
    () =>
      new Map(
        records.speed.plan?.rows.map((row) => [
          row.key,
          summarizeTest(row, records.speed.results, 'speed'),
        ]) ?? [],
      ),
    [records.speed.plan, records.speed.results],
  );
  return {
    open,
    setOpen,
    busy,
    status,
    error,
    plan,
    results,
    records,
    settings,
    start,
    retest: (selection: TestSelection, requested: TestMode) =>
      start(undefined, undefined, requested, selection),
    cancel,
    summaries,
    speedSummaries,
    mode,
    show: (requested: TestMode = mode) => {
      if (!active.current) setMode(requested);
      setOpen(true);
    },
    desktop: desktopServiceAvailable(),
  };
}
export type OutboundTests = ReturnType<typeof useOutboundTests>;
export const OutboundTestsContext = createContext<OutboundTests | null>(null);
export function OutboundTestSummary({
  nodeId,
  entry,
  stash,
  observationTag,
}: {
  observationTag?: string;
  nodeId?: string;
  entry?: StashEntry;
  stash?: Stash;
}) {
  const tests = useContext(OutboundTestsContext);
  const observation = useContext(ObservatoryContext).get(observationTag ?? '');
  const key = nodeId ? 'node:' + nodeId : entry && stash ? stashTestKey(stash, entry) : '';
  const summary = tests?.summaries.get(key);
  const speed = tests?.speedSummaries.get(key);
  return (
    <>
      {observation ? (
        <div
          className={`outbound-test-summary outbound-observation-summary nodrag nopan ${observation.state}`}
          title={observation.title}
        >
          {observation.text}
          <UdpTestBadge result={summary?.udp} />
        </div>
      ) : summary && tests ? (
        <button
          className={`outbound-test-summary nodrag nopan ${summary.state}`}
          title={summary.title}
          onClick={() => tests.show('latency')}
        >
          {summary.text}
          <UdpTestBadge result={summary.udp} />
        </button>
      ) : null}
      {speed && tests && (
        <button
          className={`outbound-test-summary outbound-speed-summary nodrag nopan ${speed.state}`}
          title={speed.title}
          onClick={() => tests.show('speed')}
        >
          <Gauge size={12} aria-hidden="true" />
          {speed.text}
        </button>
      )}
    </>
  );
}
