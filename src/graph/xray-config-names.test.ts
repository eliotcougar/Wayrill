import { describe, expect, it } from 'vitest';
import { fixXrayCapitalization, inspectXrayCapitalization } from './xrayConfigNames';
import { importXrayConfig } from './xrayImport';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import { parseXrayJson } from './xrayJson';

describe('Schema-aware Xray capitalization repair', () => {
  it('repairs root/groups and protocol, transport, routing, DNS and policy fields, then round-trips the repaired config', () => {
    const source = {
      Inbounds: [
        {
          Tag: 'LOCAL',
          Protocol: 'socks',
          Listen: '127.0.0.1',
          Port: 2080,
          Settings: { Auth: 'noauth', UDP: true },
          Sniffing: { Enabled: true, RouteOnly: false, DestOverride: ['http', 'tls'] },
        },
      ],
      Outbounds: [
        {
          Tag: 'EDGE',
          Protocol: 'vless',
          Settings: {
            Address: 'Public.Example',
            Port: 443,
            ID: 'fictional-public',
            Encryption: 'none',
          },
          Streamsettings: {
            Network: 'xhttp',
            Security: 'tls',
            xhttpsettings: {
              Path: '/TLSSettings',
              Extra: { NoGRPCHeader: false, XMUX: { MaxConcurrency: '2-4' } },
              Headers: { 'User-Agent': 'MY/UA', PATH: 'Keep' },
            },
            tlssettings: { ServerName: 'Public.Example', Fingerprint: 'chrome' },
          },
        },
        { Tag: 'DIRECT', Protocol: 'freedom' },
      ],
      Routing: {
        Rules: [{ InboundTag: ['LOCAL'], Domain: ['domain:Example.NET'], OutboundTag: 'EDGE' }],
      },
      Observatory: {
        SubjectSelector: ['EDGE'],
        probeUrl: 'https://Public.Example/Ping',
        ProbeInterval: '1m',
        EnableConcurrency: true,
      },
      DNS: {
        Hosts: { 'Domain:Example.NET': '1.1.1.1' },
        Servers: [{ Address: '1.1.1.1', ExpectedIPS: ['1.1.1.0/24'], TimeoutMS: 0 }],
      },
      Policy: {
        Levels: { '0': { ConnIdle: 0, StatsUserUplink: false } },
        System: { StatsOutboundUplink: true },
      },
    };
    const fixed = fixXrayCapitalization(JSON.stringify(source));
    expect(inspectXrayCapitalization(fixed.text)).toEqual([]);
    const value = parseXrayJson(fixed.text) as typeof source;
    expect(value).toMatchObject({
      observatory: { probeURL: 'https://Public.Example/Ping' },
      outbounds: [
        {
          tag: 'EDGE',
          settings: { address: 'Public.Example', id: 'fictional-public' },
          streamSettings: {
            xhttpSettings: {
              path: '/TLSSettings',
              extra: { noGRPCHeader: false, xmux: { maxConcurrency: '2-4' } },
              headers: { 'User-Agent': 'MY/UA', PATH: 'Keep' },
            },
            tlsSettings: { serverName: 'Public.Example' },
          },
        },
        {},
      ],
      dns: { hosts: { 'Domain:Example.NET': '1.1.1.1' } },
    });
    const graph = parseGraph(serializeGraph(importXrayConfig(fixed.text)));
    expect(compileRuntimeGraph(graph).config).toEqual(value);
  });

  it('changes only property tokens, keeping BOM, comments, whitespace, literals and escaped string values', () => {
    const text =
      '\uFEFF{ // "Outbounds" in a comment\r\n  "\\u004futbounds" : [ { "Protocol": "freedom", "Tag": "TLSSettings\\nStay", "Settings": { "UserLevel": 0 } } ], /* tail */ "Other": "Observatory"\r\n}';
    const result = fixXrayCapitalization(text);
    expect(result.text).toBe(
      text
        .replace('"\\u004futbounds"', '"outbounds"')
        .replace('"Protocol"', '"protocol"')
        .replace('"Tag"', '"tag"')
        .replace('"Settings"', '"settings"')
        .replace('"UserLevel"', '"userLevel"'),
    );
    expect(result.changes.map((c) => c.path)).toContain('/Outbounds/0/Settings/UserLevel');
    expect(fixXrayCapitalization(result.text)).toEqual({ text: result.text, changes: [] });
  });

  it.each([
    '{"Observatory":{},"observatory":{}}',
    '{"outbounds":[{"protocol":"vless","streamSettings":{"tlsSettings":{},"TLSSETTINGS":{}}}]}',
    '{"routing":{"rules":[{"outboundTag":"a","OUTBOUNDTAG":"a"}]}}',
    '{"policy":{"levels":{"0":{"connIdle":1,"CONNIDLE":2}}}}',
    '{"dns":{"servers":[{"address":"localhost","ADDRESS":"localhost"}]}}',
  ])('refuses ambiguous aliases without choosing a value: %s', (text) => {
    expect(() => inspectXrayCapitalization(text)).toThrow('Ambiguous Xray fields');
    expect(() => fixXrayCapitalization(text)).toThrow('Resolve the duplicate names');
  });

  it('preserves extension objects, user dictionary names and unknown protocol/strategy bodies', () => {
    const text = JSON.stringify({
      Outbounds: [
        {
          Protocol: 'future',
          Tag: 'EDGE',
          Settings: { ID: 'SECRET', TLSSettings: {}, Tag: 'keep' },
          StreamSettings: {
            WSSettings: { Headers: { Host: 'A', HOST: 'B', TLSSettings: 'C' } },
            sockopts: { TCPFastOpen: false },
          },
        },
      ],
      DNS: { Hosts: { Example: '1.1.1.1', EXAMPLE: '8.8.8.8' } },
      Unknown: { Routing: { Rules: [] } },
      Routing: {
        Balancers: [
          {
            Tag: 'pool',
            Selector: ['EDGE'],
            Strategy: { Type: 'future', Settings: { Expected: 1 } },
          },
        ],
      },
    });
    const result = parseXrayJson(fixXrayCapitalization(text).text);
    expect(result).toMatchObject({
      outbounds: [
        {
          protocol: 'future',
          tag: 'EDGE',
          settings: { ID: 'SECRET', TLSSettings: {}, Tag: 'keep' },
          streamSettings: {
            wsSettings: { headers: { Host: 'A', HOST: 'B', TLSSettings: 'C' } },
            sockopts: { TCPFastOpen: false },
          },
        },
      ],
      dns: { hosts: { Example: '1.1.1.1', EXAMPLE: '8.8.8.8' } },
      Unknown: { Routing: { Rules: [] } },
      routing: { balancers: [{ strategy: { type: 'future', settings: { Expected: 1 } } }] },
    });
  });

  it('uses the protocol account shape and keeps legacy layout aliases distinct', () => {
    const fixed = fixXrayCapitalization(
      JSON.stringify({
        inbounds: [
          {
            protocol: 'vless',
            settings: {
              Clients: [{ ID: 'ID', Email: 'USER', Reverse: { TAG: 'CaseSensitive' } }],
              Users: [],
            },
          },
        ],
        outbounds: [
          {
            protocol: 'socks',
            settings: {
              Servers: [{ Address: 'Server', Port: 1080, Users: [{ User: 'USER', Pass: 'Pass' }] }],
            },
          },
        ],
      }),
    );
    expect(parseXrayJson(fixed.text)).toMatchObject({
      inbounds: [
        {
          settings: {
            clients: [{ id: 'ID', email: 'USER', reverse: { tag: 'CaseSensitive' } }],
            users: [],
          },
        },
      ],
      outbounds: [
        {
          settings: {
            servers: [{ address: 'Server', port: 1080, users: [{ user: 'USER', pass: 'Pass' }] }],
          },
        },
      ],
    });
  });

  it.each([false, true])(
    'repairs object/array FakeDNS pools without changing the existing runtime root spelling: array=%s',
    (array) => {
      const pool = { IPPool: '198.18.0.0/15', PoolSize: 1000 };
      const fixed = fixXrayCapitalization(JSON.stringify({ FakeDNS: array ? [pool] : pool }));
      const value = parseXrayJson(fixed.text);
      expect(value).toEqual({
        fakedns: array
          ? [{ ipPool: '198.18.0.0/15', poolSize: 1000 }]
          : { ipPool: '198.18.0.0/15', poolSize: 1000 },
      });
      expect(compileRuntimeGraph(importXrayConfig(fixed.text)).config).toEqual(value);
    },
  );

  it('repairs known HTTP authentication and direction-specific mask bodies without changing custom maps', () => {
    const fixed = fixXrayCapitalization(
      JSON.stringify({
        outbounds: [
          {
            protocol: 'freedom',
            streamSettings: {
              RawSettings: {
                Header: { Type: 'http', Request: { Method: 'GET', Headers: { Host: ['UPPER'] } } },
              },
              FinalMask: {
                TCP: [{ Type: 'fragment', Settings: { Packets: 'tlshello', Length: '10-20' } }],
                UDP: [
                  { Type: 'udphop', Settings: { Interval: 10 } },
                  { Type: 'future', Settings: { Interval: 10 } },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(parseXrayJson(fixed.text)).toMatchObject({
      outbounds: [
        {
          streamSettings: {
            rawSettings: {
              header: { type: 'http', request: { method: 'GET', headers: { Host: ['UPPER'] } } },
            },
            finalmask: {
              tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '10-20' } }],
              udp: [
                { type: 'udphop', settings: { interval: 10 } },
                { type: 'future', settings: { Interval: 10 } },
              ],
            },
          },
        },
      ],
    });
  });

  it('patches every array entry without truncating a large correction set', () => {
    const text = JSON.stringify({
      Outbounds: Array.from({ length: 5000 }, (_, i) => ({ Tag: `Out-${i}`, Protocol: 'freedom' })),
    });
    const fixed = fixXrayCapitalization(text);
    expect(fixed.changes).toHaveLength(10001);
    expect(inspectXrayCapitalization(fixed.text)).toEqual([]);
    expect(
      (parseXrayJson(fixed.text) as { outbounds: { tag: string }[] }).outbounds[4999].tag,
    ).toBe('Out-4999');
  });

  it.each([
    '[]',
    '{"__proto__":{}}',
    '{"x":9007199254740993}',
    '{"Outbounds":[],"Outbounds":[]}',
    '{"Outbounds":[],}',
  ])('retains strict parsing for unsafe/ambiguous input: %s', (text) => {
    expect(() => fixXrayCapitalization(text)).toThrow();
  });
});
