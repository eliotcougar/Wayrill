import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TimezoneController, timezoneMessage } from './timezone.js';

test('timezone channel completes independently of snapshot listeners and closes on disconnect', async () => {
  let receive,
    disconnect,
    closed = 0;
  const api = {
    runtime: {
      sendMessage() {
        throw new Error('Snapshot message path must not be used');
      },
      connect({ name }) {
        assert.equal(name, 'wayrill.timezone');
        return {
          onMessage: {
            addListener(fn) {
              receive = fn;
            },
          },
          onDisconnect: {
            addListener(fn) {
              disconnect = fn;
            },
          },
          postMessage(message) {
            assert.equal(message.type, 'timezone.get');
          },
          disconnect() {
            ++closed;
            disconnect();
          },
        };
      },
    },
  };
  const reply = timezoneMessage(api, { type: 'timezone.get' });
  receive({ result: { mode: 'off' } });
  assert.deepEqual(await reply, { result: { mode: 'off' } });
  assert.equal(closed, 1);
  const lost = timezoneMessage(api, { type: 'timezone.get' });
  disconnect();
  await assert.rejects(lost, /disconnected/);
  assert.equal(closed, 2);
});

function fixture() {
  const events = {},
    calls = [],
    reloads = [],
    local = {};
  let state = {
    supported: true,
    configured: false,
    mode: 'off',
    zone: '',
    revision: 0,
    systemZone: 'Europe/Moscow',
  };
  let observed = state.systemZone,
    notifyAfter = 0,
    notifications = 0,
    failLookup = false;
  const alarms = new Set();
  const api = {
    alarms: {
      async clear(name) {
        alarms.delete(name);
      },
      async create(name) {
        alarms.add(name);
      },
      onAlarm: {
        addListener(fn) {
          events.alarm = fn;
        },
      },
    },
    runtime: {
      onStartup: {
        addListener(fn) {
          events.startup = fn;
        },
      },
      onInstalled: {
        addListener(fn) {
          events.installed = fn;
        },
      },
    },
    storage: {
      local: {
        async get() {
          return structuredClone(local);
        },
        async remove(key) {
          delete local[key];
        },
      },
      session: { async remove() {} },
    },
    tabs: {
      async query() {
        return [
          { id: 1, url: 'https://example.org/' },
          { id: 2, url: 'chrome://settings/' },
        ];
      },
      async reload(id) {
        reloads.push(id);
      },
    },
  };
  const request = async (method, params) => {
    calls.push([method, structuredClone(params)]);
    if (method === 'timezone') {
      if (failLookup) throw new Error('Outbound unavailable');
      return { timezone: 'Asia/Tokyo', ip: '203.0.113.1', name: 'Selected' };
    }
    if (method === 'timezoneSet') {
      if (params.expectedRevision !== state.revision) throw new Error('Browser timezone changed.');
      state = {
        supported: state.supported,
        systemZone: state.systemZone,
        ...params.policy,
        configured: true,
        revision: state.revision + 1,
      };
    } else if (method === 'timezoneNotify') ++notifications;
    else if (method !== 'timezoneGet') throw new Error(`Unexpected native method ${method}`);
    if (notifications >= notifyAfter)
      observed = state.mode === 'off' ? state.systemZone : state.zone;
    return method === 'timezoneNotify' ? {} : structuredClone(state);
  };
  const controller = new TimezoneController(
    api,
    request,
    () => observed,
    async () => {},
  );
  return {
    controller,
    events,
    calls,
    reloads,
    local,
    alarms,
    external(policy) {
      state = { ...state, ...policy, configured: true, revision: state.revision + 1 };
    },
    state: () => state,
    delay: (n) => {
      notifyAfter = n;
      notifications = 0;
    },
    fail: () => {
      failLookup = true;
    },
  };
}
test('custom lookup failure preserves the existing native policy', async () => {
  const f = fixture();
  await f.controller.read();
  const selection = { groupId: 'provider', entryId: 'chain', version: 7 };
  await f.controller.apply('custom', '', selection, f.state().revision);
  assert.deepEqual(f.state().selection, selection);
  const previous = structuredClone(f.state());
  f.fail();
  await assert.rejects(
    f.controller.apply('custom', '', selection, f.state().revision),
    /Outbound unavailable/,
  );
  assert.deepEqual(f.state(), previous);
});
test('a refresh on the last allowed notification confirms the policy and reloads web tabs', async () => {
  const f = fixture();
  await f.controller.read();
  f.delay(12);
  const result = await f.controller.apply('manual', 'Asia/Tokyo', undefined, f.state().revision);
  assert.equal(result.nativeZone, 'Asia/Tokyo');
  assert.equal(result.error, undefined);
  assert.deepEqual(f.reloads, [1]);
});
test('the old debugger preference migrates once, without overriding a service-owned policy', async () => {
  const f = fixture();
  await f.controller.read();
  f.local.timezonePreference = { mode: 'manual', zone: 'Asia/Tokyo' };
  await f.controller.read();
  assert.equal(f.state().zone, 'Asia/Tokyo');
  f.local.timezonePreference = { mode: 'manual', zone: 'Europe/Berlin' };
  await f.controller.read();
  assert.equal(f.state().zone, 'Asia/Tokyo');
  assert.equal(f.local.timezonePreference, undefined);
});

