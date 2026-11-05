import { expect, it } from 'vitest';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { createUserWorkspace, emptyLibrary } from './users/model';

const config = {
  inbounds: [
    {
      tag: 'admin',
      protocol: 'dokodemo-door',
      listen: '127.0.0.1',
      port: 10085,
      settings: { address: '127.0.0.1' },
    },
    { tag: 'public', protocol: 'vless', port: 443, settings: { decryption: 'none', clients: [] } },
  ],
  outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  api: { tag: 'api', services: ['StatsService'] },
  routing: {
    rules: [
      { type: 'field', inboundTag: ['admin'], outboundTag: 'api' },
      { type: 'field', inboundTag: 'public', domain: ['example.org'], outboundTag: 'direct' },
    ],
  },
};
it('renames inbound routing references while keeping API destinations and unrelated rules intact', () => {
  const view = remoteView(JSON.stringify(config));
  const value = nodeSettings(view, 'native-in-0')!.value as Record<string, unknown>;
  const next = replaceNodeSettings(view, 'native-in-0', { ...value, tag: 'local-api' });
  const output = compileRemote(next, createUserWorkspace(config, emptyLibrary()));
  expect(output.errors).toEqual([]);
  expect(output.config.routing).toEqual({
    rules: [{ ...config.routing.rules[0], inboundTag: ['local-api'] }, config.routing.rules[1]],
  });
  expect(view.original).toEqual(config);
});
it('preserves draft spelling and exports canonical listener references', () => {
  const source = {
    ...config,
    routing: { Rules: [{ type: 'field', InboundTag: ['public'], outboundTag: 'direct' }] },
  };
  const view = remoteView(JSON.stringify(source));
  const next = replaceNodeSettings(view, 'native-in-1', {
    ...(nodeSettings(view, 'native-in-1')!.value as object),
    tag: 'new-public',
  });
  const output = compileRemote(next, createUserWorkspace(source, emptyLibrary()));
  expect(output.config.routing).toEqual({
    rules: [{ type: 'field', inboundTag: ['new-public'], outboundTag: 'direct' }],
  });
});
it('refuses a duplicate or empty referenced tag without changing the graph', () => {
  const view = remoteView(JSON.stringify(config));
  const value = nodeSettings(view, 'native-in-1')!.value as Record<string, unknown>;
  expect(() => replaceNodeSettings(view, 'native-in-1', { ...value, tag: 'admin' })).toThrow(
    'Another inbound',
  );
  expect(() => replaceNodeSettings(view, 'native-in-1', { ...value, tag: '' })).toThrow(
    'used by routing',
  );
  expect(view.original).toEqual(config);
});
it.each(['remote-api', 'native-options'])(
  'keeps API routing connected when renaming through %s',
  (id) => {
    const view = remoteView(JSON.stringify(config));
    const value = nodeSettings(view, id)!.value as Record<string, unknown>;
    const next = replaceNodeSettings(
      view,
      id,
      id === 'remote-api'
        ? { ...value, tag: 'management' }
        : { ...value, api: { ...config.api, tag: 'management' } },
    );
    const output = compileRemote(next, createUserWorkspace(config, emptyLibrary()));
    expect(output.errors).toEqual([]);
    expect(output.config.api).toEqual({ ...config.api, tag: 'management' });
    expect(output.config.routing).toEqual({
      rules: [{ ...config.routing.rules[0], outboundTag: 'management' }, config.routing.rules[1]],
    });
    expect(view.original).toEqual(config);
  },
);
it('disables managed API plumbing and rejects colliding tags without changing the original', () => {
  const view = remoteView(JSON.stringify(config));
  const value = nodeSettings(view, 'native-options')!.value as Record<string, unknown>;
  const disabled = replaceNodeSettings(view, 'native-options', { ...value, api: undefined });
  expect(disabled.original.inbounds).toEqual([config.inbounds[1]]);
  expect(disabled.original.routing).toEqual({ rules: [config.routing.rules[1]] });
  expect(() => replaceNodeSettings(view, 'remote-api', { tag: 'direct' })).toThrow('already uses');
  expect(view.original).toEqual(config);
});

