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
    expect(formatBytes('1024')).toBe('1.0 KiB');
    expect(formatBytes('0')).toBe('0.0 KiB');
    expect(formatBytes('9007199254740993')).toBe('8.0 PiB');
    expect(formatBytes('340282366920938463463374607431768211455')).not.toMatch(/NaN|Infinity/);
    expect(formatBytes('-1')).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });
  it('merges late history without losing live samples, de-duplicates and bounds it', () => {
    expect(mergeTrafficPoints([point(3), point(4)], [point(1), point(2), point(3)])).toEqual([
      point(1),
      point(2),
      point(3),
      point(4),
    ]);
    const merged = mergeTrafficPoints(
      [],
      Array.from({ length: 401 }, (_, i) => point(i + 1)),
    );
    expect(merged).toHaveLength(300);
    expect(merged[0].sampleId).toBe(102);
  });
});

it('does not redraw history for repeated snapshots and keeps the newest 300 measurements', () => {
  const points = Array.from({ length: 300 }, (_, i) => point(i + 1));
  expect(appendTrafficPoint(points, point(300))).toBe(points);
  expect(appendTrafficPoint(points, point(298))).toBe(points);
  expect(appendTrafficPoint(points, point(301))).toEqual([...points.slice(1), point(301)]);
});