test('an unconfirmed saved policy remains editable and can be turned off', async () => {
  const f = fixture();
  await f.controller.read();
  f.delay(100);
  assert.match(
    (await f.controller.apply('manual', 'Asia/Tokyo', undefined, f.state().revision)).error,
    /not refreshed/,
  );
  const state = await f.controller.read();
  assert.equal(state.supported, true);
  assert.equal(state.mode, 'manual');
  assert.match(state.error, /not refreshed/);
  f.delay(0);
  await f.controller.apply('off', '', undefined, f.state().revision);
  assert.equal(f.state().mode, 'off');
});

test('background retries coalesce and follow desktop changes without reloading tabs', async () => {
  const f = fixture();
  await f.controller.read();
  assert.equal(f.alarms.size, 0);
  f.delay(100);
  assert.match(
    (await f.controller.apply('manual', 'Asia/Tokyo', undefined, f.state().revision)).error,
    /not refreshed/,
  );
  assert.ok(f.alarms.has('timezone.restore'));
  f.delay(1);
  const beforeRetry = f.calls.length;
  f.events.alarm({ name: 'timezone.restore' });
  f.events.startup();
  await f.controller.lane;
  assert.deepEqual(
    f.calls.slice(beforeRetry).map(([method]) => method),
    ['timezoneGet', 'timezoneNotify'],
  );
  f.delay(1);
  f.external({ mode: 'off', zone: '' });
  const beforeSync = f.calls.length;
  f.events.alarm({ name: 'timezone.restore' });
  await f.controller.lane;
  assert.deepEqual(
    f.calls.slice(beforeSync).map(([method]) => method),
    ['timezoneGet', 'timezoneNotify'],
  );
  assert.deepEqual(f.reloads, []);
});

test('an incomplete legacy preference cannot make native settings inaccessible', async () => {
  const f = fixture();
  await f.controller.read();
  f.local.timezonePreference = { mode: 'custom', zone: 'Asia/Tokyo' };
  assert.equal((await f.controller.read()).supported, true);
  assert.equal(f.local.timezonePreference, undefined);
  await f.controller.apply('off', '', undefined, f.state().revision);
  assert.equal(f.state().mode, 'off');
});

test('background synchronization cannot authorize an older popup to overwrite desktop changes', async () => {
  const f = fixture();
  const displayed = await f.controller.read();
  f.external({ mode: 'manual', zone: 'Europe/Berlin' });
  const current = await f.controller.read();
  await assert.rejects(
    f.controller.apply('off', '', undefined, displayed.revision),
    /timezone changed/,
  );
  assert.equal(f.state().zone, 'Europe/Berlin');
  await f.controller.apply('off', '', undefined, current.revision);
  assert.equal(f.state().mode, 'off');
});

