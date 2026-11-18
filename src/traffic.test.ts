import { describe, expect, it } from 'vitest';
import { appendTrafficPoint, formatBytes, mergeTrafficPoints, type TrafficPoint } from './traffic';
const point = (id: number, rate: number | null = 100): TrafficPoint => ({
  sampleId: id,
  timestampMs: id * 2000,
  elapsedMs: id * 2000,
  uploadPerSecond: rate,
  downloadPerSecond: rate,
});
describe('traffic formatting and chart history', () => {
  it('formats exact decimal totals without truncating to JavaScript integer precision', () => {
    // These adjacent byte counters round to the same JavaScript Number.
    expect(formatBytes('9063494250083123')).toBe('8.0 PiB');
    expect(formatBytes('9063494250083124')).toBe('8.1 PiB');
    expect(formatBytes('-1')).toBe('—');
  });
  it('keeps a bounded, chronological history across backfill and live snapshots', () => {
    const history = Array.from({ length: 401 }, (_, i) => point(i + 1));
    const merged = mergeTrafficPoints([point(401), point(402)], history);
    expect(merged.length).toBeLessThan(history.length);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged).toEqual(history.concat(point(402)).slice(-merged.length));
    expect(appendTrafficPoint(merged, point(402))).toBe(merged);
    expect(appendTrafficPoint(merged, point(401))).toBe(merged);
    expect(appendTrafficPoint(merged, point(403))).toEqual([...merged.slice(1), point(403)]);
  });
});
