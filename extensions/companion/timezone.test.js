import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimezoneController } from './timezone.js';

function fixture(
  main = async () => ({
    timezone: 'Asia/Tokyo',
    ip: '203.0.113.1',
    name: 'Main',
    outbound: 'main',
    revision: 7,
  }),
) {
  const events = {},
    commands = [],
    saved = {};
  const api = {
    storage: {
      session: {
        async get() {
          return saved;
        },
        async set(value) {
          Object.assign(saved, structuredClone(value));
        },
      },
    },
    tabs: {
      async get(id) {
        return { id, url: 'https://example.test/', incognito: false };
      },
      async query() {
        return [1, 2].map((id) => ({ id, url: 'https://example.test/', incognito: false }));
      },
      async reload(id) {
        commands.push(['reload', id]);
      },
      onRemoved: {
        addListener(fn) {
          events.removed = fn;
        },
      },
    },
    debugger: {
      onEvent: {
        addListener(fn) {
          events.event = fn;
        },
      },
      onDetach: {
        addListener(fn) {
          events.detach = fn;
        },
      },
      async attach(source) {
        commands.push(['attach', source]);
      },
      async detach(source) {
        commands.push(['detach', source]);
        events.detach(source, 'canceled_by_user');
      },
      async sendCommand(source, method, params) {
        commands.push([method, source, params]);
      },
    },
  };
  return { controller: new TimezoneController(api, main), api, events, commands, saved };
}
test('timezone is opt-in, validates before attachment, and detaches when disabled', async () => {
  const f = fixture();
  assert.equal((await f.controller.read()).mode, 'off');
  assert.deepEqual(f.commands, []);
  await assert.rejects(f.controller.apply(1, 'manual', 'Not/AZone'));
  assert.deepEqual(f.commands, []);
  await f.controller.apply(1, 'manual', 'Europe/Berlin');
  assert.equal((await f.controller.read()).zone, 'Europe/Berlin');
  assert.ok(
    f.commands.some(
      ([method, , params]) =>
        method === 'Emulation.setTimezoneOverride' && params.timezoneId === 'Europe/Berlin',
    ),
  );
  await f.controller.apply(1, 'off', '');
  assert.equal((await f.controller.read()).mode, 'off');
  assert.ok(f.commands.some(([method]) => method === 'detach'));
});
test('Main uses only the native reply and a failed lookup leaves the previous override intact', async () => {
  let failed = false;
  const f = fixture(async () => {
    if (failed) throw new Error('offline');
    return { timezone: 'Asia/Tokyo', ip: '203.0.113.1', name: 'Main', outbound: 'm', revision: 4 };
  });
  await f.controller.apply(1, 'main', 'Europe/Berlin');
  assert.equal((await f.controller.read()).zone, 'Asia/Tokyo');
  failed = true;
  await assert.rejects(f.controller.apply(1, 'main', ''));
  assert.equal((await f.controller.read()).zone, 'Asia/Tokyo');
  f.events.detach({ tabId: 1 }, 'canceled_by_user');
  assert.equal((await f.controller.read()).mode, 'off');
  assert.match((await f.controller.read()).error, /Enable it again/);
});
test('failed frame or worker setup always resumes it and reports incomplete coverage', async () => {
  const f = fixture();
  await f.controller.apply(1, 'manual', 'UTC');
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Emulation.setTimezoneOverride') throw new Error('unsupported child');
    await send(source, method, params);
  };
  await f.controller.child({ tabId: 1 }, { sessionId: 'worker' });
  assert.match((await f.controller.read()).error, /Full timezone coverage/);
  assert.ok(
    f.commands.some(
      ([method, source]) =>
        method === 'Runtime.runIfWaitingForDebugger' && source.sessionId === 'worker',
    ),
  );
});

test('service-worker startup resumes before emulation and a stalled child still resumes', async (t) => {
  const f = fixture();
  await f.controller.apply(1, 'manual', 'UTC');
  f.commands.length = 0;
  await f.controller.child(
    { tabId: 1 },
    { sessionId: 'sw', targetInfo: { type: 'service_worker' } },
  );
  assert.equal(f.commands[0][0], 'Runtime.runIfWaitingForDebugger');
  assert.equal(f.commands[1][0], 'Emulation.setTimezoneOverride');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (source, method, params) =>
    method === 'Emulation.setTimezoneOverride'
      ? new Promise(() => {})
      : send(source, method, params);
  const pending = f.controller.child({ tabId: 1 }, { sessionId: 'stalled' });
  t.mock.timers.tick(2001);
  await pending;
  assert.match((await f.controller.read()).error, /Full timezone coverage/);
  assert.ok(
    f.commands.some(
      ([method, source]) =>
        method === 'Runtime.runIfWaitingForDebugger' && source.sessionId === 'stalled',
    ),
  );
});

test('one browser zone covers other/new tabs and browser cancellation detaches all of them', async () => {
  const f = fixture();
  await f.controller.apply(1, 'manual', 'Asia/Tokyo');
  assert.deepEqual([...f.controller.attached], [1, 2]);
  f.controller.newTab(3, 'https://new.example.test/');
  await f.controller.lane;
  assert.deepEqual([...f.controller.attached], [1, 2, 3]);
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) => {
    if (id === 99) throw new Error('Tab already closed');
    return get(id);
  };
  f.controller.newTab(99, 'https://closed.example.test/');
  await f.controller.lane;
  assert.equal((await f.controller.read()).mode, 'manual');
  f.events.detach({ tabId: 2 }, 'target_closed');
  assert.equal((await f.controller.read()).mode, 'manual');
  assert.deepEqual([...f.controller.attached], [1, 3]);
  f.events.detach({ tabId: 1 }, 'canceled_by_user');
  await f.controller.writes;
  assert.equal((await f.controller.read()).mode, 'off');
  assert.deepEqual([...f.controller.attached], []);
  assert.ok(f.commands.some(([method, source]) => method === 'detach' && source.tabId === 3));
});
