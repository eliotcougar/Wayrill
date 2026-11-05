import { expect, it } from 'vitest';
import { createRemoteNode, nodeLibrary } from './remoteCreation';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';

it.each(nodeLibrary.filter((entry) => entry.id !== 'users'))(
  'creates $id from an empty installed core config',
  (entry) => {
    const result = createRemoteNode(remoteView('{}'), entry.id);
    expect(result.view.nodes.some((node) => node.id === result.id)).toBe(true);
    const compiled = compileRemote(
      result.view,
      createUserWorkspace(result.view.original, emptyLibrary()),
    );
    expect(compiled.errors).toEqual([]);
  },
);

it('allocates independent tags and unused listen ports', () => {
  let view = remoteView('{}');
  for (let i = 0; i < 3; i++) view = createRemoteNode(view, 'inbound:vless').view;
  expect(view.normalized.inbounds).toMatchObject([
    { tag: 'vless', port: 10808 },
    { tag: 'vless-2', port: 10809 },
    { tag: 'vless-3', port: 10810 },
  ]);
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