test('the popup waits for the current Stash results and drops an expired selection', async (context) => {
  const dom = new JSDOM(readFileSync(new URL('./timezone-popup.html', import.meta.url), 'utf8'));
  const pending = [];
  const globals = {
    document: dom.window.document,
    Option: dom.window.Option,
    chrome: {
      runtime: {
        connect() {
          let receive;
          return {
            onMessage: { addListener: (listener) => (receive = listener) },
            onDisconnect: { addListener() {} },
            disconnect() {},
            postMessage(message) {
              pending.push({ message, reply: (result) => receive({ result }) });
            },
          };
        },
      },
    },
  };
  const original = Object.keys(globals).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  Object.assign(globalThis, globals);
  context.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = (id) => dom.window.document.getElementById(`timezone-${id}`);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const respond = async (type, result) => {
    const call = pending.shift();
    assert.equal(call?.message.type, type);
    call.reply(result);
    await settle();
  };
  const search = (value) => {
    element('search').value = value;
    element('search').dispatchEvent(new dom.window.Event('input'));
  };
  const saved = { groupId: 'g', entryId: 'a', version: 7 };
  const entry = (entryId, name) => ({ groupId: 'g', entryId, name, kind: 'server' });
  const choices = (version, ...items) => ({
    version,
    groupId: null,
    groups: [{ id: 'g', name: 'Group' }],
    items,
    selected: null,
    more: false,
  });
  const alpha = entry('a', 'Alpha');
  await import('./timezone-popup.js');
  assert.equal(element('mode').disabled, true);
  await respond('timezone.get', {
    supported: true,
    mode: 'custom',
    zone: 'UTC',
    selection: saved,
    revision: 3,
  });
  await respond('timezone.choices', { ...choices(7, alpha, entry('b', 'Beta')), selected: alpha });
  assert.equal(element('apply').disabled, false);

  search('alpha');
  context.mock.timers.tick(300);
  search('beta');
  assert.equal(element('apply').disabled, true);
  await respond('timezone.choices', choices(8));
  assert.match(element('outbound').selectedOptions[0].textContent, /Alpha/);
  assert.equal(element('apply').disabled, true);
  context.mock.timers.tick(300);
  assert.equal(pending[0].message.query, 'beta');
  await respond('timezone.choices', { ...choices(8, entry('b', 'Beta')), selected: alpha });
  assert.match(element('outbound').selectedOptions[0].textContent, /Alpha/);
  assert.equal(element('apply').disabled, false);

  element('group').value = 'g';
  element('group').dispatchEvent(new dom.window.Event('change'));
  assert.equal(pending[0].message.groupId, 'g');
  assert.equal(pending[0].message.selection.version, 8);
  const remainingGroup = { id: 'h', name: 'Other group' };
  await respond('timezone.choices', {
    ...choices(
      9,
      { ...entry('b', 'Beta'), groupId: 'h' },
      { ...entry('c', 'Beta 2'), groupId: 'h' },
    ),
    groups: [remainingGroup],
  });
  assert.equal(element('group').value, '');
  assert.equal(element('outbound').value, '');
  assert.equal(element('apply').disabled, true);
  assert.match(element('choices-status').textContent, /Stash changed/);
  element('outbound').selectedIndex = 1;
  element('outbound').dispatchEvent(new dom.window.Event('change'));
  element('apply').click();
  assert.deepEqual(pending[0].message.selection, { groupId: 'h', entryId: 'b', version: 9 });
  await respond('timezone.apply', {
    supported: true,
    mode: 'custom',
    zone: 'Europe/Berlin',
    selection: { groupId: 'h', entryId: 'b', version: 9 },
    revision: 4,
  });
  assert.equal(element('outbound').selectedOptions[0].textContent, 'Beta · Server');
  assert.ok(
    [...element('outbound').options].some((option) => option.textContent === 'Beta 2 · Server'),
  );
});
