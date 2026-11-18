import { expect, it } from 'vitest';
import { createRemoteNode } from './remoteCreation';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { replaceNodeSettings } from './nodeSettings';

it('adds a resolver to a fresh graph and exports the selected address', () => {
  const { view, id } = createRemoteNode(remoteView('{}'), 'resolver');
  const edited = replaceNodeSettings(view, id, { address: '192.0.2.53' });
  const result = compileRemote(edited, createUserWorkspace(view.original, emptyLibrary()));
  expect(result.errors).toEqual([]);
  expect(result.config.dns).toMatchObject({ servers: [{ address: '192.0.2.53' }] });
});

it('creates lowest-latency groups with a Block fallback and preserves existing server observation', () => {
  const base = remoteView(
    JSON.stringify({
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'blocked', protocol: 'blackhole' },
      ],
      observatory: { subjectSelector: ['relay-'], probeURL: 'https://example.test/probe' },
    }),
  );
  const result = createRemoteNode(base, 'balancer');
  expect(result.view.normalized.outbounds).toEqual(base.normalized.outbounds);
  expect(result.view.normalized.observatory).toEqual(base.normalized.observatory);
  expect(result.view.normalized.routing).toMatchObject({
    balancers: [{ strategy: { type: 'leastPing' }, fallbackTag: 'blocked' }],
  });
  const empty = createRemoteNode(remoteView('{}'), 'balancer').view.normalized;
  expect(empty.outbounds).toMatchObject([{ protocol: 'blackhole' }]);
  expect(empty.observatory).toMatchObject({ subjectSelector: [''] });
  expect(base.normalized).not.toHaveProperty('routing');
});

it('opens existing singleton nodes without replacing their settings', () => {
  const view = remoteView(
    JSON.stringify({
      dns: { servers: ['localhost'] },
      observatory: { subjectSelector: ['relay'], probeInterval: '1m' },
      routing: { domainStrategy: 'IPIfNonMatch' },
    }),
  );
  for (const entry of ['dns', 'observatory', 'routing']) {
    const result = createRemoteNode(view, entry);
    expect(result.view.normalized).toEqual(view.normalized);
  }
});

it('avoids port ranges and destination tags already used by policy groups', () => {
  const view = remoteView(
    JSON.stringify({
      inbounds: [{ protocol: 'mixed', port: '10800-10820' }],
      routing: { balancers: [{ tag: 'direct', selector: [], strategy: { type: 'random' } }] },
    }),
  );
  expect(createRemoteNode(view, 'inbound:vless').view.normalized.inbounds).toMatchObject([
    {},
    { port: 10821 },
  ]);
  expect(createRemoteNode(view, 'outbound:freedom').view.normalized.outbounds).toMatchObject([
    { tag: 'direct-2' },
  ]);
});
