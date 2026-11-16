import { expect, it } from 'vitest';
import { matchesApplied, matchesCapture } from './runtimeState';
it('compares effective JSON independently of service log normalization and object key order', () => {
  const a = {
    log: { loglevel: 'warning', dnsLog: false, maskAddress: 'full' },
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
  const b = {
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    log: { error: '', access: 'none', maskAddress: 'full', loglevel: 'warning' },
  };
  expect(matchesApplied(a, b)).toBe(true);
});
it('compares capture plans independently of key order, preserving input precedence', () => {
  const a = {
    version: 1,
    inputs: [
      { tag: 'first', ports: '80' },
      { tag: 'last', ports: '443' },
    ],
  };
  expect(
    matchesCapture(a, {
      inputs: [
        { ports: '80', tag: 'first' },
        { ports: '443', tag: 'last' },
      ],
      version: 1,
    }),
  ).toBe(true);
  expect(matchesCapture(a, { ...a, inputs: [...a.inputs].reverse() })).toBe(false);
  expect(matchesCapture(a, { ...a, inputs: [{ tag: 'first', ports: '81' }, a.inputs[1]] })).toBe(
    false,
  );
  expect(matchesCapture(undefined, null)).toBe(true);
});
it('detects credential and rule-order edits and distinguishes a missing applied configuration', () => {
  const a = {
    routing: { rules: [{ port: 80 }, { port: 443 }] },
    outbounds: [{ settings: { id: 'first' } }],
  };
  expect(matchesApplied(a, { ...a, outbounds: [{ settings: { id: 'second' } }] })).toBe(false);
  expect(matchesApplied(a, { ...a, routing: { rules: [{ port: 443 }, { port: 80 }] } })).toBe(
    false,
  );
  expect(matchesApplied(a, null)).toBe(false);
});
it('ignores saved resolver telemetry in generated graphs and still detects DNS changes', () => {
  const first = { address: '192.0.2.1', domains: ['domain:private.example'] };
  const last = { address: '192.0.2.1' };
  const draft = { dns: { tag: 'wdg-global', servers: [first, last] } };
  const previous = {
    dns: {
      ...draft.dns,
      servers: [
        { ...first, id: 'wra-AAAAAAAAAAAAAAAAAAAAAA' },
        { ...last, id: 'wra-BBBBBBBBBBBBBBBBBBBBBB' },
      ],
    },
  };
  expect(matchesApplied(draft, previous, true)).toBe(true);
  expect(matchesApplied(draft, previous)).toBe(false);
  expect(
    matchesApplied(
      draft,
      { dns: { ...previous.dns, servers: [...previous.dns.servers].reverse() } },
      true,
    ),
  ).toBe(false);
});
