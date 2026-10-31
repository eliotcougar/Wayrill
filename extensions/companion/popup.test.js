import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('current-tab popup retains last known Block through empty lookups and failures, and resets on navigation', async () => {
  const dom = new JSDOM(readFileSync(new URL('./popup.html', import.meta.url), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  let host = 'page.test';
  let failed = false;
  let empty = false;
  let blocked = false;
  let instanceId = 'instance-a';
  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 1, url: `https://${host}/`, title: 'Current page' }];
      },
    },
    runtime: {
      id: 'extension-id',
      async sendMessage() {
        return {
          page: {
            startedAt: host === 'page.test' ? 1 : 2,
            domains: [
              {
                host,
                count: 2,
                types: ['main_frame', 'script'],
                firstSeen: 1,
                lastSeen: 2,
                cached: 0,
                errors: 0,
              },
            ],
          },
          storageError: '',
        };
      },
      connectNative() {
        let receive;
        return {
          onMessage: {
            addListener(fn) {
              receive = fn;
            },
          },
          onDisconnect: { addListener() {} },
          disconnect() {},
          postMessage(message) {
            queueMicrotask(() =>
              receive(
                failed
                  ? {
                      version: 1,
                      id: message.id,
                      ok: false,
                      error: { message: 'Service unavailable' },
                    }
                  : {
                      version: 1,
                      id: message.id,
                      ok: true,
                      result: {
                        state: 'collecting',
                        instanceId,
                        generation: 1,
                        revision: 4,
                        hosts: [
                          {
                            host: 'page.test',
                            matches: empty
                              ? []
                              : [
                                  {
                                    outbound: blocked
                                      ? 'Renamed deny output'
                                      : '<img src=x onerror=alert(1)>',
                                    action: blocked ? 'block' : 'route',
                                    generation: 1,
                                    revision: 4,
                                    transport: 'tcp',
                                    port: 443,
                                    timestampMs: 1,
                                    path: [{ rule: 'Web', output: 'Work' }],
                                    source: 'Xray',
                                  },
                                ],
                          },
                        ],
                      },
                    },
              ),
            );
          },
        };
      },
    },
  };
  const text = (id) => document.getElementById(id).textContent;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await import('./popup.js');
    await settle();
    assert.equal(text('page-host'), 'page.test');
    assert.equal(document.querySelectorAll('select').length, 0);
    assert.match(text('domains'), /Last known: <img src=x onerror=alert\(1\)>/);
    assert.equal(document.querySelectorAll('#domains img').length, 0);
    const search = document.getElementById('search');
    search.value = 'missing';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(document.querySelectorAll('.domain').length, 0);
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    document.getElementById('setup-button').click();
    assert.equal(document.getElementById('setup').hidden, false);
    assert.equal(text('extension-id'), 'extension-id');
    blocked = true;
    document.getElementById('refresh').click();
    await settle();
    assert.match(text('domains'), /Last known: Blocked \(Renamed deny output\)/);
    assert.ok(!text('domains').includes('Retained observation;'));
    empty = true;
    // A service restart can reuse both generation and applied revision.
    instanceId = 'instance-b';
    document.getElementById('refresh').click();
    await settle();
    assert.match(text('domains'), /Last known: Blocked \(Renamed deny output\)/);
    assert.match(text('domains'), /Retained observation; the current route has not been observed/);
    failed = true;
    document.getElementById('refresh').click();
    await settle();
    assert.match(text('domains'), /Last known: Blocked \(Renamed deny output\)/);
    assert.equal(text('connection-error'), 'Service unavailable');
    failed = false;
    host = 'next.test';
    document.getElementById('refresh').click();
    await settle();
    assert.equal(text('page-host'), 'next.test');
    assert.ok(!text('domains').includes('page.test'));
    assert.match(text('domains'), /No route observed yet/);
  } finally {
    window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
    delete globalThis.chrome;
    delete globalThis.document;
    delete globalThis.window;
  }
});
