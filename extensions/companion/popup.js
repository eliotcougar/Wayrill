import { hostname } from './capture.js';
import { extensionApi } from './api.js';
import { BridgeError, NativeClient, reloadUpdatedBundle } from './native.js';

const api = extensionApi();

/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value;
}
const client = new NativeClient();
let editClient = /** @type {NativeClient|null} */ (null);
const domains = element('domains');
/** @type {Omit<import('./capture.js').Page, 'pending'>|null} */
let page = null;
/** @type {import('./native.js').Routes|null} */
let routes = null;
let serviceStartedAtMs = 0;
let busy = false;
let closed = false;
let connected = false;
let pageKey = '';
/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer;
/** @typedef {{page:Omit<import('./capture.js').Page, 'pending'>|null, storageError:string}} Snapshot */
/** @type {{tabId:number, promise:Promise<Snapshot|null>}|undefined} */
let snapshotRequest;

/** @param {'connected'|'disconnected'|'idle'} state @param {string} label */
function showConnection(state, label) {
  connected = state === 'connected';
  const indicator = element('connection');
  indicator.dataset.state = state;
  indicator.title = label;
  const status = element('status');
  if (status.textContent !== label) status.textContent = label;
}

function recentDomains() {
  return (page?.domains ?? []).filter((domain) => domain.lastSeen >= serviceStartedAtMs);
}

/** A worker that failed to start can leave its message channel pending. Keep
 * one request per current tab rather than enqueue another on every refresh.
 * @param {number} tabId @returns {Promise<Snapshot|null>} */