const outboundConfig = {
  outbounds: [
    { tag: 'relay-eu', protocol: 'freedom' },
    {
      tag: 'chained',
      protocol: 'freedom',
      streamSettings: {
        sockopt: { dialerProxy: 'relay-eu' },
        xhttpSettings: { extra: { downloadSettings: { sockopt: { dialerProxy: 'relay-eu' } } } },
      },
    },
  ],
  routing: {
    balancers: [{ tag: 'regional', selector: ['relay-eu'], fallbackTag: 'relay-eu' }],
    rules: [
      { domain: ['example.org'], outboundTag: 'relay-eu' },
      { domain: ['other.example'], balancerTag: 'regional' },
    ],
  },
  observatory: { subjectSelector: ['relay-eu'] },
  geodata: { outbound: 'relay-eu' },
};
it('renames an outbound and its exact selectors, fallback, routes, resources and nested dial-through references', () => {
  const view = remoteView(JSON.stringify(outboundConfig));
  const next = replaceNodeSettings(view, 'native-out-0', {
    ...(nodeSettings(view, 'native-out-0')!.value as object),
    tag: 'new-relay',
  });
  const expected = JSON.parse(JSON.stringify(outboundConfig).replaceAll('relay-eu', 'new-relay'));
  expect(next.original).toEqual(expected);
  expect(compileRemote(next, createUserWorkspace(outboundConfig, emptyLibrary())).config).toEqual(
    expected,
  );
  expect(view.original).toEqual(outboundConfig);
});
it('renames policy group references independently from outbound tags and selector prefixes', () => {
  const view = remoteView(JSON.stringify(outboundConfig));
  const next = replaceNodeSettings(view, 'native-balancer-0', {
    ...(nodeSettings(view, 'native-balancer-0')!.value as object),
    tag: 'new-group',
  });
  expect(next.original).toEqual({
    ...outboundConfig,
    routing: {
      ...outboundConfig.routing,
      balancers: [{ ...outboundConfig.routing.balancers[0], tag: 'new-group' }],
      rules: [
        outboundConfig.routing.rules[0],
        { ...outboundConfig.routing.rules[1], balancerTag: 'new-group' },
      ],
    },
  });
});
it('refuses ambiguous prefix membership changes and duplicate outbound tags without mutating the draft', () => {
  const source = { ...outboundConfig, observatory: { subjectSelector: ['relay-'] } };
  const view = remoteView(JSON.stringify(source)),
    value = nodeSettings(view, 'native-out-0')!.value as object;
  expect(() =>
    replaceNodeSettings(view, 'native-out-0', { ...value, tag: 'different-prefix' }),
  ).toThrow('prefix membership');
  expect(() => replaceNodeSettings(view, 'native-out-0', { ...value, tag: 'chained' })).toThrow(
    'already uses',
  );
  expect(view.original).toEqual(source);
  expect(
    replaceNodeSettings(view, 'native-out-0', { ...value, tag: 'relay-new' }).original.observatory,
  ).toEqual(source.observatory);
});
it('keeps original reference capitalization while renaming a destination', () => {
  const source = {
    Outbounds: [{ Tag: 'direct', Protocol: 'freedom' }],
    Routing: { Rules: [{ Domain: ['example.org'], OutboundTag: 'direct' }] },
  };
  const view = remoteView(JSON.stringify(source));
  expect(
    replaceNodeSettings(view, 'native-out-0', { Tag: 'wan', Protocol: 'freedom' }).original,
  ).toEqual({
    Outbounds: [{ Tag: 'wan', Protocol: 'freedom' }],
    Routing: { Rules: [{ Domain: ['example.org'], OutboundTag: 'wan' }] },
  });
});

const dnsTagsConfig = {
  inbounds: [{ tag: 'client', protocol: 'mixed', port: 10808 }],
  outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  dns: { tag: 'dns-global', servers: [{ address: '8.8.8.8', tag: 'dns-server' }] },
  routing: {
    rules: [
      { inboundTag: ['dns-global', 'dns-server'], outboundTag: 'direct' },
      { inboundTag: 'dns-global', outboundTag: 'direct' },
    ],
  },
};
it.each(['native-dns', 'native-resolver-0'])(
  'keeps DNS query routing when renaming the source tag in %s',
  (id) => {
    const view = remoteView(JSON.stringify(dnsTagsConfig));
    const oldTag = id === 'native-dns' ? 'dns-global' : 'dns-server';
    const value = nodeSettings(view, id)!.value as object;
    const next = replaceNodeSettings(view, id, { ...value, tag: 'renamed-dns' });
    const expected = JSON.parse(JSON.stringify(dnsTagsConfig).replaceAll(oldTag, 'renamed-dns'));
    expect(compileRemote(next, createUserWorkspace(next.original, emptyLibrary())).config).toEqual(
      expected,
    );
    expect(view.original).toEqual(dnsTagsConfig);
  },
);
it('preserves other sources sharing a DNS tag and rejects merges into another source tag', () => {
  const source = structuredClone(dnsTagsConfig);
  source.dns.servers[0].tag = 'dns-global';
  const view = remoteView(JSON.stringify(source));
  const value = nodeSettings(view, 'native-dns')!.value as object;
  const next = replaceNodeSettings(view, 'native-dns', { ...value, tag: 'renamed-dns' });
  expect((next.original.routing as typeof source.routing).rules[1].inboundTag).toEqual([
    'dns-global',
    'renamed-dns',
  ]);
  expect(() => replaceNodeSettings(view, 'native-dns', { ...value, tag: 'client' })).toThrow(
    'already uses',
  );
  expect(() => replaceNodeSettings(view, 'native-dns', { ...value, tag: '' })).toThrow(
    'used by routing',
  );
});

it('renames server tags in the DNS handler editor without treating removals or reordering as renames', () => {
  const source = structuredClone(dnsTagsConfig);
  source.dns.servers.push({ address: '1.1.1.1', tag: 'dns-other' });
  const view = remoteView(JSON.stringify(source));
  const value = nodeSettings(view, 'native-dns')!.value as typeof source.dns;
  const renamed = replaceNodeSettings(view, 'native-dns', {
    ...value,
    servers: [{ ...value.servers[0], tag: 'renamed-server' }, value.servers[1]],
  });
  expect((renamed.original.routing as typeof source.routing).rules[0].inboundTag).toEqual([
    'dns-global',
    'renamed-server',
  ]);
  const reordered = replaceNodeSettings(view, 'native-dns', {
    ...value,
    servers: [...value.servers].reverse(),
  });
  expect(reordered.original.routing).toEqual(source.routing);
  const removed = replaceNodeSettings(view, 'native-dns', {
    ...value,
    servers: [value.servers[1]],
  });
  expect(removed.original.routing).toEqual(source.routing);
});

it('can remove a tagged DNS server when another tag uses the same address', () => {
  const source = structuredClone(dnsTagsConfig);
  source.dns.servers.push({ ...source.dns.servers[0], tag: 'same-address' });
  const view = remoteView(JSON.stringify(source));
  const value = nodeSettings(view, 'native-dns')!.value as typeof source.dns;
  const next = replaceNodeSettings(view, 'native-dns', { ...value, servers: [value.servers[1]] });
  expect(next.original.routing).toEqual(source.routing);
});
