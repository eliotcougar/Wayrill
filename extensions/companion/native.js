/** @typedef {{outbound:string, action?:'block'|'route', instanceId?:string, generation?:number, revision?:number, port:number, transport:string, timestampMs:number, source:string, path:{rule:string,output:string}[], pathTruncated:boolean}} Match */
/** @typedef {{state:string, instanceId:string, generation:number|null, revision:number|null, timestampMs:number, capacity:number, hosts:{host:string,matches:Match[],truncated:boolean}[]}} Routes */

export class NativeClient {
  constructor() {
    /** @type {chrome.runtime.Port|null} */
    this.port = null;
    this.sequence = 0;
    /** @type {{id:number, resolve:(value:Routes)=>void, reject:(error:Error)=>void, timer:ReturnType<typeof setTimeout>}|null} */
    this.pending = null;
  }
  /** @param {string[]} hosts @returns {Promise<Routes>} */
  routes(hosts) {
    if (this.pending) return Promise.reject(new Error('A route lookup is already in progress.'));
    if (!this.port) {
      const port = chrome.runtime.connectNative('com.wayrill.companion');
      this.port = port;
      port.onMessage.addListener((message) => {
        if (this.port !== port) return;
        const pending = this.pending;
        if (!pending || message.id !== pending.id || message.version !== 1) return;
        clearTimeout(pending.timer);
        this.pending = null;
        if (message.ok && Array.isArray(message.result?.hosts)) pending.resolve(message.result);
        else
          pending.reject(
            new Error(message.error?.message ?? 'Wayrill returned an invalid response.'),
          );
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        if (this.port !== port) return;
        this.fail(
          new Error(
            error
              ? 'Companion bridge unavailable. Open Setup for installation instructions.'
              : 'Companion bridge disconnected.',
          ),
        );
        this.port = null;
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(new Error('Wayrill did not respond. It may be busy; trying again shortly.'));
          const port = this.port;
          this.port = null;
          port?.disconnect();
        }, 7000),
      };
      try {
        this.port?.postMessage({ version: 1, id, method: 'routes', params: { hosts } });
      } catch {
        this.fail(
          new Error('Companion bridge unavailable. Open Setup for installation instructions.'),
        );
        const port = this.port;
        this.port = null;
        port?.disconnect();
      }
    });
  }
  /** @param {Error} error */
  fail(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }
  close() {
    this.fail(new Error('Companion closed.'));
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }
}
