import { expect, it } from 'vitest';
import { observedTag } from './graph/tags';
import { compatibleObservedGroups, observedGroupSummaries } from './observatorySummary';
import type { ServiceSnapshot } from './serviceClient';

const config = {
  outbounds: [{ tag: 'peer', protocol: 'socks', settings: { address: '192.0.2.1', port: 80 } }],
  observatory: { subjectSelector: ['peer'] },
  routing: { balancers: [{ tag: 'pool', selector: ['peer'], strategy: { type: 'leastPing' } }] },
};
const snapshot = () =>
  ({
    core: { state: 'running', generation: 3 },
    config: { revision: 9 },
    observation: {
      generation: 3,
      revision: 9,
      sampledAtMs: 1700000000000,
      truncated: false,
      groups: [
        { tag: 'pool', strategy: 'leastPing', total: 3, checked: 2, alive: 1, latencyMs: 47 },
      ],
    },
  }) as ServiceSnapshot;
it('keeps applied group health through routing-only edits, but rejects changed peers and group membership', () => {
  expect(
    compatibleObservedGroups({ ...config, routing: { ...config.routing, rules: [] } }, config).has(
      'pool',
    ),
  ).toBe(true);
  const changed = structuredClone(config);
  changed.outbounds[0].settings.port = 99;
  expect(compatibleObservedGroups(changed, config).size).toBe(0);
  expect(compatibleObservedGroups({ ...config, routing: { balancers: [] } }, config).size).toBe(0);
});
it('distinguishes pending probes and failures and clears stopped/disconnected results', () => {
  const current = snapshot();
  current.observation!.groups[0] = {
    ...current.observation!.groups[0],
    checked: 0,
    alive: 0,
    latencyMs: null,
  };
  expect(observedGroupSummaries(current, new Set(['pool']), 9).get('pool')?.state).toBe('untested');
  current.observation!.groups[0].checked = 3;
  expect(observedGroupSummaries(current, new Set(['pool']), 9).get('pool')?.text).toBe(
    'Unavailable · 0/3 live',
  );
  current.core.state = 'stopped';
  expect(observedGroupSummaries(current, new Set(['pool']), 9).size).toBe(0);
  expect(observedGroupSummaries(null, new Set(['pool']), 9).size).toBe(0);
});

it('updates standalone and whole-chain reports and rejects stale route definitions', () => {
  const config = {
    outbounds: [
      { tag: 'chain', protocol: 'socks' },
      { tag: observedTag('chain'), protocol: 'socks' },
    ],
    observatory: { probeURL: 'https://example.test' },
  };
  const compatible = compatibleObservedGroups(config, config, { [observedTag('chain')]: 'chain' });
  const current = snapshot();
  current.observation!.outbounds = [{ tag: 'chain', checked: true, alive: true, latencyMs: 28 }];
  expect(observedGroupSummaries(current, compatible, 9).get('chain')?.text).toBe('28 ms');
  current.observation!.outbounds[0] = {
    tag: 'chain',
    checked: true,
    alive: false,
    latencyMs: null,
  };
  expect(observedGroupSummaries(current, compatible, 9).get('chain')?.state).toBe('failed');
  expect(
    observedGroupSummaries(current, compatibleObservedGroups({ ...config, dns: {} }, config), 9)
      .size,
  ).toBe(0);
});
