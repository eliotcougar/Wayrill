import { extensionApi } from './api.js';

/** A dedicated channel avoids competing with the signed Companion's snapshot listener.
 * @param {typeof chrome} api @param {object} message */
export function timezoneMessage(api, message) {
  return new Promise((resolve, reject) => {
    const port = api.runtime.connect({ name: 'wayrill.timezone' });
    let done = false;
    const finish = (/** @type {unknown} */ result, /** @type {Error|undefined} */ error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.disconnect();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(undefined, new Error('Timezone request timed out.')),
      120000,
    );
    port.onMessage.addListener((reply) => finish(reply, undefined));
    port.onDisconnect.addListener(() => {
      const error = api.runtime.lastError;
      finish(undefined, new Error(error?.message ?? 'Timezone controller disconnected.'));
    });
    try {
      port.postMessage(message);
    } catch (error) {
      finish(
        undefined,
        error instanceof Error ? error : new Error('Timezone controller disconnected.'),
      );
    }
  });
}

/** @typedef {{groupId:string,entryId:string,version:number}} Selection */
/** @param {typeof chrome} api @param {string} method @param {object} params */
export async function timezoneRequest(api, method, params) {
  let timer;
  try {
    const reply = await Promise.race([
      api.runtime.sendNativeMessage('com.wayrill.companion', { version: 1, id: 1, method, params }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timezone request timed out.')), 40000);
      }),
    ]);
    if (reply?.version !== 1 || reply.id !== 1 || !reply.ok || !reply.result)
      throw new Error(reply?.error?.message ?? 'Invalid timezone response.');
    return reply.result;
  } finally {
    clearTimeout(timer);
  }
}

/** @typedef {{mode:'off'|'main'|'custom'|'manual',zone:string,selection?:Selection,name?:string,ip?:string,revision?:number}} Zone */
/** @param {string} value */
export function timezoneId(value) {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new Error('Enter an IANA timezone, for example Europe/Berlin.');
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}

