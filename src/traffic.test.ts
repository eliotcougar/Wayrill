import { describe, expect, it } from 'vitest';
import {
  chartSegments,
  formatBytes,
  formatRate,
  mergeTrafficPoints,
  type TrafficPoint,
} from './traffic';
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
  it('distinguishes zero rates from unavailable or invalid measurements', () => {
    expect(formatRate(0)).toBe('0.0 KiB/s');
    expect(formatRate(2048)).toBe('2.0 KiB/s');
    for (const v of [null, undefined, -1, NaN, Infinity]) expect(formatRate(v)).toBe('—');
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
  it('breaks lines for missing samples, unavailable rates and clock discontinuities', () => {
    expect(
      chartSegments(
        [point(1), point(2, null), point(3), point(9), point(10)],
        'uploadPerSecond',
      ).map((s) => s.map((p) => p.sampleId)),
    ).toEqual([[1], [3], [9, 10]]);
    expect(chartSegments([point(2), point(1)], 'downloadPerSecond')).toHaveLength(2);
  });
});

it('breaks the graph across a skipped ID even when the clock gap is short', () => {
  expect(
    chartSegments([point(1), point(3), point(4)], 'downloadPerSecond').map((s) =>
      s.map((p) => p.sampleId),
    ),
  ).toEqual([[1], [3, 4]]);
});
it('never joins samples at the same time or across a reset time axis', () => {
  const points = [
    point(1),
    { ...point(2), elapsedMs: 2000 },
    { ...point(3), elapsedMs: 1500 },
    point(4),
  ];
  expect(chartSegments(points, 'downloadPerSecond').map((s) => s.map((p) => p.sampleId))).toEqual([
    [1],
    [2],
    [3],
    [4],
  ]);
});