async function readSnapshot(tabId) {
  if (snapshotRequest?.tabId !== tabId) {
    const promise = api.runtime
      .sendMessage({ type: 'snapshot', tabId, serviceStartedAtMs })
      .catch(() => null);
    snapshotRequest = { tabId, promise };
    void promise.finally(() => {
      if (snapshotRequest?.promise === promise) snapshotRequest = undefined;
    });
  }
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timeout;
  try {
    /** @type {Promise<null>} */
    const expired = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(null), 3000);
    });
    return await Promise.race([snapshotRequest.promise, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

/** @param {string|undefined} version */
async function tryReloadBundle(version) {
  if (closed || !(await reloadUpdatedBundle(version))) return false;
  closed = true;
  client.close();
  return true;
}

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
/** @param {import('./native.js').Match[]} matches */
function routeLine(matches) {
  const route = node('div', '', `route-line${matches.length ? ' observed' : ''}`);
  if (!matches.length) {
    route.append(node('span', 'No route observed yet'));
    return route;
  }

  /** @type {Map<string, {prefix:string, outbounds:Set<string>}>} */
  const groups = new Map();
  for (const match of matches) {
    const outbound = match.action === 'block' ? `Blocked (${match.outbound})` : match.outbound;
    const path = match.path.map(({ filterId, ruleId, rule, output }) => [
      filterId,
      ruleId,
      rule,
      output,
    ]);
    // A truncated path does not establish that two observed outbounds share all its hops.
    const key = JSON.stringify([path, !path.length || match.pathTruncated ? outbound : null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        prefix: match.path.flatMap((hop) => [hop.rule, hop.output]).join(' → '),
        outbounds: new Set(),
      };
      groups.set(key, group);
    }
    group.outbounds.add(outbound);
  }

  const paths = node('span', '', 'route-paths');
  for (const { prefix, outbounds } of groups.values()) {
    if (outbounds.size === 1) {
      const outbound = [...outbounds][0];
      paths.append(node('span', prefix ? `${prefix} → ${outbound}` : outbound));
      continue;
    }
    const path = node('span', '', 'route-branching');
    const branches = node('span', '', 'route-branches');
    branches.setAttribute('role', 'list');
    branches.setAttribute('aria-label', 'Observed outbounds');
    for (const outbound of outbounds) {
      const branch = node('span', '', 'route-branch');
      branch.setAttribute('role', 'listitem');
      const arrow = node('span', '', 'route-branch-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      branch.append(arrow, node('span', outbound));
      branches.append(branch);
    }
    path.append(node('span', prefix), branches);
    paths.append(path);
  }
  route.append(paths);
  return route;
}
/** @param {import('./capture.js').Domain} domain */
function domainRow(domain) {
  const row = document.createElement('details');
  row.className = 'domain';
  row.dataset.host = domain.host;
  const summary = document.createElement('summary');
  const evidence = routes?.hosts.find((item) => item.host === domain.host);
  const matches = evidence?.matches ?? [];
  const title = node('div', '', 'domain-title');
  title.append(node('span', domain.host, 'domain-name'));
  const transports = new Set(matches.map((match) => match.transport.toLowerCase()));
  const protocols = node('span', '', 'protocols');
  for (const protocol of ['tcp', 'udp'])
    if (transports.has(protocol))
      protocols.append(node('span', protocol.toUpperCase(), `protocol-badge ${protocol}`));
  if (protocols.childElementCount) title.append(protocols);
  const heading = node('div', '', 'domain-heading');
  heading.append(title, routeLine(matches));
  summary.append(heading, node('span', `${domain.count} req`, 'request-count'));
  const body = node('div', '', 'domain-body');
  const observations = node('div', '', 'domain-observations');
  observations.append(node('p', `Requests: ${domain.types.join(', ').replaceAll('_', ' ')}`));
  observations.append(node('p', `First ${time(domain.firstSeen)} · Last ${time(domain.lastSeen)}`));
  if (domain.cached || domain.errors)
    observations.append(node('p', `${domain.cached} from cache · ${domain.errors} failed`));
  for (const match of matches) {
    const detail = node('div', '', 'match');
    detail.append(
      node('strong', `${match.outbound} · ${match.transport.toUpperCase()}:${match.port}`),
    );
    detail.append(
      node('p', `Observed ${new Date(match.timestampMs).toLocaleString()} · ${match.source}`),
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
    observations.append(detail);
  }
  if (evidence?.truncated) observations.append(node('p', 'Additional route observations omitted.'));
  if (!matches.length)
    observations.append(
      node(
        'p',
        'This may be cached, outside Wayrill capture, or logged by IP instead of domain. No observation does not establish a direct route.',
      ),
    );
  body.append(observations);
  if (!domain.host.includes(':') && !/^[\d.]+$/.test(domain.host)) {
    const add = /** @type {HTMLButtonElement} */ (
      node('button', 'Add to rule…', 'quiet add-domain')
    );
    add.type = 'button';
    add.dataset.domain = domain.host;
    add.disabled = editClient !== null;
    body.append(add);
  }
  row.append(summary, body);
  return row;
}
function render() {
  const existing = new Map(
    [...domains.querySelectorAll('details')].map((row) => [row.dataset.host, row]),
  );
  const focused = document.activeElement;
  const rows = recentDomains().sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  let cursor = domains.firstElementChild;
  for (const domain of rows) {
    const next = domainRow(domain);
    const row = existing.get(domain.host) ?? next;
    // Keep details/summary identity, focus and unchanged text selections while
    // counts and route observations update. Do not rebuild unrelated cards.
    if (row !== next) {
      for (let index = 0; index < next.children.length; index++) {
        const current = index === 1 ? row.children[index].firstElementChild : row.children[index];
        const replacement =
          index === 1 ? next.children[index].firstElementChild : next.children[index];
        if (!current || !replacement) continue;
        if (current.innerHTML !== replacement.innerHTML)
          current.replaceChildren(...replacement.childNodes);
      }
      const add = row.querySelector('button');
      if (add) add.disabled = editClient !== null;
    }
    if (row !== cursor) domains.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
    existing.delete(domain.host);
  }
  for (const row of existing.values()) row.remove();
  if (
    focused instanceof HTMLElement &&
    domains.contains(focused) &&
    document.activeElement !== focused
  )
    focused.focus({ preventScroll: true });
  element('empty').hidden = rows.length > 0;
  element('empty').textContent =
    'No recent requests for this page. Reload it to capture its domains.';
}

async function refresh() {
  if (busy || closed) return;
  clearTimeout(timer);
  busy = true;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!hostname(tab?.url ?? '') || tab?.id == null || tab.incognito) {
      page = null;
      routes = null;
      render();
      element('empty').textContent =
        'Open a regular webpage to inspect its domains. Browser pages and private tabs are unavailable.';
      showConnection('idle', 'No webpage selected');
      element('connection-error').hidden = true;
      element('capture-warning').hidden = true;
      client.close();
      return;
    }
    // A repaired package must still be able to reload when its old worker could
    // not start. Capture and the native bridge are independent observations.
    const snapshot = await readSnapshot(tab.id);
    page = snapshot?.page ?? null;
    const key = `${tab.id}/${page?.startedAt ?? 0}`;
    if (key !== pageKey) {
      domains.replaceChildren();
      pageKey = key;
      routes = null;
    }
    render();
    const warnings = [
      snapshot
        ? snapshot.storageError
        : 'Request capture is unavailable. Reload the extension to resume.',
      page?.dropped
        ? `Domain limit reached (128). ${page.dropped} further requests were omitted.`
        : '',
    ].filter(Boolean);
    element('capture-warning').hidden = !warnings.length;
    element('capture-warning').textContent = warnings.join(' ');
    try {
      const next = await client.routes(recentDomains().map((row) => row.host));
      if (await tryReloadBundle(next.extensionVersion)) return;
      serviceStartedAtMs = next.serviceStartedAtMs ?? 0;
      const sameService = routes?.instanceId === next.instanceId;
      for (const host of next.hosts)
        for (const match of host.matches) match.instanceId = next.instanceId;
      // Keep known routes through log rollover within a service instance.
      // Older services omit the start time, so their history still ages out with capture.
      for (const host of next.hosts) {
        if (host.matches.length || (!sameService && serviceStartedAtMs > 0)) continue;
        const known = routes?.hosts.find((item) => item.host === host.host);
        if (known) Object.assign(host, known);
      }
      routes = next;
      element('connection-error').hidden = true;
      showConnection(
        'connected',
        routes.state === 'collecting'
          ? 'Wayrill connected'
          : routes.state === 'stopped'
            ? 'Wayrill connected. Routing is stopped.'
            : 'Wayrill connected. Route observations are unavailable.',
      );
    } catch (error) {
      if (closed) return;
      if (error instanceof BridgeError && (await tryReloadBundle(error.extensionVersion))) return;
      showConnection('disconnected', 'Wayrill disconnected');
      element('connection-error').hidden = false;
      element('connection-error').textContent =
        error instanceof Error ? error.message : 'Cannot connect to Wayrill.';
    }
    render();
  } catch {
    showConnection('disconnected', 'Capture unavailable');
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
domains.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element ? event.target.closest('button[data-domain]') : null;
  const host = button instanceof HTMLButtonElement ? button.dataset.domain : undefined;
  if (!host || editClient || closed) return;
  const filterIds = [
    ...new Set(
      (routes?.hosts.find((row) => row.host === host)?.matches ?? [])
        .flatMap((match) =>
          match.path.filter((hop) => hop.ruleId === null).map((hop) => hop.filterId),
        )
        .filter((id) => typeof id === 'string'),
    ),
  ].slice(0, 8);
  const editing = new NativeClient();
  editClient = editing;
  render();
  const status = element('edit-status');
  status.hidden = true;
  void editing
    .editDomain(host, /** @type {string[]} */ (filterIds))
    .then(
      () => {
        status.textContent = 'Choose the filter and rule in Wayrill.';
      },
      (error) => {
        status.textContent = error instanceof Error ? error.message : 'Cannot open Wayrill.';
      },
    )
    .finally(() => {
      editing.close();
      editClient = null;
      if (!closed) {
        status.hidden = false;
        render();
      }
    });
});
const panels = [...document.querySelectorAll('header button[aria-controls]')].map((button) => ({
  button,
  panel: element(button.getAttribute('aria-controls') ?? ''),
}));
for (const { button, panel } of panels) {
  button.addEventListener('click', () => {
    const open = panel.hidden;
    for (const item of panels) {
      const expanded = open && item.button === button;
      item.panel.hidden = !expanded;
      item.button.setAttribute('aria-expanded', String(expanded));
    }
  });
}
element('extension-id').textContent = api.runtime.id;
window.addEventListener('pagehide', () => {
  closed = true;
  clearTimeout(timer);
  client.close();
  editClient?.close();
});
void refresh();
