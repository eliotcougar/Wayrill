/** @typedef {{outbound:string, action?:'block'|'route', instanceId?:string, generation?:number, revision?:number, port:number, transport:string, timestampMs:number, source:string, path:{filterId?:string,ruleId?:string|null,rule:string,output:string}[], pathTruncated:boolean}} Match */
/** @typedef {{state:string, instanceId:string, generation:number|null, revision:number|null, timestampMs:number, capacity:number, hosts:{host:string,matches:Match[],truncated:boolean}[], extensionVersion?:string}} Routes */

/** The installed bridge identifies its matching package independently of the
 * routing service. Reload only when this copy's files have actually been updated.
 * @param {string|undefined} version */
export async function reloadUpdatedBundle(version) {
  if (!version) return false;
  const loaded = chrome.runtime.getManifest();
  if (version === loaded.version) return false;
  try {
    const response = await fetch(chrome.runtime.getURL('manifest.json'), {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const installed = await response.json();
    if (installed.version !== version || installed.key !== loaded.key) return false;
    chrome.runtime.reload();
    return true;
  } catch {
    return false;
  }
}

/** A valid bridge reply can identify an updated package even if routing is offline. */
export class BridgeError extends Error {
  /** @param {string} message @param {unknown} version */
  constructor(message, version) {
    super(message);
    this.name = 'BridgeError';
    this.extensionVersion = typeof version === 'string' ? version : undefined;
  }
}

export class NativeClient {
  constructor() {
    /** @type {chrome.runtime.Port|null} */
    this.port = null;
    this.sequence = 0;
    /** @type {{id:number, method:string, resolve:(value:Routes|{opened:boolean})=>void, reject:(error:Error)=>void, timer:ReturnType<typeof setTimeout>}|null} */
    this.pending = null;
  }
  /** @param {string[]} hosts @returns {Promise<Routes>} */
  routes(hosts) {
    return this.request('routes', { hosts }).then((result) => {
      if (!('hosts' in result)) throw new Error('Invalid routes response.');
      return result;
    });
  }
  /** @param {string} host @param {string[]} filterIds */
  async editDomain(host, filterIds) {
    await this.request('editDomain', { host, filterIds });
  }
  /** @param {'routes'|'editDomain'} method
   * @param {{hosts:string[]}|{host:string,filterIds:string[]}} params
   * @returns {Promise<Routes|{opened:boolean}>} */
  request(method, params) {
    if (this.pending)
      return Promise.reject(new Error('A Companion request is already in progress.'));
    if (!this.port) {
      const port = chrome.runtime.connectNative('com.wayrill.companion');
      this.port = port;
      port.onMessage.addListener((message) => {
        if (this.port !== port) return;
        const pending = this.pending;
        if (!pending || message.id !== pending.id || message.version !== 1) return;
        clearTimeout(pending.timer);
        this.pending = null;
        if (
          message.ok &&
          (pending.method === 'routes'
            ? Array.isArray(message.result?.hosts)
            : message.result?.opened === true)
        )
          pending.resolve({
            ...message.result,
            ...(typeof message.extensionVersion === 'string'
              ? { extensionVersion: message.extensionVersion }
              : {}),
          });
        else
          pending.reject(
            new BridgeError(
              message.error?.message ?? 'Wayrill returned an invalid response.',
              message.extensionVersion,
            ),
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
        method,
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
        this.port?.postMessage({ version: 1, id, method, params });
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
