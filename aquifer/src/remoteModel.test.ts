import { describe, expect, it } from 'vitest';
import { remoteView, redact } from './remoteModel';
import { jsonRecord } from './graph/xrayJson';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { readRuleTable, tableSettings } from './graph/rules';

it('edits effective imported routing aliases without retaining a competing predicate', () => {
  const config = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      rules: [
        {
          domain: ['full:ignored.example'],
          domains: ['full:active.example'],
          source: ['192.0.2.0/24'],
          sourceIP: ['10.0.0.0/8'],
          port: '443',
          outboundTag: 'block',
          ruleTag: 'keep-this-tag',
        },
      ],
    },
  };
  const view = remoteView(JSON.stringify(config));
  const workspace = createUserWorkspace(view.original, emptyLibrary());
  const filter = view.graph.nodes.find((node) => node.id === view.graph.xray!.routingNodeId)!;
  const table = readRuleTable(filter.data.settings);
  expect(table.rules[0].conditions.domain).toBe('full:active.example');
  expect(table.rules[0].conditions.sourceIP).toBe('10.0.0.0/8');
  expect(compileRemote(view, workspace).config).toEqual(config);

  table.rules[0].conditions.domain = 'full:edited.example';
  table.rules[0].conditions.sourceIP = '';
  filter.data.settings = tableSettings(table);
  const result = compileRemote(view, workspace);
  expect(result.errors).toEqual([]);
  expect(result.config.routing).toEqual({
    rules: [
      {
        domain: ['full:edited.example'],
        port: '443',
        outboundTag: 'block',
        ruleTag: 'keep-this-tag',
      },
    ],
  });
  // A reload must retain the edited behavior, not revive either source alias.
  const reloaded = remoteView(JSON.stringify(result.config));
  expect(
    compileRemote(reloaded, createUserWorkspace(reloaded.original, emptyLibrary())).config,
  ).toEqual(result.config);
});

describe('read-only remote graph projection', () => {
  it('does not treat a real outbound as an API virtual endpoint', () => {
    const view = remoteView(
      JSON.stringify({
        inbounds: [],
        api: { tag: 'api' },
        outbounds: [{ tag: 'api', protocol: 'freedom' }],
        routing: { rules: [{ type: 'field', network: 'tcp', outboundTag: 'api' }] },
      }),
    );
    expect(view.nodes.some((n) => n.id === 'remote-api')).toBe(false);
    expect(view.ruleCount).toBe(1);
  });
  it('represents explicit outbound dial-through dependencies', () => {
    const view = remoteView(
      JSON.stringify({
        inbounds: [],
        outbounds: [
          {
            tag: 'first',
            protocol: 'freedom',
            streamSettings: { sockopt: { dialerProxy: 'second' } },
          },
          { tag: 'second', protocol: 'socks', settings: { address: '127.0.0.1', port: 1080 } },
        ],
      }),
    );
    expect(view.edges.some((e) => e.id === 'via-0' && e.target === 'native-out-1')).toBe(true);
    expect(view.nodes.find((n) => n.id === 'native-out-1')?.data.hasInput).toBe(true);
  });
  it('rejects duplicate keys, unsafe objects and missing destinations', () => {
    for (const source of [
      '{"outbounds":[],"outbounds":[]}',
      '{"__proto__":{}}',
      '{"routing":{"rules":[{"outboundTag":"missing"}]}}',
    ])
      expect(() => remoteView(source)).toThrow();
  });
});
describe('credential display', () => {
  it('masks Hysteria authentication tokens in user sets and transport settings', () => {
    expect(
      JSON.stringify(
        redact({
          users: [{ account: { auth: 'fictional-secret-token' } }],
          hysteriaSettings: { auth: 'fictional-transport-token' },
        }),
      ),
    ).not.toContain('fictional');
  });
  it('redacts nested account and header secrets without changing the source', () => {
    const raw = {
      settings: { clients: [{ id: 'private', email: 'person@example.org', password: 'secret' }] },
      headers: { Authorization: 'Bearer private', 'X-API-Key': 'private' },
      address: 'example.org',
      port: 443,
    };
    const result = redact(raw);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(jsonRecord(result) && result.address).toBe('example.org');
    expect(raw.settings.clients[0].password).toBe('secret');
  });
  it('redacts credentials embedded in resolver URLs', () => {
    const result = String(
      redact('https://alice:password@dns.example.org/query?token=secret&mode=json'),
    );
    expect(result).not.toContain('alice');
    expect(result).not.toContain('password');
    expect(result).not.toContain('secret');
    expect(result).toContain('mode=json');
  });
});
