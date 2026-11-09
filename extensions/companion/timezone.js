import { extensionApi } from './api.js';

/** @param {typeof chrome} api */
async function lookupMain(api) {
  let timer;
  try {
    const reply = await Promise.race([
      api.runtime.sendNativeMessage('com.wayrill.companion', {
        version: 1,
        id: 1,
        method: 'timezone',
        params: {},
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Main outbound timezone lookup timed out.')),
          40000,
        );
      }),
    ]);
    if (
      reply?.version !== 1 ||
      reply.id !== 1 ||
      !reply.ok ||
      typeof reply.result?.timezone !== 'string' ||
      typeof reply.result?.ip !== 'string'
    )
      throw new Error(reply?.error?.message ?? 'Invalid Main outbound timezone response.');
    return /** @type {{timezone:string,ip:string,name:string,revision:number}} */ (reply.result);
  } finally {
    clearTimeout(timer);
  }
}

/** @typedef {{mode:'off'|'main'|'manual',zone:string,error?:string,name?:string,ip?:string,revision?:number}} Zone */
/** @param {string} value */
export function timezoneId(value) {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new Error('Enter an IANA timezone, for example Europe/Berlin.');
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}
/** @param {string|undefined} url */
const web = (url) => /^https?:\/\//.test(url ?? '');

