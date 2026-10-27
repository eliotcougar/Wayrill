import type { TrafficPoint, TrafficSnapshot } from './traffic';
import { rateScale, unitDecimals, type RateUnit } from './trafficUnits';

export function measuredRate(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

export function trafficWindow(points: TrafficPoint[], minutes: number) {
  const end = points.at(-1)?.elapsedMs ?? 0;
  return points.filter((p) => p.elapsedMs >= end - minutes * 60000);
}

/** All retained samples set one scale, so switching time windows does not rescale the chart. */
export function trafficScale(points: TrafficPoint[], unit: RateUnit = 'binary') {
  const peak = Math.max(
    1,
    ...points.flatMap((p) => [p.uploadPerSecond, p.downloadPerSecond].filter(measuredRate)),
  );
  const top = peak * 1.15;
  const scale = rateScale(top, unit);
  return {
    top,
    unit: scale.unit,
    label: (value: number) => (value / scale.divisor).toFixed(unitDecimals(top / scale.divisor)),
  };
}

export function trafficStatus(traffic: TrafficSnapshot | undefined, now: number) {
  if (!traffic) return { live: false, label: 'Waiting for traffic samples' };
  if (traffic.state === 'stopped') return { live: false, label: 'Collection stopped' };
  if (traffic.state === 'unavailable') return { live: false, label: 'Counters unavailable' };
  if (traffic.lastSample && now - traffic.lastSample.timestampMs > 8000)
    return { live: false, label: 'Last sample is stale' };
  if (!measuredRate(traffic.uploadPerSecond) && !measuredRate(traffic.downloadPerSecond))
    return { live: false, label: 'Collecting · waiting for next sample' };
  return { live: true, label: `Live · every ${traffic.sampleIntervalMs / 1000} seconds` };
}

export function sampleTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
