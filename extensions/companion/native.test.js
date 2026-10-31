import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient } from './native.js';

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
  ports[1].message({ version: 1, id: 2, ok: true, result: { hosts: [] } });
  assert.deepEqual(await next, { hosts: [] });
  const failed = client.routes([]);
  ports[1].message({ version: 1, id: 3, ok: false, error: { message: 'Service unavailable' } });
  await assert.rejects(failed, /Service unavailable/);
  client.close();
  delete globalThis.chrome;
});
