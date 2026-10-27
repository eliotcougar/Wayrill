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
it('reports the policy winner download rate without averaging or replacing latency results', () => {
  const measurement = {
    ...result('a', null),
    error: null,
    speed: { bytesPerSecond: 10_000_000, bytes: 50_000_000, elapsedMs: 5000 },
  };
  expect(
    summarizeTest({ ...row, targets: ['a'] }, new Map([['a', measurement]]), 'speed'),
  ).toMatchObject({ text: '80.00 Mbit/s', state: 'passed' });
  expect(
    summarizeTest({ ...row, targets: ['a'] }, new Map([['a', result('a', null)]]), 'speed'),
  ).toMatchObject({ text: 'Failed', state: 'failed' });
  expect(summarizeTest(row, new Map(), 'speed').text).toBe('Not tested');
});
it('averages successful members of random and round-robin groups, excluding failures', () => {
  for (const strategy of ['random', 'roundRobin'])
    expect(summarizeTest({ ...row, strategy }, results).text).toBe('Avg 60 ms · 2/3 live');
});
it('reports minimum live latency for least-ping and least-load', () => {
  for (const strategy of ['leastPing', 'leastLoad'])
    expect(summarizeTest({ ...row, strategy }, results).text).toBe('Min 40 ms · 2/3 live');
});
it('does not turn failed, pending or unsupported tests into zero latency', () => {
  expect(summarizeTest(row, new Map()).text).toBe('Not tested');
  expect(summarizeTest(row, new Map([['c', result('c', null)]])).text).toContain('Failed');
  expect(summarizeTest({ ...row, error: 'No candidates' }, results).text).toBe('Unavailable');
});
it('retains successful latency when country lookup fails', () => {
  const r = { ...result('a', 40), country: null, countryError: 'Country lookup unavailable' };
  expect(
    summarizeTest({ ...row, kind: 'proxy-chain', targets: ['a'] }, new Map([['a', r]])),
  ).toMatchObject({
    text: '40 ms',
    state: 'passed',
    title: '203.0.113.1\nCountry lookup: Country lookup unavailable',
  });
});

it('keeps country codes with IP details and leaves latency results numeric', () => {
  const single = { ...row, kind: 'proxy-chain', targets: ['a'] };
  expect(summarizeTest(single, new Map([['a', result('a', 40)]]))).toMatchObject({
    text: '40 ms',
    title: '203.0.113.1 · FI',
    state: 'passed',
  });
  expect(summarizeTest(single, new Map([['a', { ...result('a', 40), ip: null }]]))).toMatchObject({
    text: '40 ms',
    title: 'FI',
  });
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
