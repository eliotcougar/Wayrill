import { expect, it } from 'vitest';
import { fakeDnsUsageSummary } from './fakeDnsUsage';
import type { ServiceSnapshot } from './serviceClient';

const config = { fakedns: [{ ipPool: '198.18.0.0/15', poolSize: 32768 }] };
const snapshot = {
  config: { revision: 42 },
  core: { state: 'running' },
  fakeDns: {
    usage: {
      used: 12,
      capacity: 32768,
      pools: [{ ipPool: '198.18.0.0/15', used: 12, capacity: 32768 }],
    },
  },
} as ServiceSnapshot;
const summary = (
  s = snapshot,
  draft: Record<string, unknown> = config,
  connected = true,
  revision = 42,
) => fakeDnsUsageSummary(connected, s, draft, config, revision);
it('shows live occupancy, including zero, and identifies shared pool geometry', () => {
  expect(summary().text).toBe(`${(12).toLocaleString()} / ${(32768).toLocaleString()}`);
  expect(summary().title).toContain('198.18.0.0/15');
  expect(
    summary({ ...snapshot, fakeDns: { pid: null, usage: { used: 0, capacity: 3, pools: [] } } })
      .text,
  ).toBe('0 / 3');
});
it('hides unavailable, stopped, stale-revision and incompatible geometry counts', () => {
  expect(summary(snapshot, config, false).text).toBe('—');
  expect(summary({ ...snapshot, core: { ...snapshot.core, state: 'stopped' } }).text).toBe('—');
  expect(summary({ ...snapshot, fakeDns: null }).text).toBe('—');
  expect(summary(snapshot, config, true, 41).text).toBe('—');
  expect(summary(snapshot, { fakedns: [{ ipPool: '198.18.0.0/15', poolSize: 4 }] }).text).toBe('—');
  expect(summary(snapshot, { ...config, routing: { rules: [] } }).text).not.toBe('—');
});