/** The service owns preferences; the native host discovers its own browser. */
export class TimezoneController {
  constructor(
    api = extensionApi(),
    request = (/** @type {string} */ method, /** @type {object} */ params) =>
      timezoneRequest(api, method, params),
    observed = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    sleep = (/** @type {number} */ milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.api = api;
    this.request = request;
    this.observed = observed;
    this.sleep = sleep;
    this.lane = Promise.resolve();
    let restoring = false;
    const restore = () => {
      if (restoring) return;
      restoring = true;
      const finish = () => {
        restoring = false;
      };
      void this.read().then(finish, finish);
    };
    api.runtime.onStartup.addListener(restore);
    api.runtime.onInstalled.addListener(restore);
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'timezone.restore') restore();
    });
    restore();
  }
  /** Keep managed browsers in sync with changes made in Wayrill or another profile.
   * @param {boolean} needed */
  async schedule(needed) {
    if (needed) await this.api.alarms.create('timezone.restore', { periodInMinutes: 1 });
    else await this.api.alarms.clear('timezone.restore');
  }
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  enqueue(work) {
    const result = this.lane.then(work);
    this.lane = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** @param {Zone & {supported:boolean,systemZone?:string,error?:string}} state */
  async confirm(state) {
    if (state.error) throw new Error(state.error);
    if (!state.supported) return state;
    const target = state.mode === 'off' ? state.systemZone : state.zone;
    if (!target) throw new Error('The native bridge did not report the system timezone.');
    // Chromium's platform-zone initialization is asynchronous. A notification
    // can arrive before its initial reply. Retry against the worker's observed
    // timezone rather than imposing a fixed startup delay on every operation.
    const expected = timezoneId(target);
    // Windows maps some IANA IDs to a shared native zone. Compare current
    // and seasonal wall-clock rules when the observed ID differs.
    const now = Date.now();
    const year = new Date(now).getUTCFullYear();
    const samples = [now, Date.UTC(year, 0, 15), Date.UTC(year, 6, 15)];
    const formatter = (/** @type {string} */ timeZone) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    let expectedTime;
    for (let attempt = 0; ; ++attempt) {
      const actual = timezoneId(this.observed());
      if (actual === expected) return { ...state, nativeZone: actual };
      const actualTime = formatter(actual);
      const reference = (expectedTime ??= formatter(expected));
      if (samples.every((date) => actualTime.format(date) === reference.format(date)))
        return { ...state, nativeZone: actual };
      if (attempt === 12) break;
      await this.request('timezoneNotify', {});
      await this.sleep(500);
    }
    throw new Error('The browser has not refreshed its timezone. Restart the browser to retry.');
  }
  read() {
    return this.enqueue(async () => {
      try {
        let state = await this.request('timezoneGet', {});
        if (!state.configured) {
          const preferred = /** @type {Zone|undefined} */ (
            (await this.api.storage.local.get('timezonePreference')).timezonePreference
          );
          if (preferred?.mode && preferred.mode !== 'off') {
            // An obsolete or incomplete debugger preference must not hide the
            // service-owned controls. Only migrate a complete supported choice.
            let valid = ['manual', 'main', 'custom'].includes(preferred.mode);
            try {
              timezoneId(preferred.zone);
            } catch {
              valid = false;
            }
            if (preferred.mode === 'custom' && !preferred.selection) valid = false;
            if (valid) {
              try {
                state = await this.request('timezoneSet', {
                  expectedRevision: state.revision,
                  policy: {
                    mode: preferred.mode,
                    zone: timezoneId(preferred.zone),
                    ...(preferred.selection ? { selection: preferred.selection } : {}),
                    ...(preferred.name ? { name: preferred.name } : {}),
                    ...(preferred.ip ? { ip: preferred.ip } : {}),
                  },
                });
              } catch (error) {
                state = {
                  ...state,
                  error:
                    error instanceof Error ? error.message : 'Cannot migrate the saved timezone.',
                };
              }
            }
          }
        }
        if (!state.error) await this.api.storage.local.remove('timezonePreference');
        await this.api.storage.session.remove('timezoneState');
        try {
          state = await this.confirm(state);
        } catch (error) {
          // A failed activation is still an editable desired preference. Hiding
          // it behind a rejected read would also prevent the user choosing Off.
          state = {
            ...state,
            error:
              error instanceof Error ? error.message : 'Native timezone could not be confirmed.',
          };
        }
        await this.schedule(state.configured || !!state.error);
        return state;
      } catch (error) {
        await this.schedule(true);
        throw error;
      }
    });
  }
  /** @param {Zone['mode']} mode @param {string} zone @param {Selection|undefined} selection @param {number} expectedRevision */
  apply(mode, zone, selection, expectedRevision) {
    return this.enqueue(async () => {
      try {
        if (!['off', 'main', 'custom', 'manual'].includes(mode))
          throw new Error('Choose a timezone mode.');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
          throw new Error('Reopen timezone settings before applying a change.');
        if (mode === 'custom' && !selection) throw new Error('Select a Stash outbound first.');
        const lookup = ['main', 'custom'].includes(mode)
          ? await this.request('timezone', mode === 'custom' ? { selection } : {})
          : undefined;
        const state = await this.request('timezoneSet', {
          expectedRevision,
          policy: {
            mode,
            zone: mode === 'off' ? '' : timezoneId(lookup?.timezone ?? zone),
            ...(mode === 'custom' ? { selection } : {}),
            ...(lookup ? { name: lookup.name, ip: lookup.ip } : {}),
          },
        });
        await this.schedule(true);
        let confirmed;
        try {
          confirmed = await this.confirm(state);
        } catch (error) {
          // Persistence already succeeded. Return its revision so the popup can
          // still choose Off without disguising an uncertain apply as rollback.
          return {
            ...state,
            error:
              error instanceof Error ? error.message : 'Native timezone could not be confirmed.',
          };
        }
        const tabs = await this.api.tabs.query({});
        await Promise.allSettled(
          tabs
            .filter((tab) => tab.id !== undefined && /^https?:\/\//.test(tab.url ?? ''))
            .map((tab) => this.api.tabs.reload(/** @type {number} */ (tab.id))),
        );
        return confirmed;
      } catch (error) {
        await this.schedule(true);
        throw error;
      }
    });
  }
}
