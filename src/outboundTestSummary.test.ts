import { it, expect } from 'vitest';
import { summarizeTest, type OutboundTestResult } from './useOutboundTests';
import type { TestRow } from './outboundTestPlan';
const row: TestRow = {
  key: 'group',
  name: 'group',
  kind: 'policy-group',
  targets: ['a', 'b', 'c'],
};
const result = (id: string, latencyMs: number | null): OutboundTestResult => ({
  id,
  latencyMs,
  ip: '203.0.113.1',
  country: 'FI',
  error: latencyMs === null ? 'Timeout' : null,
  countryError: null,
});
const results = new Map(
  [result('a', 40), result('b', 80), result('c', null)].map((r) => [r.id, r]),
);
it('keeps missing and failed measurements out of successful results', () => {
  expect(summarizeTest(row, new Map()).state).toBe('untested');
  expect(summarizeTest(row, new Map([['c', result('c', null)]])).state).toBe('failed');
  expect(summarizeTest({ ...row, error: 'No candidates' }, results).state).toBe('failed');
  const noReusableConnection = { ...result('b', null), delayUnavailable: true };
  const mixed = new Map(results).set('b', noReusableConnection);
  expect(summarizeTest(row, mixed).text).toBe('Avg 40 ms · 2/3 live');
  expect(summarizeTest({ ...row, kind: 'outbound', targets: ['b'] }, mixed).text).toBe(
    'Delay unavailable',
  );
});

it('reports UDP independently of HTTP, and aggregates only completed group UDP checks', () => {
  const udpResults = new Map([
    ['a', { ...result('a', 40), udp: { reachable: true, error: null } }],
    ['b', { ...result('b', null), udp: { reachable: false, error: 'UDP timed out' } }],
  ]);
  expect(summarizeTest({ ...row, kind: 'outbound', targets: ['a'] }, udpResults)).toMatchObject({
    state: 'passed',
    udp: { reachable: true },
  });
  expect(summarizeTest({ ...row, targets: ['a', 'b'] }, udpResults).udp).toMatchObject({
    reachable: false,
  });
  expect(summarizeTest(row, udpResults).udp).toBeUndefined();
  expect(summarizeTest(row, results).udp).toBeUndefined();
  expect(summarizeTest({ ...row, kind: 'outbound', targets: ['b'] }, udpResults)).toMatchObject({
    state: 'failed',
    udp: { reachable: false, title: 'UDP timed out' },
  });
  const mixed = new Map(udpResults).set('a', {
    ...result('a', 40),
    udp: { reachable: false, error: 'UDP timed out' },
  });
  mixed.set('b', { ...result('b', 80), udp: { reachable: true, error: null } });
  const quickest = summarizeTest({ ...row, strategy: 'leastPing', targets: ['a', 'b'] }, mixed);
  expect(quickest).toMatchObject({ text: 'Min 40 ms · 2/2 live', udp: { reachable: false } });
});
