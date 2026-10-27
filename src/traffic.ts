import { rateScale, unitDecimals, type RateUnit, type AmountUnit } from './trafficUnits';
/** Byte totals stay decimal strings on the wire; Number loses precision above 2^53. */
export type TrafficPoint = {
  sampleId: number;
  timestampMs: number;
  elapsedMs: number;
  uploadPerSecond: number | null;
  downloadPerSecond: number | null;
};
export type TrafficEndpoint = {
  scope: 'inbound' | 'outbound';
  tag: string;
  uploadBytes: string;
  downloadBytes: string;
  uploadPerSecond: number | null;
  downloadPerSecond: number | null;
};
export type TrafficSnapshot = {
  state: 'collecting' | 'unavailable' | 'stopped';
  generation: number;
  revision: number;
  counterEpoch?: number;
  sampleIntervalMs: number;
  sampleId: number;
  lastSample: TrafficPoint | null;
  uploadBytes: string;
  downloadBytes: string;
  accumulatedUploadBytes: string;
  accumulatedDownloadBytes: string;
  uploadPerSecond: number | null;
  downloadPerSecond: number | null;
  endpoints: TrafficEndpoint[];
  endpointCounts?: { inbound: number; outbound: number };
  endpointsTruncated?: boolean;
  error: string | null;
  persistenceError?: string | null;
};
export type TrafficSortColumn =
  'name' | 'uploadPerSecond' | 'downloadPerSecond' | 'uploadBytes' | 'downloadBytes';
export type TrafficSort = {
  column: TrafficSortColumn;
  direction: 'asc' | 'desc';
};
export type TrafficEndpointPage = {
  sortBy?: TrafficSortColumn;
  direction?: TrafficSort['direction'];
  counterEpoch?: number;
  generation: number;
  revision: number;
  sampleId: number;
  scope: 'inbound' | 'outbound';
  offset: number;
  total: number;
  endpoints: TrafficEndpoint[];
};
export type TrafficHistory = {
  generation: number;
  revision: number;
  counterEpoch?: number;
  points: TrafficPoint[];
};
export function formatBytes(value: string | undefined, unit: AmountUnit = 'binary'): string {
  if (!value || !/^\d+$/.test(value)) return '—';
  const bytes = BigInt(value),
    base = unit === 'binary' ? 1024n : 1000n;
  const labels =
    unit === 'binary'
      ? ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']
      : ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let scale = base,
    index = 0;
  while (bytes >= scale * base && index < labels.length - 1) {
    scale *= base;
    index++;
  }
  const rounded = (bytes * 10n + scale / 2n) / scale;
  return `${rounded / 10n}.${rounded % 10n} ${labels[index]}`;
}
export function formatRate(value: number | null | undefined, unit: RateUnit = 'binary'): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const scale = rateScale(value, unit);
  return `${(value / scale.divisor).toFixed(unitDecimals(value / scale.divisor))} ${scale.unit}`;
}
export function mergeTrafficPoints(
  current: TrafficPoint[],
  incoming: TrafficPoint[],
): TrafficPoint[] {
  const points = new Map(current.map((p) => [p.sampleId, p]));
  for (const p of incoming) {
    if (
      Number.isSafeInteger(p.sampleId) &&
      p.sampleId > 0 &&
      Number.isFinite(p.elapsedMs) &&
      p.elapsedMs >= 0
    )
      points.set(p.sampleId, p);
  }
  return [...points.values()].sort((a, b) => a.sampleId - b.sampleId).slice(-300);
}
/** Discontinuities remain visible. Never join across failed polls, restarts or long pauses. */
export function chartSegments(
  points: TrafficPoint[],
  direction: 'uploadPerSecond' | 'downloadPerSecond',
) {
  const segments: TrafficPoint[][] = [];
  let line: TrafficPoint[] = [];
  for (const point of points) {
    const previous = line.at(-1),
      rate = point[direction];
    if (
      rate == null ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      (previous &&
        (point.sampleId !== previous.sampleId + 1 ||
          point.elapsedMs <= previous.elapsedMs ||
          point.elapsedMs - previous.elapsedMs > 6000))
    ) {
      if (line.length) segments.push(line);
      line = [];
    }
    if (rate != null && Number.isFinite(rate) && rate >= 0) line.push(point);
  }
  if (line.length) segments.push(line);
  return segments;
}
