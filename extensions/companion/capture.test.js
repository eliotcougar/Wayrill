import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capture, hostname, MAX_HOSTS } from './capture.js';

const now = Date.now();
const request = (tabId, requestId, url, type = 'script', timeStamp = now + 1000) => ({
  tabId,
  requestId,
  url,
  type,
  timeStamp,
});

test('per-page capture keeps frames, redirects and WebSockets, and discards private URL data', () => {
  const capture = new Capture();
  capture.before(request(1, 'nav', 'https://old.test/private?token=secret', 'main_frame'));
  capture.before(request(1, 'nav', 'https://page.test/private', 'main_frame'));
  capture.before(request(1, 'a', 'https://cdn.test/a.js?key=secret'));
  capture.before(request(1, 'b', 'https://frame.test/', 'sub_frame'));
  capture.before(request(1, 'c', 'wss://socket.test/ws', 'websocket'));
  capture.before(request(2, 'd', 'https://unrelated.test/', 'main_frame'));
  capture.finish({ ...request(1, 'a', 'https://cdn.test/a.js'), fromCache: true }, false);
  const snapshot = capture.snapshot(1);
  assert.equal(snapshot.host, 'page.test');
  assert.deepEqual(
    snapshot.domains.map((row) => row.host),
    ['old.test', 'page.test', 'cdn.test', 'frame.test', 'socket.test'],
  );
  assert.equal(snapshot.domains[2].cached, 1);
  assert.equal(snapshot.pending, undefined);
  assert.ok(!JSON.stringify(capture.pages.get(1)).match(/secret|private|token|a\.js|unrelated/));
});

test('navigation resets the page, and late completion cannot count against a new page', () => {
  const capture = new Capture();
  capture.before(request(1, 'nav1', 'https://first.test/', 'main_frame'));
  capture.committed({
    tabId: 1,
    frameId: 0,
    documentId: 'first',
    url: 'https://first.test/',
    timeStamp: now + 1001,
  });
  capture.before(request(1, 'late', 'https://cdn.test/'));
  capture.before(request(1, 'nav2', 'https://next.test/', 'main_frame', now + 2000));
  capture.committed({
    tabId: 1,
    frameId: 0,
    documentId: 'next',
    url: 'https://next.test/',
    timeStamp: now + 2001,
  });
  capture.before(request(1, 'new', 'https://cdn.test/'));
  capture.finish(request(1, 'late', 'https://cdn.test/'), true);
  capture.finish(request(1, 'new', 'https://cdn.test/'), true);
  assert.deepEqual(
    capture.snapshot(1).domains.map((row) => [row.host, row.errors]),
    [
      ['next.test', 0],
      ['cdn.test', 1],
    ],
  );
  // Distinct cached documents can have the same hostname.
  capture.committed({
    tabId: 1,
    frameId: 0,
    documentId: 'older-next',
    url: 'https://next.test/older',
    timeStamp: now + 2500,
  });
  assert.deepEqual(capture.snapshot(1).domains, []);
  // Back/forward-cache restores the old document without another request.
  capture.committed({
    tabId: 1,
    frameId: 0,
    documentId: 'first',
    url: 'https://first.test/',
    timeStamp: now + 3000,
  });
  assert.equal(capture.snapshot(1).host, 'first.test');
  assert.deepEqual(capture.snapshot(1).domains, []);
  capture.before(request(1, 'fresh', 'https://cdn.test/'));
  capture.committed({
    tabId: 1,
    frameId: 1,
    documentId: 'frame',
    url: 'https://frame.test/',
    timeStamp: now + 3001,
  });
  assert.equal(capture.snapshot(1).domains[0].host, 'cdn.test');
  capture.committed({
    tabId: 1,
    frameId: 0,
    documentId: 'internal',
    url: 'chrome://newtab/',
    timeStamp: now + 4000,
  });
  assert.equal(capture.snapshot(1), null);
});

test('capture is bounded, survives worker suspension, and excludes incognito and browser traffic', () => {
  const capture = new Capture();
  capture.before({ ...request(1, 'private', 'https://secret.test/'), incognito: true });
  capture.before(request(-1, 'background', 'https://secret.test/'));
  capture.before(request(1, 'internal', 'chrome://extensions/'));
  assert.equal(capture.pages.size, 0);
  for (let i = 0; i < MAX_HOSTS + 9; i++)
    capture.before(request(1, String(i), `https://host${i}.test/`));
  const restored = new Capture(JSON.parse(JSON.stringify([...capture.pages.values()])));
  assert.equal(restored.snapshot(1).domains.length, MAX_HOSTS);
  assert.equal(restored.snapshot(1).dropped, 9);
  restored.before(request(1, 'again', 'https://host0.test/'));
  assert.equal(restored.snapshot(1).domains[0].count, 2);
  assert.equal(hostname('https://[2001:db8::1]/path'), '2001:db8::1');
  assert.equal(hostname('https://日本語.jp/'), 'xn--wgv71a119e.jp');
  for (let i = 2; i < 100; i++)
    restored.before(request(i, String(i), `https://tab${i}.test/`, 'main_frame', now + i + 2000));
  assert.ok(restored.pages.size <= 48);
});

test('a long-lived tab frees old slots and ignores late completions for expired domains', () => {
  const capture = new Capture();
  for (let i = 0; i < MAX_HOSTS; i++)
    capture.before(request(1, String(i), `https://host${i}.test/`, 'script', now));
  const later = now + 60 * 60 * 1000 + 1;
  capture.before(request(1, 'recent', 'https://host0.test/', 'script', later));
  capture.finish(request(1, '0', 'https://host0.test/', 'script', later), true);
  assert.deepEqual(
    capture
      .snapshot(1, 0, later)
      .domains.map(({ host, count, errors }) => ({ host, count, errors })),
    [{ host: 'host0.test', count: 1, errors: 0 }],
  );
  capture.before(request(1, 'latest', 'https://host1.test/', 'script', later + 10));
  assert.deepEqual(
    capture.snapshot(1, later + 5, later + 11).domains.map(({ host }) => host),
    ['host1.test'],
  );
  assert.deepEqual(capture.snapshot(1, 0, later + 60 * 60 * 1000 + 11).domains, []);
});
