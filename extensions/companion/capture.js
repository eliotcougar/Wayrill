export const MAX_HOSTS = 128;
const MAX_TABS = 48;
const MAX_PENDING = 256;

/** @typedef {{host:string, count:number, errors:number, cached:number, types:string[], firstSeen:number, lastSeen:number}} Domain */
/** @typedef {{tabId:number, host:string, navigationId:string, startedAt:number, updatedAt:number, domains:Domain[], pending:{id:string,host:string}[], dropped:number}} Page */
/** @typedef {{tabId:number, requestId:string, url:string, type:string, timeStamp:number, incognito?:boolean, fromCache?:boolean}} Request */

/** Store only the hostname, never a URL, path, query, headers, or page content.
 * @param {string} url */
export function hostname(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;
    return parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  } catch {
    return null;
  }
}

export class Capture {
  /** @param {Page[]} [saved] */
  constructor(saved = []) {
    /** @type {Map<number, Page>} */
    this.pages = new Map(saved.slice(-MAX_TABS).map((page) => [page.tabId, page]));
  }
  /** @param {Request} request */
  before(request) {
    if (request.tabId < 0 || request.incognito) return null;
    const host = hostname(request.url);
    if (!host) return null;
    let page = this.pages.get(request.tabId);
    if (!page || (request.type === 'main_frame' && page.navigationId !== request.requestId)) {
      page = {
        tabId: request.tabId,
        host: '',
        navigationId: request.type === 'main_frame' ? request.requestId : '',
        startedAt: request.timeStamp,
        updatedAt: request.timeStamp,
        domains: [],
        pending: [],
        dropped: 0,
      };
      this.pages.set(request.tabId, page);
    }
    if (request.type === 'main_frame') page.host = host;
    page.updatedAt = request.timeStamp;
    let domain = page.domains.find((row) => row.host === host);
    if (!domain) {
      if (page.domains.length >= MAX_HOSTS) {
        page.dropped++;
        return page;
      }
      domain = {
        host,
        count: 0,
        errors: 0,
        cached: 0,
        types: [],
        firstSeen: request.timeStamp,
        lastSeen: request.timeStamp,
      };
      page.domains.push(domain);
    }
    domain.count++;
    domain.lastSeen = request.timeStamp;
    if (!domain.types.includes(request.type)) domain.types.push(request.type);
    page.pending = page.pending.filter((row) => row.id !== request.requestId);
    page.pending.push({ id: request.requestId, host });
    if (page.pending.length > MAX_PENDING) page.pending.shift();
    if (this.pages.size > MAX_TABS) {
      const oldest = [...this.pages.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      this.pages.delete(oldest.tabId);
    }
    return page;
  }
  /** @param {Request} request @param {boolean} failed */
  finish(request, failed) {
    const page = this.pages.get(request.tabId);
    const pending = page?.pending.find((row) => row.id === request.requestId);
    if (!page || !pending) return null;
    const domain = page.domains.find((row) => row.host === pending.host);
    if (domain) {
      if (failed) domain.errors++;
      if (request.fromCache) domain.cached++;
    }
    page.pending = page.pending.filter((row) => row.id !== request.requestId);
    return page;
  }
  /** @param {number} tabId */
  snapshot(tabId) {
    const page = this.pages.get(tabId);
    if (!page) return null;
    const { pending: _pending, ...snapshot } = page;
    void _pending;
    return snapshot;
  }
}
