import { hostname } from './capture.js';
import { NativeClient } from './native.js';

/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value;
}
const client = new NativeClient();
const domains = element('domains');
const search = /** @type {HTMLInputElement} */ (element('search'));
/** @type {Omit<import('./capture.js').Page, 'pending'>|null} */
let page = null;
/** @type {import('./native.js').Routes|null} */
let routes = null;
let busy = false;
let closed = false;
let connected = false;
let pageKey = '';
/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer;

/** @param {string} tag @param {string} text @param {string} [className] */
function node(tag, text, className = '') {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}
/** @param {number} timestamp */
function time(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
/** @param {import('./capture.js').Domain} domain @param {Set<string>} opened */
function domainRow(domain, opened) {
  const row = document.createElement('details');
  row.className = 'domain';
  row.dataset.host = domain.host;
  row.open = opened.has(domain.host);
  const summary = document.createElement('summary');
  const evidence = routes?.hosts.find((item) => item.host === domain.host);
  const matches = evidence?.matches ?? [];
  const names = [
    ...new Set(
      matches.map((match) =>
        match.action === 'block' ? `Blocked (${match.outbound})` : match.outbound,
      ),
    ),
  ];
  const label = names.length ? `Last known: ${names.join(' · ')}` : 'No route observed yet';
  const route = node('div', label, `route-line${matches.length ? ' observed' : ''}`);
  const heading = document.createElement('div');
  heading.append(node('span', domain.host, 'domain-name'), route);
  summary.append(heading, node('span', `${domain.count} req`, 'request-count'));
  const body = node('div', '', 'domain-body');
  body.append(node('p', `Requests: ${domain.types.join(', ').replaceAll('_', ' ')}`));
  body.append(node('p', `First ${time(domain.firstSeen)} · Last ${time(domain.lastSeen)}`));
  if (domain.cached || domain.errors)
    body.append(node('p', `${domain.cached} from cache · ${domain.errors} failed`));
  for (const match of matches) {
    const detail = node('div', '', 'match');
    detail.append(
      node('strong', `${match.outbound} · ${match.transport.toUpperCase()}:${match.port}`),
    );
    detail.append(
      node('p', `Observed ${new Date(match.timestampMs).toLocaleString()} · ${match.source}`),
    );
    if (match.revision != null)
      detail.append(
        node(
          'p',
          `Revision ${match.revision}${match.generation != null ? ` · generation ${match.generation}` : ''}`,
        ),
      );
    if (
      !connected ||
      routes?.state !== 'collecting' ||
      match.instanceId !== routes?.instanceId ||
      match.revision !== routes?.revision ||
      match.generation !== routes?.generation
    )
      detail.append(node('p', 'Retained observation; the current route has not been observed.'));
    for (const hop of match.path) detail.append(node('p', `${hop.rule} → ${hop.output}`));
    if (match.pathTruncated) detail.append(node('p', 'Further routing steps omitted.'));
    body.append(detail);
  }
  if (evidence?.truncated) body.append(node('p', 'Additional route observations omitted.'));
  if (!matches.length)
    body.append(
      node(
        'p',
        'This may be cached, outside Wayrill capture, or logged by IP instead of domain. No observation does not establish a direct route.',
      ),
    );
  row.append(summary, body);
  return row;
}
function render() {
  const opened = new Set(
    [...domains.querySelectorAll('details[open]')].map(
      (item) => /** @type {HTMLElement} */ (item).dataset.host ?? '',
    ),
  );
  const query = search.value.trim().toLowerCase();
  const rows = (page?.domains ?? [])
    .filter((row) => row.host.includes(query))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  domains.replaceChildren(...rows.map((row) => domainRow(row, opened)));
  element('count').textContent = `${rows.length} / ${page?.domains.length ?? 0}`;
  element('empty').hidden = rows.length > 0;
  element('empty').textContent = query
    ? 'No domains match your filter.'
    : 'No requests captured for this page yet. Reload the page to capture its domains.';
}

async function refresh() {
  if (busy || closed) return;
  clearTimeout(timer);
  busy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = hostname(tab?.url ?? '');
    element('page-host').textContent = host ?? 'Browser page';
    element('page-title').textContent = tab?.title ?? '';
    if (!host || tab?.id == null || tab.incognito) {
      page = null;
      routes = null;
      render();
      element('empty').textContent =
        'Open a regular webpage to inspect its domains. Browser pages and private tabs are unavailable.';
      element('status').textContent = 'No webpage selected';
      element('status-dot').classList.remove('live');
      element('connection-error').hidden = true;
      element('capture-warning').hidden = true;
      client.close();
      return;
    }
    const snapshot = await chrome.runtime.sendMessage({ type: 'snapshot', tabId: tab.id });
    page = snapshot.page;
    const key = `${tab.id}/${page?.startedAt ?? 0}`;
    if (key !== pageKey) {
      domains.replaceChildren();
      pageKey = key;
      routes = null;
    }
    render();
    const warnings = [
      snapshot.storageError,
      page?.dropped
        ? `Domain limit reached (128). ${page.dropped} further requests were omitted.`
        : '',
    ].filter(Boolean);
    element('capture-warning').hidden = !warnings.length;
    element('capture-warning').textContent = warnings.join(' ');
    try {
      const next = await client.routes((page?.domains ?? []).map((row) => row.host));
      for (const host of next.hosts)
        for (const match of host.matches) match.instanceId = next.instanceId;
      // An empty lookup is not a new routing decision. Keep evidence already
      // shown for this page through log rollover and transient disconnections.
      for (const host of next.hosts) {
        if (host.matches.length) continue;
        const known = routes?.hosts.find((item) => item.host === host.host);
        if (known) Object.assign(host, known);
      }
      routes = next;
      connected = true;
      element('connection-error').hidden = true;
      element('status-dot').classList.toggle('live', routes.state === 'collecting');
      element('status').textContent =
        routes.state === 'collecting'
          ? `Wayrill connected · revision ${routes.revision}`
          : routes.state === 'stopped'
            ? 'Wayrill routing is stopped'
            : 'Wayrill route observations unavailable';
    } catch (error) {
      connected = false;
      element('status-dot').classList.remove('live');
      element('status').textContent = 'Wayrill disconnected';
      element('connection-error').hidden = false;
      element('connection-error').textContent =
        error instanceof Error ? error.message : 'Cannot connect to Wayrill.';
    }
    render();
  } catch {
    connected = false;
    element('status-dot').classList.remove('live');
    element('status').textContent = 'Capture unavailable';
    element('connection-error').hidden = false;
    element('connection-error').textContent = 'Reload the extension and page to restart capture.';
    render();
  } finally {
    busy = false;
    if (!closed)
      timer = setTimeout(() => {
        void refresh();
      }, 2000);
  }
}
search.addEventListener('input', render);
element('refresh').addEventListener('click', () => {
  void refresh();
});
element('setup-button').addEventListener('click', () => {
  const setup = element('setup');
  setup.hidden = !setup.hidden;
  element('setup-button').setAttribute('aria-expanded', String(!setup.hidden));
});
element('extension-id').textContent = chrome.runtime.id;
window.addEventListener('pagehide', () => {
  closed = true;
  clearTimeout(timer);
  client.close();
});
void refresh();
