import { describe, expect, it } from 'vitest';
import { getDefinition, getOutputPorts, makeProxyInbound, uniqueInboundTag } from './catalog';
import { createRoutingExample } from './example';
import { inboundPreview, inboundProblems, isIpLiteral, inboundPreFilters } from './inbounds';
import { connectionProblem, diagnoseGraph, parseGraph, serializeGraph, toDocument } from './model';
import { fieldProblem, isFieldVisible } from './settingValidation';
import type { SettingValue } from './types';

const configured = (settings: Record<string, SettingValue> = {}) => {
  const node = makeProxyInbound('socks', { x: 0, y: 0 }, 'socks');
  Object.assign(node.data.settings, settings);
  return node;
};

describe('SOCKS inbound configuration and branches', () => {
  it('provides two independently connectable source paths with no input port', () => {
    expect(getOutputPorts('proxy-inbound')).toEqual(['data', 'dns']);
    const graph = createRoutingExample();
    graph.edges = graph.edges.filter((edge) => edge.source !== 'socks');
    const data = { source: 'socks', target: 'routes', sourceHandle: 'data', targetHandle: 'in' };
    expect(connectionProblem(graph, data)).toBeNull();
    graph.edges.push({ ...data, id: 'data' });
    expect(
      connectionProblem(graph, {
        source: 'socks',
        target: 'direct',
        sourceHandle: 'dns',
        targetHandle: 'in',
      }),
    ).toBeNull();
    expect(connectionProblem(graph, { ...data, target: 'block' })).toMatch(/already has a path/);
    expect(
      connectionProblem(graph, {
        source: 'routes',
        target: 'socks',
        sourceHandle: 'preferred',
        targetHandle: 'in',
      }),
    ).toMatch(/input port/);
  });
  it('limits DNS preclassification to destination port 53 before the data fallback', () => {
    expect(inboundPreFilters(configured().data)).toEqual([
      { branch: 'dns', match: { inboundTag: ['local-proxy'], network: 'tcp,udp', port: '53' } },
      { branch: 'data', match: { inboundTag: ['local-proxy'] } },
    ]);
    // Domain addresses and ports 443/853 do not have a DNS predicate in the compiled first branch.
    expect(inboundPreFilters(configured().data)[0].match).not.toHaveProperty('domain');
  });
  it('maps safe local defaults and never embeds DNS routing into inbound protocol settings', () => {
    const preview = inboundPreview(configured().data);
    expect(preview).toMatchObject({
      tag: 'local-proxy',
      listen: '127.0.0.1',
      port: 10808,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true, userLevel: 0 },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
    });
    expect(preview.settings).not.toHaveProperty('dns');
    expect(preview).not.toHaveProperty('routing');
  });
  it('maps multiple accounts and rejects duplicate usernames and byte-overlong credentials', () => {
    const node = configured({
      auth: 'password',
      username: 'first',
      password: 'qa-only',
      extraAccounts: '[{"user":"second","pass":"qa-two"}]',
    });
    expect(inboundPreview(node.data).settings).toMatchObject({
      users: [
        { user: 'first', pass: 'qa-only' },
        { user: 'second', pass: 'qa-two' },
      ],
    });
    expect(inboundProblems(node.data)).toEqual([]);
    node.data.settings.extraAccounts = '[{"user":"first","pass":"duplicate"}]';
    expect(inboundProblems(node.data).some((issue) => issue.fieldKey === 'extraAccounts')).toBe(
      true,
    );
    node.data.settings.username = 'я'.repeat(128);
    expect(inboundProblems(node.data).some((issue) => issue.fieldKey === 'username')).toBe(true);
    node.data.settings.extraAccounts = '[{"user":"bad","pass":3}]';
    expect(inboundProblems(node.data).some((issue) => issue.fieldKey === 'extraAccounts')).toBe(
      true,
    );
  });
  it('validates addresses and only warns about remote unauthenticated listening', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '::1', '2001:db8::1', '::ffff:192.0.2.1'])
      expect(isIpLiteral(address), address).toBe(true);
    for (const address of [
      '999.1.1.1',
      'example.net',
      '127.0.0.1:10808',
      'https://127.0.0.1',
      '[::1]',
      '1::2::3',
    ])
      expect(isIpLiteral(address), address).toBe(false);
    expect(inboundProblems(configured().data)).toEqual([]);
    expect(inboundProblems(configured({ listen: '0.0.0.0' }).data)).toContainEqual(
      expect.objectContaining({ fieldKey: 'auth', severity: 'warning' }),
    );
    expect(inboundProblems(configured({ listen: 'host.example' }).data)).toContainEqual(
      expect.objectContaining({ fieldKey: 'listen', severity: 'error' }),
    );
  });
  it('preserves inactive drafts but omits them from preview and diagnostics', () => {
    const node = configured({
      auth: 'noauth',
      password: 'retained',
      extraAccounts: '{',
      udp: false,
      udpAddress: 'invalid',
      sniffing: false,
      domainsExcluded: '{',
    });
    const definition = getDefinition('proxy-inbound');
    expect(
      definition.fields
        .filter((field) => isFieldVisible(field, node.data.settings))
        .some((field) => field.key === 'extraAccounts'),
    ).toBe(false);
    expect(
      definition.fields.map((field) => fieldProblem(field, node.data.settings)).filter(Boolean),
    ).toEqual([]);
    expect(inboundProblems(node.data)).toEqual([]);
    const preview = inboundPreview(node.data);
    expect(preview.settings).not.toHaveProperty('users');
    expect(preview.settings).not.toHaveProperty('ip');
    expect(preview.sniffing).toEqual({ enabled: false });
    expect(
      parseGraph(serializeGraph({ name: 'Drafts', nodes: [node], edges: [] })).nodes[0].data
        .settings.password,
    ).toBe('retained');
  });
  it('checks exclusion arrays and maps advanced settings with metadata-only notices', () => {
    const node = configured({
      domainsExcluded: '["full:example.net"]',
      ipsExcluded: '["192.168.0.0/16"]',
      streamSettings: '{"sockopt":{"tcpFastOpen":true}}',
    });
    expect(inboundPreview(node.data)).toMatchObject({
      sniffing: { domainsExcluded: ['full:example.net'], ipsExcluded: ['192.168.0.0/16'] },
      streamSettings: { sockopt: { tcpFastOpen: true } },
    });
    node.data.settings.ipsExcluded = '[4]';
    node.data.settings.metadataOnly = true;
    expect(
      diagnoseGraph({ name: 'Exclusion validation', nodes: [node], edges: [] }),
    ).toContainEqual(
      expect.objectContaining({ nodeId: node.id, fieldKey: 'ipsExcluded', severity: 'error' }),
    );
    expect(inboundProblems(node.data)).toContainEqual(
      expect.objectContaining({ fieldKey: 'metadataOnly', severity: 'warning' }),
    );
  });
  it('rejects missing/unknown ports on new documents and diagnoses duplicate tags/listeners', () => {
    const raw = toDocument(createRoutingExample());
    raw.edges[0].sourceHandle = 'traffic';
    expect(() => parseGraph(JSON.stringify(raw))).toThrow(/matching output port/);
    const first = configured();
    const other = { ...configured(), id: 'other' };
    const issues = diagnoseGraph({ name: 'Duplicates', nodes: [first, other], edges: [] });
    expect(issues).toContainEqual(expect.objectContaining({ fieldKey: 'tag', severity: 'error' }));
    expect(issues).toContainEqual(expect.objectContaining({ fieldKey: 'port', severity: 'error' }));
    expect(uniqueInboundTag('local-proxy', [first])).toBe('local-proxy-2');
  });
  it('round-trips a fully connected separate DNS example', () => {
    const graph = createRoutingExample();
    expect(diagnoseGraph(graph)).toEqual([]);
    expect(toDocument(parseGraph(serializeGraph(graph)))).toEqual(toDocument(graph));
  });
});
