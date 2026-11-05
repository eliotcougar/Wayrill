import { describe, expect, it } from 'vitest';
import { demoConfig, sharedUsersExample } from './demo';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { emptyLayout, restoreRemoteDocument, saveRemoteDocument } from './remoteDocument';

describe('server companion documents', () => {
  it.each([demoConfig, sharedUsersExample])(
    'restores edited positions, viewport and user-set identity on a fresh connection',
    (config) => {
      const source = JSON.stringify(config);
      const view = remoteView(source);
      const users = createUserWorkspace(view.original, emptyLibrary());
      const layout = {
        positions: { 'native-in-0': { x: -240, y: 775 }, 'native-routing': { x: 900, y: -80 } },
        shown: ['native-out-0'],
        viewport: { x: 53, y: -96, zoom: 0.7 },
      };
      const saved = saveRemoteDocument(view, users, layout);
      const restored = restoreRemoteDocument(source, saved);
      expect(restored.layout).toEqual(layout);
      expect(restored.users).toEqual(users);
      expect(compileRemote(restored.view, restored.users).config).toEqual(config);
      expect(saveRemoteDocument(restored.view, restored.users, restored.layout)).toBe(saved);
      // A second layout-only save must supersede the first on the next connection.
      restored.layout.positions['native-in-0'] = { x: 642, y: 321 };
      const reconnected = restoreRemoteDocument(
        source,
        saveRemoteDocument(restored.view, restored.users, restored.layout),
      );
      expect(reconnected.layout.positions['native-in-0']).toEqual({ x: 642, y: 321 });
    },
  );

  it('rejects a graph that no longer compiles to the actual server config', () => {
    const source = JSON.stringify(demoConfig);
    const view = remoteView(source);
    const saved = saveRemoteDocument(
      view,
      createUserWorkspace(view.original, emptyLibrary()),
      emptyLayout(),
    );
    const changed = { ...demoConfig, log: { loglevel: 'debug' } };
    expect(() => restoreRemoteDocument(JSON.stringify(changed), saved)).toThrow('does not compile');
  });

  it('compares JSON structurally, keeping rule and outbound order significant', () => {
    const source = JSON.stringify(demoConfig);
    const view = remoteView(source);
    const saved = saveRemoteDocument(
      view,
      createUserWorkspace(view.original, emptyLibrary()),
      emptyLayout(),
    );
    expect(() => restoreRemoteDocument(source, '\ufeff' + saved)).not.toThrow();
    const reordered = Object.fromEntries(Object.entries(demoConfig).reverse());
    expect(() => restoreRemoteDocument(JSON.stringify(reordered, null, 4), saved)).not.toThrow();
    expect(() =>
      restoreRemoteDocument(
        JSON.stringify({ ...demoConfig, outbounds: [...demoConfig.outbounds].reverse() }),
        saved,
      ),
    ).toThrow('does not compile');
  });

  it('rejects unsupported documents, corrupt graphs, bad bindings and invalid coordinates', () => {
    const source = JSON.stringify(sharedUsersExample);
    const view = remoteView(source);
    const saved = saveRemoteDocument(
      view,
      createUserWorkspace(view.original, emptyLibrary()),
      emptyLayout(),
    );
    expect(() => restoreRemoteDocument(source, '{"password":"private-test-value" invalid')).toThrow(
      /^Invalid Xray JSON near character \d+\./,
    );
    for (const change of [
      (d: Record<string, unknown>) => {
        d.version = 999;
      },
      (d: Record<string, unknown>) => {
        d.graph = {};
      },
      (d: Record<string, unknown>) => {
        d.users = { sets: [], bindings: [{ set: 'missing', inbound: 0 }] };
      },
      (d: Record<string, unknown>) => {
        d.layout = { positions: { node: { x: 'bad', y: 0 } }, shown: [] };
      },
      (d: Record<string, unknown>) => {
        d.layout = { positions: {}, shown: [], viewport: { x: 0, y: 0, zoom: 200 } };
      },
    ]) {
      const document = JSON.parse(saved) as Record<string, unknown>;
      change(document);
      expect(() => restoreRemoteDocument(source, JSON.stringify(document))).toThrow();
    }
  });
});
