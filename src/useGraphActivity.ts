import { useEffect, useMemo, useRef, useState } from 'react';
import {
  graphActivity,
  GRAPH_ACTIVITY_KEY,
  graphActivityPlan,
  noGraphActivity,
  type ActivitySnapshot,
} from './graph/activity';
import type { GraphState } from './graph/types';
import type { RuntimeCompilation } from './graph/runtime';
import type { RuntimeController } from './useRuntime';
import { serviceCall } from './serviceClient';

export function useGraphActivityPreference() {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(GRAPH_ACTIVITY_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState('');
  useEffect(() => {
    const stored = (event: StorageEvent) => {
      if (event.key !== GRAPH_ACTIVITY_KEY && event.key !== null) return;
      setEnabled(event.key !== null && event.newValue === 'true');
      setError('');
    };
    window.addEventListener('storage', stored);
    return () => window.removeEventListener('storage', stored);
  }, []);
  return {
    enabled,
    error,
    setEnabled: (value: boolean) => {
      setEnabled(value);
      try {
        localStorage.setItem(GRAPH_ACTIVITY_KEY, String(value));
        setError('');
      } catch {
        setError('Traffic glow changed for this session, but could not be saved.');
      }
    },
  };
}

/** One bounded activity read per second, only while visible and enabled.
 * Rates reuse existing telemetry; CSS handles interpolation without a JS frame loop.
 */
export type GraphActivitySource = {
  enabled: boolean;
  graph: GraphState;
  compilation: RuntimeCompilation | null;
  runtime: RuntimeController;
};
export default function useGraphActivity({
  enabled,
  graph,
  compilation,
  runtime,
}: GraphActivitySource) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [recent, setRecent] = useState<ActivitySnapshot | null>(null);
  const [ratesExpired, setRatesExpired] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const changed = () => setVisible(!document.hidden);
    changed();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [enabled]);
  const plan = useMemo(
    () => (enabled && compilation ? graphActivityPlan(graph, compilation) : null),
    [enabled, graph, compilation],
  );
  const instance = runtime.snapshot?.instanceId;
  const generation = runtime.snapshot?.core.generation;
  const revision = runtime.savedRevision;
  const active =
    !!plan && visible && runtime.connected && runtime.snapshot?.core.state === 'running';
  const supported = runtime.capabilities.includes('routing.activity');
  useEffect(() => {
    setRecent(null);
    if (!active || !supported) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // Visibility/toggle/revision changes retire consumers, not the IPC request.
      if (inFlight.current) {
        timer = setTimeout(() => void poll(), 1000);
        return;
      }
      inFlight.current = true;
      try {
        const result = await serviceCall<ActivitySnapshot>('routing.activity');
        if (disposed) return;
        clearTimeout(expiry);
        setRecent(
          result.instanceId === instance &&
            result.generation === generation &&
            result.revision === revision &&
            result.state === 'collecting'
            ? result
            : null,
        );
        // An unresponsive service must not leave a bright, apparently active path.
        expiry = setTimeout(() => setRecent(null), 4000);
      } catch {
        if (!disposed) setRecent(null);
      } finally {
        inFlight.current = false;
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(expiry);
    };
  }, [active, supported, instance, generation, revision, plan]);
  const traffic = runtime.snapshot?.traffic;
  const timestamp = traffic?.lastSample?.timestampMs;
  useEffect(() => {
    setRatesExpired(false);
    if (!active || timestamp === undefined) return;
    const timer = setTimeout(
      () => setRatesExpired(true),
      Math.max(0, timestamp + 8000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [active, timestamp]);
  return useMemo(() => {
    if (!active || !plan) return noGraphActivity;
    const matches =
      recent &&
      recent.instanceId === instance &&
      recent.generation === generation &&
      recent.revision === revision
        ? recent.rules
        : [];
    const endpoints =
      !ratesExpired &&
      traffic?.state === 'collecting' &&
      traffic.generation === generation &&
      traffic.revision === revision &&
      timestamp !== undefined &&
      Date.now() - timestamp < 8000
        ? traffic.endpoints
        : [];
    return graphActivity(plan, matches, endpoints);
  }, [active, plan, recent, instance, generation, revision, ratesExpired, traffic, timestamp]);
}
