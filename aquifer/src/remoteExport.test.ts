import { expect, it } from 'vitest';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { emptyLayout, restoreRemoteDocument, saveRemoteDocument } from './remoteDocument';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { inspectXrayCapitalization } from './graph/xrayConfigNames';

it('exports canonical Xray field names while preserving values and dictionary keys', () => {
  const source = JSON.stringify({
    Log: { LogLevel: 'warning' },
    Inbounds: [{ Protocol: 'mixed', Listen: '127.0.0.1', Port: 10808, Settings: {} }],
    Outbounds: [{ Protocol: 'freedom', Tag: 'Direct' }],
    DNS: { Hosts: { 'MiXeD.Example': '127.0.0.1' }, QueryStrategy: 'UseIP' },
    Routing: { Rules: [{ Type: 'field', Domain: ['domain:Case.Example'], OutboundTag: 'Direct' }] },
  });
  const view = remoteView(source);
  const users = createUserWorkspace(view.original, emptyLibrary());
  const result = compileRemote(view, users);
  expect(result.errors).toEqual([]);
  expect(result.config).toEqual(view.normalized);
  expect(inspectXrayCapitalization(JSON.stringify(result.config))).toEqual([]);
  expect(result.config.dns).toEqual({
    hosts: { 'MiXeD.Example': '127.0.0.1' },
    queryStrategy: 'UseIP',
  });
  expect(view.original.Log).toEqual({ LogLevel: 'warning' });
});

it('verifies a companion against both original capitalization and the saved canonical config', () => {
  const source = '{"Outbounds":[{"Protocol":"freedom","Tag":"Direct"}]}';
  const view = remoteView(source);
  const users = createUserWorkspace(view.original, emptyLibrary());
  const layout = { ...emptyLayout(), positions: { 'native-out-0': { x: 70, y: 110 } } };
  const document = saveRemoteDocument(view, users, layout);
  const canonical = JSON.stringify(compileRemote(view, users).config);
  for (const text of [source, canonical]) {
    expect(restoreRemoteDocument(text, document).layout).toEqual(layout);
  }
});

it.each(['cycle', 'missing', 'untagged'] as const)(
  'blocks unsafe %s outbound dependencies before export',
  (kind) => {
    const config = {
      outbounds:
        kind === 'untagged'
          ? [{ protocol: 'freedom', streamSettings: { sockopt: { dialerProxy: 'missing' } } }]
          : [
              {
                tag: 'a',
                protocol: 'freedom',
                streamSettings: { sockopt: { dialerProxy: kind === 'cycle' ? 'b' : 'missing' } },
              },
              { tag: 'b', protocol: 'freedom', proxySettings: { tag: 'a' } },
            ],
    };
    const view = remoteView(JSON.stringify(config));
    const result = compileRemote(view, createUserWorkspace(view.original, emptyLibrary()));
    expect(result.errors.join(' ')).toMatch(kind === 'cycle' ? /outbound loop/i : /not defined/i);
  },
);

it('recognizes core-generated metrics and reverse portal handlers without inventing outbounds', () => {
  const config = {
    metrics: { tag: 'metrics-handler', listen: '127.0.0.1:10085' },
    reverse: { portals: [{ tag: 'portal-handler', domain: 'reverse.example' }] },
    outbounds: ['metrics-handler', 'portal-handler'].map((target, index) => ({
      tag: `hop-${index}`,
      protocol: 'freedom',
      proxySettings: { tag: target },
    })),
  };
  const view = remoteView(JSON.stringify(config));
  const result = compileRemote(view, createUserWorkspace(view.original, emptyLibrary()));
  expect(result.errors).toEqual([]);
  expect(result.config).toEqual(config);
});