/** One zone per browser session: renderers and workers can be shared across tabs. */
export class TimezoneController {
  constructor(api = extensionApi(), main = () => lookupMain(api)) {
    this.api = api;
    this.main = main;
    /** @type {Zone} */
    this.state = { mode: 'off', zone: '' };
    /** @type {Set<number>} */
    this.attached = new Set();
    this.epoch = 0;
    this.lane = Promise.resolve();
    this.writes = Promise.resolve();
    this.ready = api.storage.session.get('timezoneState').then(async (saved) => {
      const record = /** @type {{state:Zone,tabs:number[]}|undefined} */ (saved.timezoneState);
      if (!record) return;
      this.state = record.state;
      this.attached = new Set(record.tabs);
      // A service-worker restart must not report a detached override as active.
      if (this.state.mode !== 'off' && this.attached.size) {
        const checks = await Promise.allSettled(
          [...this.attached].map((tabId) => this.command({ tabId }, 'Emulation.canEmulate')),
        );
        if (checks.some((result) => result.status === 'rejected'))
          await this.stop('Timezone session ended. Enable it again to resume.');
      }
    });
    api.debugger?.onEvent.addListener((source, method, params) => {
      if (method === 'Target.attachedToTarget')
        void this.ready
          .then(() =>
            this.child(
              source,
              /** @type {{sessionId:string,targetInfo?:{type:string}}} */ (params),
            ),
          )
          .catch(() => {});
    });
    api.debugger?.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined && reason === 'target_closed') {
        this.attached.delete(source.tabId);
        void this.persist().catch(() => {});
        return;
      }
      if (source.tabId !== undefined && this.attached.has(source.tabId))
        void this.stop(
          'Timezone override stopped by the browser. Enable it again to resume.',
        ).catch(() => {});
    });
    api.tabs.onRemoved.addListener((id) => {
      this.attached.delete(id);
      void this.persist().catch(() => {});
    });
    api.tabs.onUpdated?.addListener((id, change) => {
      if (change.url || change.status === 'loading') this.newTab(id, change.url);
    });
    api.tabs.onCreated?.addListener((tab) => {
      if (tab.id !== undefined) this.newTab(tab.id, tab.url);
    });
    api.webNavigation?.onBeforeNavigate.addListener((event) => {
      if (event.frameId === 0) this.newTab(event.tabId, event.url);
    });
  }
  persist() {
    const timezoneState = structuredClone({ state: this.state, tabs: [...this.attached] });
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.api.storage.session.set({ timezoneState }));
    return this.writes;
  }
  /** @param {() => Promise<unknown>} work */
  enqueue(work) {
    const result = this.lane
      .catch(() => {})
      .then(() => this.ready)
      .then(work);
    this.lane = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** @param {chrome.debugger.DebuggerSession} source @param {string} method @param {object} [params] */
  async command(source, method, params) {
    let timer;
    try {
      return await Promise.race([
        this.api.debugger.sendCommand(source, method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out.`)), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** @param {chrome.debugger.DebuggerSession} source @param {string} zone */
  async configure(source, zone) {
    await this.command(source, 'Emulation.setTimezoneOverride', { timezoneId: zone });
    await this.command(source, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }
  /** @param {chrome.debugger.DebuggerSession} source @param {{sessionId:string,targetInfo?:{type:string}}} params */
  async child(source, params) {
    const child = { ...source, sessionId: params.sessionId };
    const record = this.state;
    try {
      if (record.mode !== 'off') {
        // Service-worker startup will not dispatch Emulation while paused.
        if (params.targetInfo?.type === 'service_worker')
          await this.command(child, 'Runtime.runIfWaitingForDebugger');
        await this.configure(child, record.zone);
      }
    } catch {
      if (this.state === record && record.mode !== 'off') {
        record.error =
          'A frame or worker could not be configured. Full timezone coverage is not established.';
        await this.persist();
      }
    } finally {
      await this.command(child, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  }
  /** @param {number} tabId @param {string} zone @param {number} epoch */
  async attach(tabId, zone, epoch) {
    try {
      await this.api.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      if (!(await this.api.tabs.get(tabId).catch(() => undefined))) return;
      throw error;
    }
    if (epoch !== this.epoch) {
      await this.api.debugger.detach({ tabId }).catch(() => {});
      return;
    }
    this.attached.add(tabId);
    await this.configure({ tabId }, zone);
  }
  /** @param {number} id @param {string} [url] */
  newTab(id, url) {
    void this.enqueue(async () => {
      if (this.state.mode === 'off' || this.attached.has(id)) return;
      const tab = await this.api.tabs.get(id).catch(() => undefined);
      if (!tab || tab.incognito || !web(url ?? tab.url)) return;
      const epoch = this.epoch;
      await this.attach(id, this.state.zone, epoch);
      if (epoch === this.epoch) {
        await this.persist();
        await this.api.tabs.reload(id);
      }
    }).catch(() => {
      if (this.state.mode !== 'off')
        void this.stop('A tab could not be configured. Timezone override stopped.').catch(() => {});
    });
  }
  /** @param {string} [error] @param {boolean} [reload] */
  async stop(error, reload = true) {
    ++this.epoch;
    this.state = { mode: 'off', zone: '', ...(error ? { error } : {}) };
    const tabs = [...this.attached];
    this.attached.clear();
    await Promise.allSettled(tabs.map((tabId) => this.api.debugger.detach({ tabId })));
    await this.persist();
    if (reload) await Promise.allSettled(tabs.map((id) => this.api.tabs.reload(id)));
  }
  async read() {
    await this.ready;
    return { supported: !!this.api.debugger, ...this.state };
  }
  /** @param {number} tabId @param {'off'|'main'|'manual'} mode @param {string} zone */
  apply(tabId, mode, zone) {
    return this.enqueue(() => this.update(tabId, mode, zone));
  }
  /** @param {number} tabId @param {'off'|'main'|'manual'} mode @param {string} zone */
  async update(tabId, mode, zone) {
    if (!['off', 'main', 'manual'].includes(mode)) throw new Error('Choose a timezone mode.');
    if (mode === 'off') {
      await this.stop();
      return this.read();
    }
    if (!this.api.debugger)
      throw new Error(
        'Native timezone override is available only in Chromium browsers in this prototype.',
      );
    const tab = await this.api.tabs.get(tabId);
    if (tab.incognito || !web(tab.url)) throw new Error('Open a regular HTTP(S) page first.');
    const previousEpoch = this.epoch;
    const main = mode === 'main' ? await this.main() : undefined;
    const chosen = timezoneId(main?.timezone ?? zone);
    if (previousEpoch !== this.epoch) throw new Error('Timezone operation canceled.');
    const tabs = (await this.api.tabs.query({})).filter(
      (tab) => tab.id !== undefined && !tab.incognito && web(tab.url),
    );
    await this.stop(undefined, false);
    const epoch = this.epoch;
    this.state = {
      mode,
      zone: chosen,
      ...(main ? { name: main.name, ip: main.ip, revision: main.revision } : {}),
    };
    const results = await Promise.allSettled(
      tabs.map((tab) => this.attach(/** @type {number} */ (tab.id), chosen, epoch)),
    );
    if (epoch !== this.epoch) throw new Error('Timezone operation canceled.');
    if (results.some((result) => result.status === 'rejected')) {
      await this.stop('Timezone override could not be applied to every tab.');
      throw new Error('Timezone override could not be applied to every tab.');
    }
    await this.persist();
    await Promise.allSettled(
      tabs.map((tab) => this.api.tabs.reload(/** @type {number} */ (tab.id))),
    );
    return this.read();
  }
}
