import { createContext } from 'react';
import { matchesCapture } from './runtimeState';
import { jsonArray, jsonRecord } from './graph/xrayJson';
import type { ServiceSnapshot } from './serviceClient';

export type ObservationSummary = { text: string; title: string; state: string };
export const ObservatoryContext = createContext<ReadonlyMap<string, ObservationSummary>>(new Map());

/** Run on config changes, not on every telemetry tick or node render. */
export function compatibleObservedGroups(
  draft: Record<string, unknown> | null | undefined,
  applied: Record<string, unknown> | null,
  observed: Record<string, string> = {},
): Set<string> {
  const result = new Set<string>();
  if (
    !draft ||
    !applied ||
    !matchesCapture(draft.outbounds, applied.outbounds) ||
    !matchesCapture(draft.dns, applied.dns) ||
    !matchesCapture(draft.observatory, applied.observatory) ||
    !matchesCapture(draft.burstObservatory, applied.burstObservatory)
  )
    return result;
  if (jsonArray(draft.outbounds)) {
    const tags = new Set(draft.outbounds.filter(jsonRecord).map((outbound) => outbound.tag));
    for (const [probe, tag] of Object.entries(observed))
      if (tags.has(probe) && tags.has(tag)) result.add(tag);
  }
  const savedRouting = jsonRecord(applied.routing) ? applied.routing : {};
  const routing = jsonRecord(draft.routing) ? draft.routing : {};
  const saved = new Map(
    (jsonArray(savedRouting.balancers) ? savedRouting.balancers : [])
      .filter(jsonRecord)
      .map((group) => [group.tag, group]),
  );
  for (const group of jsonArray(routing.balancers) ? routing.balancers : []) {
    if (
      jsonRecord(group) &&
      typeof group.tag === 'string' &&
      matchesCapture(group, saved.get(group.tag))
    )
      result.add(group.tag);
  }
  return result;
}

export function observedGroupSummaries(
  snapshot: ServiceSnapshot | null,
  compatible: ReadonlySet<string>,
  appliedRevision: number,
) {
  const result = new Map<string, ObservationSummary>();
  const observed = snapshot?.observation;
  if (
    !snapshot ||
    appliedRevision !== snapshot.config.revision ||
    snapshot.core.state !== 'running' ||
    !observed ||
    observed.generation !== snapshot.core.generation ||
    observed.revision !== snapshot.config.revision
  )
    return result;
  for (const outbound of observed.outbounds ?? []) {
    if (!compatible.has(outbound.tag)) continue;
    result.set(outbound.tag, {
      text: !outbound.checked
        ? 'Awaiting probe'
        : outbound.alive
          ? `${outbound.latencyMs ?? 0} ms`
          : 'Unavailable',
      state: !outbound.checked ? 'untested' : outbound.alive ? 'passed' : 'failed',
      title: `Observatory · applied revision ${observed.revision}\nSampled ${new Date(observed.sampledAtMs).toLocaleTimeString()}`,
    });
  }
  for (const group of observed.groups) {
    if (!compatible.has(group.tag)) continue;
    const minimum = ['leastPing', 'leastLoad'].includes(group.strategy);
    const latency = group.latencyMs;
    const text =
      group.checked === 0
        ? `Awaiting probes · 0/${group.total} live`
        : `${latency === null ? 'Unavailable' : `${minimum ? 'Min' : 'Avg'} ${latency} ms`} · ${group.alive}/${group.total} live`;
    result.set(group.tag, {
      text,
      state: group.checked === 0 ? 'untested' : group.alive ? 'passed' : 'failed',
      title: `Observatory · applied revision ${observed.revision}\n${group.checked}/${group.total} observed · sampled ${new Date(observed.sampledAtMs).toLocaleTimeString()}`,
    });
  }
  return result;
}
