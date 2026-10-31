import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capture, hostname, MAX_HOSTS } from './capture.js';

const request = (tabId, requestId, url, type = 'script', timeStamp = 1000) => ({
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
  capture.before(request(1, 'late', 'https://cdn.test/'));
  capture.before(request(1, 'nav2', 'https://next.test/', 'main_frame', 2000));
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
    restored.before(request(i, String(i), `https://tab${i}.test/`, 'main_frame', i + 2000));
  assert.ok(restored.pages.size <= 48);
});
