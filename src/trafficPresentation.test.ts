import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import TrafficChart from './components/TrafficChart';
import { measuredRate, trafficScale, trafficStatus, trafficWindow } from './trafficPresentation';
import type { TrafficPoint, TrafficSnapshot } from './traffic';
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
it('uses a shared retained-history scale and one explicit unit across time windows', () => {
  const points = [point(1, 1048576, 0), point(100, 1024, 0)];
  expect(trafficWindow(points, 1)).toEqual([points[1]]);
  const scale = trafficScale(points);
  expect(scale.unit).toBe('MiB/s');
  expect(scale.label(0)).toBe('0.0');
  const one = renderToStaticMarkup(createElement(TrafficChart, { points, minutes: 1 }));
  const five = renderToStaticMarkup(createElement(TrafficChart, { points, minutes: 5 }));
  expect(one).toContain('0–1.1');
  expect(five).toContain('0–1.1');
});
it('renders an isolated download measurement without a misleading empty overlay', () => {
  const html = renderToStaticMarkup(
    createElement(TrafficChart, { points: [point(1, null, 0)], minutes: 1 }),
  );
  expect(html).toContain('<circle');
  expect(html).not.toContain('No measured rates');
  expect(html).toContain('solid line');
  expect(html).toContain('dashed line');
});
it('ignores invalid rates in the scale and empty-chart test', () => {
  for (const value of [null, undefined, NaN, Infinity, -1]) expect(measuredRate(value)).toBe(false);
  expect(measuredRate(0)).toBe(true);
  const points = [point(1, NaN, -1)];
  expect(trafficScale(points).top).toBe(1.15);
  expect(renderToStaticMarkup(createElement(TrafficChart, { points, minutes: 1 }))).toContain(
    'No measured rates',
  );
});
it('rejects stale current rates without labelling the core stopped', () => {
  const snapshot = {
    state: 'collecting',
    lastSample: point(1, 1, 2),
    uploadPerSecond: 1,
    downloadPerSecond: 2,
  } as TrafficSnapshot;
  expect(trafficStatus(snapshot, 10001)).toEqual({
    live: false,
    label: 'Last sample is stale',
  });
  expect(trafficStatus({ ...snapshot, state: 'stopped' }, 2000).label).toBe('Collection stopped');
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
