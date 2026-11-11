import { rateScale, unitDecimals, type RateUnit, type AmountUnit } from './trafficUnits';
/** Byte totals stay decimal strings on the wire; Number loses precision above 2^53. */
export type TrafficPoint = {
  sampleId: number;
  timestampMs: number;
  elapsedMs: number;
  /** Duration covered by this average, measured on the service's monotonic clock. */
  intervalMs?: number;
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
const HISTORY_LIMIT = 300;
const validPoint = (p: TrafficPoint) =>
  Number.isSafeInteger(p.sampleId) &&
  p.sampleId > 0 &&
  Number.isFinite(p.elapsedMs) &&
  p.elapsedMs >= 0;

export function appendTrafficPoint(points: TrafficPoint[], point: TrafficPoint | null | undefined) {
  if (!point || !validPoint(point) || point.sampleId <= (points.at(-1)?.sampleId ?? 0))
    return points;
  const next = points.slice(Math.max(0, points.length - HISTORY_LIMIT + 1));
  next.push(point);
  return next;
}

export function mergeTrafficPoints(
  current: TrafficPoint[],
  incoming: TrafficPoint[],
): TrafficPoint[] {
  const points = new Map(current.map((p) => [p.sampleId, p]));
  for (const p of incoming) {
    if (validPoint(p)) points.set(p.sampleId, p);
  }
  return [...points.values()].sort((a, b) => a.sampleId - b.sampleId).slice(-HISTORY_LIMIT);
}
