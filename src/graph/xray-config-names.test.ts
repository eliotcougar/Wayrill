import { describe, expect, it } from 'vitest';
import { fixXrayCapitalization, inspectXrayCapitalization } from './xrayConfigNames';
import {
  fixXrayCapitalization as fixAquifer,
  inspectXrayCapitalization as inspectAquifer,
} from '../../aquifer/src/graph/xrayConfigNames';

describe.each([
  ['Wayrill', fixXrayCapitalization, inspectXrayCapitalization],
  ['Aquifer', fixAquifer, inspectAquifer],
] as const)('%s schema-aware capitalization repair', (_name, fix, inspect) => {
  it.each([
    '{"Observatory":{},"observatory":{}}',
    '{"outbounds":[{"protocol":"vless","streamSettings":{"tlsSettings":{},"TLSSETTINGS":{}}}]}',
    '{"routing":{"rules":[{"outboundTag":"a","OUTBOUNDTAG":"a"}]}}',
    '{"policy":{"levels":{"0":{"connIdle":1,"CONNIDLE":2}}}}',
    '{"dns":{"servers":[{"address":"localhost","ADDRESS":"localhost"}]}}',
  ])('refuses ambiguous aliases without choosing a value: %s', (text) => {
    expect(() => inspect(text)).toThrow('Ambiguous Xray fields');
    expect(() => fix(text)).toThrow('Resolve the duplicate names');
  });

  it('preserves comments, values and dictionary keys while correcting nested fields', () => {
    const original = `{
  // Keep this comment and the custom header spelling.
  "OUTBOUNDS": [{"PROTOCOL":"vless","SETTINGS":{"ID":"UserID","REVERSE":{"TAG":"ReverseTag"}},
    "STREAMSETTINGS":{"WSSETTINGS":{"HEADERS":{"Host":"Keep.EXAMPLE","X-User":"VALUE"}}}}],
  "DNS":{"HOSTS":{"Full:Example.COM":["127.0.0.1"]}},
  "POLICY":{"LEVELS":{"User/0~":{"CONNIDLE":30}}},
  "Unknown":{"TAG":"KeepThis"}
}`;
    const expected = `{
  // Keep this comment and the custom header spelling.
  "outbounds": [{"protocol":"vless","settings":{"id":"UserID","reverse":{"tag":"ReverseTag"}},
    "streamSettings":{"wsSettings":{"headers":{"Host":"Keep.EXAMPLE","X-User":"VALUE"}}}}],
  "dns":{"hosts":{"Full:Example.COM":["127.0.0.1"]}},
  "policy":{"levels":{"User/0~":{"connIdle":30}}},
  "Unknown":{"TAG":"KeepThis"}
}`;
    const repaired = fix(original);
    expect(repaired.text).toBe(expected);
    expect(repaired.changes).toEqual(inspect(original));
    expect(repaired.changes).toContainEqual({
      path: '/POLICY/LEVELS/User~10~0/CONNIDLE',
      from: 'CONNIDLE',
      to: 'connIdle',
    });
    expect(fix(repaired.text)).toEqual({ text: expected, changes: [] });
  });
});

it('uses each app’s pinned XDNS schema without adopting fields from the other core', () => {
  const config = JSON.stringify({
    outbounds: [
      {
        streamSettings: {
          finalmask: {
            udp: [
              {
                type: 'xdns',
                settings: {
                  resolvers: [
                    {
                      ADDRS: ['Resolver.EXAMPLE:53'],
                      WORKER: 2,
                      TYPE: 'tcp',
                      SETTINGS: { ADDR: 'Resolver.EXAMPLE:53' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  });
  expect(inspectXrayCapitalization(config).map(({ from, to }) => [from, to])).toEqual([
    ['ADDRS', 'addrs'],
    ['WORKER', 'worker'],
  ]);
  expect(inspectAquifer(config).map(({ from, to }) => [from, to])).toEqual([
    ['TYPE', 'type'],
    ['SETTINGS', 'settings'],
    ['ADDR', 'addr'],
  ]);
});
