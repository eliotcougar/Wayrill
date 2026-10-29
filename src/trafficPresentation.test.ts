import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import TrafficChart from './components/TrafficChart';
import type { TrafficPoint } from './traffic';
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

it('places uneven samples using their measured time rather than their array index', () => {
  const points = [
    point(1, null, null),
    { ...point(2, 100, 200), elapsedMs: 6000 },
    { ...point(3, 300, 400), elapsedMs: 10000 },
  ];
  const html = renderToStaticMarkup(createElement(TrafficChart, { points, minutes: 1 }));
  const lines = [...html.matchAll(/<polyline[^>]*points="([^"]+)"/g)];
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    const [first, second] = line[1].split(' ').map((p) => Number(p.split(',')[0]));
    expect(second - first).toBeCloseTo((922 * 4000) / 60000, 1);
  }
});
