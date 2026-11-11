import { expect, it } from 'vitest';
import { outboundDependencyProblems } from './outboundDependencies';

it.each(['xhttpSettings', 'splithttpSettings'])(
  'checks active %s download dependencies while preserving unused transport settings',
  (field) => {
    const outbounds = [
      {
        tag: 'a',
        protocol: 'vless',
        streamSettings: {
          network: 'xhttp',
          [field]: { extra: { downloadSettings: { sockopt: { dialerProxy: 'a' } } } },
        },
      },
    ];
    expect(
      outboundDependencyProblems({ outbounds }).some((problem) => problem.message.includes('loop')),
    ).toBe(true);
    outbounds[0].streamSettings.network = 'ws';
    expect(outboundDependencyProblems({ outbounds })).toEqual([]);
  },
);
it('handles substantial terminating chains and externally generated handlers without recursion', () => {
  const outbounds = Array.from({ length: 10000 }, (_, index) => ({
    tag: `hop-${index}`,
    protocol: 'freedom',
    streamSettings: {
      sockopt: { dialerProxy: index < 9999 ? `hop-${index + 1}` : 'reverse-handler' },
    },
  }));
  expect(outboundDependencyProblems({ outbounds }, new Set(['reverse-handler']))).toEqual([]);
});

it.each([{}, null])('does not inspect download settings replaced by extra %j', (extra) => {
  expect(
    outboundDependencyProblems({
      outbounds: [
        {
          tag: 'a',
          protocol: 'freedom',
          streamSettings: {
            network: 'xhttp',
            xhttpSettings: {
              downloadSettings: { sockopt: { dialerProxy: 'a' } },
              extra,
            },
          },
        },
      ],
    }),
  ).toEqual([]);
});

it('uses modern XHTTP settings in preference to legacy SplitHTTP settings', () => {
  expect(
    outboundDependencyProblems({
      outbounds: [
        {
          tag: 'a',
          protocol: 'freedom',
          streamSettings: {
            network: 'splithttp',
            xhttpSettings: {},
            splithttpSettings: { downloadSettings: { sockopt: { dialerProxy: 'a' } } },
          },
        },
      ],
    }),
  ).toEqual([]);
});

it('uses method in preference to network when selecting XHTTP download dependencies', () => {
  const streamSettings = {
    method: 'xhttp',
    network: 'ws',
    xhttpSettings: { extra: { downloadSettings: { sockopt: { dialerProxy: 'loop' } } } },
  };
  const config = { outbounds: [{ tag: 'loop', protocol: 'vless', streamSettings }] };
  expect(outboundDependencyProblems(config)).toEqual([
    { tag: 'loop', message: 'Dial-through settings lead to an outbound loop.' },
  ]);
  Object.assign(streamSettings, { method: 'ws', network: 'xhttp' });
  expect(outboundDependencyProblems(config)).toEqual([]);
});
