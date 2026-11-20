import { useMemo, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { FakeDnsUsageContext, fakeDnsUsageSummary } from '../fakeDnsUsage';
import {
  ObservatoryContext,
  observedGroupSummaries,
  type ObservationSummary,
} from '../observatorySummary';
import { formatRate } from '../traffic';
import { useTrafficUnits } from '../trafficUnits';
import { useLiveSnapshot, type RuntimeController } from '../useRuntime';

const noObservations = new Map<string, ObservationSummary>();

export function GraphProbeStatus({
  children,
  runtime,
  draft,
  compatibleObservations,
}: {
  children: ReactNode;
  runtime: RuntimeController;
  draft: Record<string, unknown> | null | undefined;
  compatibleObservations: ReadonlySet<string>;
}) {
  const snapshot = useLiveSnapshot(runtime.snapshot, runtime.connected);
  const { connected, savedConfig, savedRevision } = runtime;
  const observations = useMemo(() => {
    if (!connected || !snapshot?.observation || !compatibleObservations.size) return noObservations;
    return observedGroupSummaries(snapshot, compatibleObservations, savedRevision);
  }, [connected, snapshot, compatibleObservations, savedRevision]);
  const { text, title } = fakeDnsUsageSummary(
    connected,
    snapshot,
    draft,
    savedConfig,
    savedRevision,
  );
  const usage = useMemo(() => ({ text, title }), [text, title]);
  return (
    <ObservatoryContext.Provider value={observations}>
      <FakeDnsUsageContext.Provider value={usage}>{children}</FakeDnsUsageContext.Provider>
    </ObservatoryContext.Provider>
  );
}

export function LiveTrafficRates({
  runtime,
  onOpen,
}: {
  runtime: RuntimeController;
  onOpen: () => void;
}) {
  const { rate } = useTrafficUnits();
  const snapshot = useLiveSnapshot(runtime.snapshot, runtime.connected);
  const traffic = runtime.connected ? snapshot?.traffic : null;
  return (
    <div className="status-traffic" role="group" aria-label="Live traffic rates">
      <span>↑ {formatRate(traffic?.uploadPerSecond, rate)}</span>
      <span>↓ {formatRate(traffic?.downloadPerSecond, rate)}</span>
      <button
        className="icon-button"
        title="Traffic statistics"
        aria-label="Open live traffic statistics"
        onClick={onOpen}
      >
        <Activity size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
