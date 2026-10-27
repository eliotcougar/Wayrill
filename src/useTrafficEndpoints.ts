import { useEffect, useRef, useState } from 'react';
import { LIMITS } from './limits';
import { serviceCall, errorText } from './serviceClient';
import type { TrafficEndpointPage, TrafficSort } from './traffic';
import { defaultTrafficSort } from './trafficSorting';
import type { RuntimeController } from './useRuntime';

export default function useTrafficEndpoints(
  runtime: RuntimeController,
  scope: 'inbound' | 'outbound' | 'overview',
  paused = false,
  sort: TrafficSort = defaultTrafficSort,
) {
  const [page, setPage] = useState<(TrafficEndpointPage & { context: string }) | null>(null),
    [position, setPosition] = useState({ context: '', offset: 0 }),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const traffic = runtime.snapshot?.traffic,
    instanceId = runtime.snapshot?.instanceId ?? '',
    generation = traffic?.generation,
    revision = traffic?.revision,
    sampleId = traffic?.sampleId,
    counterEpoch = traffic?.counterEpoch ?? 0,
    enabled =
      !paused &&
      runtime.connected &&
      scope !== 'overview' &&
      !!traffic?.endpointsTruncated &&
      runtime.capabilities.includes('xray.statistics.pages');
  const context = JSON.stringify([
    instanceId,
    generation,
    revision,
    counterEpoch,
    scope,
    sort.column,
    sort.direction,
  ]);
  useEffect(() => {
    setPosition({ context, offset: 0 });
    setPage(null);
    setError('');
  }, [context]);
  const total = scope === 'overview' ? 0 : (traffic?.endpointCounts?.[scope] ?? 0),
    currentOffset = Math.min(
      position.context === context ? position.offset : 0,
      Math.max(0, Math.ceil(total / LIMITS.endpointPageSize) - 1) * LIMITS.endpointPageSize,
    );
  const latestSample = useRef(sampleId);
  latestSample.current = sampleId;
  const request = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let active = true,
      busy = false,
      queued = false;
    let requestedSample: number | undefined;
    const fetchPage = () => {
      if (!active) return;
      if (busy) {
        queued ||= latestSample.current !== requestedSample;
        return;
      }
      busy = true;
      queued = false;
      requestedSample = latestSample.current;
      const minimumSample = requestedSample ?? 0;
      setError('');
      void serviceCall<TrafficEndpointPage>('traffic.endpoints', {
        scope,
        offset: currentOffset,
        limit: LIMITS.endpointPageSize,
        ...(sort.column === 'name' && sort.direction === 'asc'
          ? {}
          : { sortBy: sort.column, direction: sort.direction }),
      })
        .then((reply) => {
          if (
            active &&
            reply.generation === generation &&
            reply.revision === revision &&
            (reply.counterEpoch ?? 0) === counterEpoch &&
            reply.scope === scope &&
            reply.offset === currentOffset &&
            reply.sampleId >= minimumSample &&
            (reply.sortBy ?? 'name') === sort.column &&
            (reply.direction ?? 'asc') === sort.direction
          ) {
            setPage({ ...reply, context });
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        })
        .finally(() => {
          busy = false;
          if (active && queued) fetchPage();
        });
    };
    request.current = fetchPage;
    fetchPage();
    return () => {
      active = false;
      if (request.current === fetchPage) request.current = undefined;
    };
  }, [
    enabled,
    scope,
    instanceId,
    generation,
    revision,
    counterEpoch,
    currentOffset,
    retry,
    context,
    sort.column,
    sort.direction,
  ]);
  // A new sample queues one refresh instead of cancelling an in-flight page.
  useEffect(() => {
    request.current?.();
  }, [sampleId]);
  const current = page?.context === context && page.offset === currentOffset ? page : null;
  const rows =
    scope === 'overview'
      ? []
      : traffic?.endpointsTruncated
        ? (current?.endpoints ?? [])
        : (traffic?.endpoints.filter((r) => r.scope === scope) ?? []);
  return {
    rows,
    total,
    offset: currentOffset,
    paged: !!traffic?.endpointsTruncated,
    fresh: !traffic?.endpointsTruncated || (current?.sampleId ?? -1) >= (sampleId ?? 0),
    error,
    setOffset: (offset: number) => setPosition({ context, offset }),
    refresh: () => setRetry((n) => n + 1),
  };
}
