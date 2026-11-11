import { describe, expect, it } from 'vitest';
import { remoteView, redact, ruleConditions } from './remoteModel';
import { demoConfig } from './demo';
import { jsonRecord } from './graph/xrayJson';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { readRuleTable, tableSettings } from './graph/rules';

it('exports ordered graph rules instead of replaying the source configuration', () => {
  const view = remoteView(JSON.stringify(demoConfig));
  const routing = view.graph.nodes.find((node) => node.id === 'native-routing')!;
  const table = readRuleTable(routing.data.settings);
  table.rules.push(table.rules.shift()!);
  routing.data.settings = tableSettings(table);
  const workspace = createUserWorkspace(view.original, emptyLibrary());
  const exported = compileRemote(view, workspace);
  expect(exported.errors).toEqual([]);
  expect(exported.config.routing).toEqual({
    ...demoConfig.routing,
    rules: [...demoConfig.routing.rules.slice(1), demoConfig.routing.rules[0]],
  });
  expect(exported.config.outbounds).toEqual(demoConfig.outbounds);
});

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
  it('keeps all source values and ordered rules with an internal API endpoint', () => {
    const view = remoteView(JSON.stringify(demoConfig));
    expect(view.original).toEqual(demoConfig);
    expect(view.ruleCount).toBe(4);
    const router = view.nodes.find((n) => n.id === 'native-routing')!;
    expect(router.data.rules).toEqual(demoConfig.routing.rules);
    expect(view.nodes.find((n) => n.id === 'remote-api')?.data.subtitle).toBe(
      'Xray API · internal',
    );
    expect(view.edges.some((e) => e.target === 'remote-api')).toBe(true);
    expect(view.nodes.some((n) => n.data.category === 'inbound')).toBe(true);
    expect(view.nodes.some((n) => n.data.subtitle === 'Observatory')).toBe(true);
    expect(view.nodes.filter((n) => n.id.startsWith('native-resolver-'))).toHaveLength(2);
  });
  it('canonicalizes display field names without modifying the original JSON', () => {
    const config = { ...demoConfig, observatory: undefined, Observatory: demoConfig.observatory };
    const source = '// untouched source\n' + JSON.stringify(config);
    const view = remoteView(source);
    expect(view.original.Observatory).toEqual(demoConfig.observatory);
    expect(view.original.observatory).toBeUndefined();
    expect(view.normalized.observatory).toEqual(demoConfig.observatory);
    expect(view.notices.some((n) => n.includes('capitalization'))).toBe(true);
  });
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
  it('retains exact per-node native inbound and outbound objects', () => {
    const view = remoteView(JSON.stringify(demoConfig));
    expect(view.nodes.find((n) => n.id === 'native-in-0')?.data.raw).toEqual(
      demoConfig.inbounds[0],
    );
    expect(view.nodes.find((n) => n.id === 'native-out-2')?.data.raw).toEqual(
      demoConfig.outbounds[2],
    );
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
  it('describes rule conditions including native objects', () => {
    expect(ruleConditions({ type: 'field', outboundTag: 'direct' })).toBe('All traffic');
    expect(ruleConditions({ domain: ['example.org'], attrs: { key: 'value' } })).toContain(
      'attrs: {"key":"value"}',
    );
  });
});
