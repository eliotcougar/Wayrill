import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient, reloadUpdatedBundle } from './native.js';

test('native connection correlates responses, fails closed on disconnect and reconnects', async () => {
  const ports = [];
  globalThis.chrome = {
    runtime: {
      connectNative(name) {
        assert.equal(name, 'com.wayrill.companion');
        const port = {
          onMessage: {
            addListener(fn) {
              port.message = fn;
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.disconnected = fn;
            },
          },
          postMessage(value) {
            port.sent = value;
          },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  const client = new NativeClient();
  const first = client.routes(['example.test']);
  const port = ports[0];
  assert.deepEqual(port.sent, {
    version: 1,
    id: 1,
    method: 'routes',
    params: { hosts: ['example.test'] },
  });
  port.message({ version: 1, id: 999, ok: true, result: { hosts: [] } });
  port.disconnected();
  await assert.rejects(first, /disconnected/);
  const next = client.routes(['example.test']);
  port.disconnected(); // A late event from the previous connection must not kill the new request.
  ports[1].message({
    version: 1,
    id: 2,
    ok: true,
    extensionVersion: '0.2.1',
    result: { hosts: [] },
  });
  assert.deepEqual(await next, { hosts: [], extensionVersion: '0.2.1' });
  const failed = client.routes([]);
  ports[1].message({ version: 1, id: 3, ok: false, error: { message: 'Service unavailable' } });
  await assert.rejects(failed, /Service unavailable/);
  client.close();
  delete globalThis.chrome;
});

test('an unpacked copy reloads only when the bridge and its on-disk files match', async () => {
  const originalFetch = globalThis.fetch;
  let reloads = 0;
  let installed = { version: '0.2.0', key: 'bundled-key' };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.2.0', key: 'bundled-key' }),
      getURL: (path) => `chrome-extension://bundled-id/${path}`,
      reload() {
        reloads++;
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'chrome-extension://bundled-id/manifest.json');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => installed };
  };
  try {
    assert.equal(await reloadUpdatedBundle(undefined), false); // Older bridge.
    assert.equal(await reloadUpdatedBundle('0.2.0'), false);
    assert.equal(await reloadUpdatedBundle('0.2.1'), false); // Files not updated yet.
    installed = { version: '0.2.1', key: 'different-copy' };
    assert.equal(await reloadUpdatedBundle('0.2.1'), false);
    globalThis.fetch = async () => {
      throw new Error('package unavailable');
    };
    assert.equal(await reloadUpdatedBundle('0.2.1'), false);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: '0.2.1', key: 'bundled-key' }),
    });
    assert.equal(await reloadUpdatedBundle('0.2.1'), true);
    assert.equal(reloads, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
  }
});
