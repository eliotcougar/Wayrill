import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import TrafficChart from './components/TrafficChart';
import type { TrafficPoint } from './traffic';
import { trafficRatePath } from './trafficPresentation';
const point = (
  sampleId: number,
  uploadPerSecond: number | null,
  downloadPerSecond: number | null,
): TrafficPoint => ({
  sampleId,
  timestampMs: sampleId * 2000,
  elapsedMs: sampleId * 2000,
  uploadPerSecond,
  downloadPerSecond,
});

it('draws measured interval widths and leaves a gap when a direction is unavailable', () => {
  const points = [
    point(1, null, null),
    { ...point(2, 100, 200), elapsedMs: 6000, intervalMs: 4000 },
    { ...point(3, 300, null), elapsedMs: 8000, intervalMs: 2000 },
    { ...point(4, 400, 300), elapsedMs: 10000, intervalMs: 2000 },
  ];
  const html = renderToStaticMarkup(createElement(TrafficChart, { points, minutes: 1 }));
  const upload = html.match(/class="traffic-up" d="([^"]+)"/)![1];
  const download = html.match(/class="traffic-down" d="([^"]+)"/)![1];
  const coordinates = (d: string) => [...d.matchAll(/[MH]([\d.]+)/g)].map((m) => Number(m[1]));
  const [start, first, second, end] = coordinates(upload);
  expect(first - start).toBeCloseTo((922 * 4000) / 60000, 1);
  expect(second - first).toBeCloseTo((922 * 2000) / 60000, 1);
  expect(coordinates(download)).toEqual([start, first, second, end]);
  expect(upload.match(/M/g)).toHaveLength(1);
  expect(download.match(/M/g)).toHaveLength(2);
});

it('does not infer a legacy interval over skipped or non-increasing samples', () => {
  const points = [
    point(1, 10, 10),
    { ...point(3, 20, 20), elapsedMs: 3000 },
    { ...point(4, 30, 30), elapsedMs: 3000 },
    { ...point(5, 40, 40), elapsedMs: 5000 },
  ];
  const path = trafficRatePath(
    points,
    'uploadPerSecond',
    0,
    (ms) => ms / 1000,
    (rate) => rate,
  );
  expect(path).toBe('M2.00,10.00h0.001M3.00,20.00h0.001M3.00,30.00h0.001V40.00H5.00');
});
