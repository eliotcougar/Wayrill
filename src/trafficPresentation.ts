import type { TrafficPoint, TrafficSnapshot } from './traffic';
import { rateScale, unitDecimals, type RateUnit } from './trafficUnits';

export function measuredRate(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/** Plot each measured average over the interval it covers. */
export function trafficRatePath(
  points: readonly TrafficPoint[],
  direction: 'uploadPerSecond' | 'downloadPerSecond',
  windowStart: number,
  x: (elapsedMs: number) => number,
  y: (rate: number) => number,
) {
  let path = '';
  let previous: TrafficPoint | undefined;
  let previousDrawnEnd: number | undefined;
  for (const point of points) {
    const end = point.elapsedMs;
    const adjacent = previous !== undefined && point.sampleId === previous.sampleId + 1;
    const gap = previous ? end - previous.elapsedMs : 0;
    previous = point;
    const rate = point[direction];
    if (!measuredRate(rate) || end < windowStart) {
      previousDrawnEnd = undefined;
      continue;
    }
    // Older services supply only the sample time. Infer the interval only
    // between consecutive, reasonably close samples.
    const interval =
      measuredRate(point.intervalMs) && point.intervalMs <= end
        ? point.intervalMs
        : adjacent && gap > 0 && gap <= 6000
          ? gap
          : 0;
    const from = Math.max(0, windowStart, end - interval);
    const height = y(rate).toFixed(2);
    const right = x(end).toFixed(2);
    if (
      adjacent &&
      gap > 0 &&
      from < end &&
      previousDrawnEnd !== undefined &&
      Math.abs(from - previousDrawnEnd) <= 1
    ) {
      path += `V${height}H${right}`;
    } else {
      path += `M${x(from).toFixed(2)},${height}${from < end ? `H${right}` : 'h0.001'}`;
    }
    previousDrawnEnd = end;
  }
  return path;
}

/** All retained samples set one scale, so switching time windows does not rescale the chart. */
export function trafficScale(points: TrafficPoint[], unit: RateUnit = 'binary') {
  let peak = 1;
  for (const { uploadPerSecond, downloadPerSecond } of points) {
    if (measuredRate(uploadPerSecond)) peak = Math.max(peak, uploadPerSecond);
    if (measuredRate(downloadPerSecond)) peak = Math.max(peak, downloadPerSecond);
  }
  const top = peak * 1.15;
  const scale = rateScale(top, unit);
  const decimals = unitDecimals(top / scale.divisor);
  return {
    top,
    unit: scale.unit,
    label: (value: number) => (value / scale.divisor).toFixed(decimals),
  };
}

export function trafficStatus(traffic: TrafficSnapshot | undefined, now: number) {
  if (!traffic) return { live: false, label: 'Waiting for traffic samples' };
  if (traffic.state === 'stopped') return { live: false, label: 'Collection stopped' };
  if (traffic.state === 'unavailable') return { live: false, label: 'Counters unavailable' };
  if (traffic.lastSample && now - traffic.lastSample.timestampMs > 8000)
    return { live: false, label: 'Last sample is stale' };
  if (!traffic.lastSample) return { live: false, label: 'Collecting · waiting for next sample' };
  if (!measuredRate(traffic.uploadPerSecond) && !measuredRate(traffic.downloadPerSecond))
    return { live: true, label: 'Collecting · waiting for an overall rate' };
  return { live: true, label: `Live · every ${traffic.sampleIntervalMs / 1000} seconds` };
}

export function sampleTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
