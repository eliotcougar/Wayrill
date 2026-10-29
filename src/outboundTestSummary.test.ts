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
it('does not turn failed, pending or unsupported tests into zero latency', () => {
  expect(summarizeTest(row, new Map()).text).toBe('Not tested');
  expect(summarizeTest(row, new Map([['c', result('c', null)]])).text).toContain('Failed');
  expect(summarizeTest({ ...row, error: 'No candidates' }, results).text).toBe('Unavailable');
});

it('reports UDP independently of HTTP, and aggregates only completed group UDP checks', () => {
  const udpResults = new Map([
    ['a', { ...result('a', 40), udp: { reachable: true, error: null } }],
    ['b', { ...result('b', null), udp: { reachable: false, error: 'UDP timed out' } }],
  ]);
  expect(summarizeTest({ ...row, kind: 'outbound', targets: ['a'] }, udpResults)).toMatchObject({
    text: '40 ms',
    udp: { reachable: true, title: 'UDP reply received.' },
  });
  expect(summarizeTest({ ...row, targets: ['a', 'b'] }, udpResults).udp).toEqual({
    reachable: false,
    title: 'UDP: 1/2 reachable',
  });
  expect(summarizeTest(row, udpResults).udp).toBeUndefined();
  expect(summarizeTest(row, results).udp).toBeUndefined();
  expect(summarizeTest({ ...row, kind: 'outbound', targets: ['b'] }, udpResults)).toMatchObject({
    text: 'Failed',
    udp: { reachable: false, title: 'UDP timed out' },
  });
});
