import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capture } from './capture.js';

test('background checkpoints survive suspension, filter closed tabs, and authorize only the popup', async () => {
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      listeners[name] = fn;
    },
  });
  let saved = [];
  let failStorage = false;
  globalThis.chrome = {
    storage: {
      session: {
        async get() {
          return { pages: structuredClone(saved) };
        },
        async set(value) {
          if (failStorage) throw new Error('quota');
          saved = structuredClone(value.pages);
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 2 }];
      },
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
    },
    webRequest: {
      onBeforeRequest: event('before'),
      onCompleted: event('completed'),
      onErrorOccurred: event('error'),
    },
    runtime: {
      id: 'companion',
      getURL: (path) => `chrome-extension://companion/${path}`,
      onMessage: event('message'),
    },
  };
  const sender = {
    id: 'companion',
    url: 'chrome-extension://companion/popup.html',
    tab: { id: 99 },
  };
  const snapshot = (tabId) =>
    new Promise((resolve) => listeners.message({ type: 'snapshot', tabId }, sender, resolve));
  const request = (tabId, id, host) => ({
    tabId,
    requestId: id,
    url: `https://${host}/private?token=secret`,
    type: 'main_frame',
    timeStamp: 1000,
  });
  const seed = new Capture();
  seed.before(request(1, 'closed', 'closed.test'));
  seed.before(request(2, 'nav', 'kept.test'));
  saved = [...seed.pages.values()];
  await import('./background.js?first');
  assert.equal((await snapshot(1)).page, null);
  assert.equal((await snapshot(2)).page.host, 'kept.test');
  assert.equal(
    listeners.message({ type: 'snapshot', tabId: 2 }, { ...sender, id: 'other' }, () =>
      assert.fail(),
    ),
    false,
  );
  assert.equal(
    listeners.message(
      { type: 'snapshot', tabId: 2 },
      { ...sender, url: 'https://page.test/' },
      () => assert.fail(),
    ),
    false,
  );
  listeners.before(request(2, 'new', 'next.test'));
  listeners.error(request(2, 'nav', 'kept.test')); // Completion from the retired page.
  assert.equal((await snapshot(2)).page.domains[0].errors, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await import('./background.js?resumed');
  assert.equal((await snapshot(2)).page.host, 'next.test');
  listeners.removed(2);
  assert.equal((await snapshot(2)).page, null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(saved, []);
  failStorage = true;
  listeners.before(request(2, 'again', 'active.test'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match((await snapshot(2)).storageError, /Session storage is unavailable/);
  delete globalThis.chrome;
});
