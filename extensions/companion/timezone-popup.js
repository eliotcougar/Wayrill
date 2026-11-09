import { extensionApi } from './api.js';
const api = extensionApi();
const mode = /** @type {HTMLSelectElement} */ (document.getElementById('timezone-mode'));
const zone = /** @type {HTMLSelectElement} */ (document.getElementById('timezone-zone'));
const manual = /** @type {HTMLElement} */ (document.getElementById('timezone-manual'));
const custom = /** @type {HTMLElement} */ (document.getElementById('timezone-custom'));
const group = /** @type {HTMLSelectElement} */ (document.getElementById('timezone-group'));
const search = /** @type {HTMLInputElement} */ (document.getElementById('timezone-search'));
const outbound = /** @type {HTMLSelectElement} */ (document.getElementById('timezone-outbound'));
const choicesStatus = /** @type {HTMLElement} */ (
  document.getElementById('timezone-choices-status')
);
const status = /** @type {HTMLElement} */ (document.getElementById('timezone-status'));
const apply = /** @type {HTMLButtonElement} */ (document.getElementById('timezone-apply'));
/** @type {number|undefined} */
let tabId;
/** @type {import('./timezone.js').Selection|undefined} */
let selection;
/** @type {{groupId:string,entryId:string,name:string,kind:string}[]} */
let items = [];
let version = 0,
  request = 0,
  loading = false,
  supported = false,
  applying = false;
const key = (/** @type {{groupId:string,entryId:string}} */ item) =>
  JSON.stringify([item.groupId, item.entryId]);
const kinds = /** @type {Record<string,string>} */ ({
  'policy-group': 'Policy group',
  'proxy-chain': 'Chain',
});
for (const name of ['UTC', ...Intl.supportedValuesOf('timeZone')])
  zone.add(new Option(name.replaceAll('_', ' '), name));
zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
function controls() {
  manual.hidden = mode.value !== 'manual';
  custom.hidden = mode.value !== 'custom';
  apply.disabled = !supported || applying || (mode.value === 'custom' && (loading || !selection));
}
async function choices() {
  const ticket = ++request;
  loading = true;
  controls();
  choicesStatus.textContent = 'Reading Stash…';
  try {
    const reply = await api.runtime.sendMessage({
      type: 'timezone.choices',
      tabId,
      query: search.value,
      groupId: group.value,
    });
    if (ticket !== request) return;
    if (reply.error) throw new Error(reply.error);
    const result =
      /** @type {{version:number,groups:{id:string,name:string}[],items:typeof items,more:boolean}} */ (
        reply.result
      );
    version = result.version;
    items = result.items;
    const selectedGroup = group.value;
    group.replaceChildren(new Option('All groups', ''));
    for (const item of result.groups) group.add(new Option(item.name, item.id));
    group.value = selectedGroup;
    const previous = outbound.selectedOptions[0]?.textContent ?? 'Previously selected outbound';
    outbound.replaceChildren(new Option('Select from Stash…', ''));
    for (const item of items)
      outbound.add(new Option(`${item.name} · ${kinds[item.kind] ?? 'Server'}`, key(item)));
    if (selection) {
      const selected = selection;
      const found = items.find((item) => key(item) === key(selected));
      if (found) selection = { ...selection, version };
      else outbound.add(new Option(previous, key(selection)));
      outbound.value = key(selection);
    }
    choicesStatus.textContent = result.more
      ? 'Showing 200 results. Choose a group or refine the search.'
      : `${items.length} outbounds`;
  } catch (error) {
    if (ticket === request)
      choicesStatus.textContent = error instanceof Error ? error.message : 'Cannot read Stash.';
  } finally {
    if (ticket === request) {
      loading = false;
      controls();
    }
  }
}
mode.addEventListener('change', () => {
  controls();
  if (mode.value === 'custom') void choices();
});
group.addEventListener('change', () => {
  void choices();
});
/** @type {ReturnType<typeof setTimeout>|undefined} */
let searchTimer;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void choices();
  }, 300);
});
outbound.addEventListener('change', () => {
  const item = items.find((item) => key(item) === outbound.value);
  selection = item ? { groupId: item.groupId, entryId: item.entryId, version } : undefined;
  controls();
});
/** @param {{supported:boolean,mode:string,zone:string,selection?:import('./timezone.js').Selection,error?:string,name?:string}} result */
function show(result) {
  supported = result.supported;
  mode.value = result.mode;
  if (result.zone && ![...zone.options].some((option) => option.value === result.zone))
    zone.add(new Option(result.zone.replaceAll('_', ' '), result.zone));
  if (result.zone) zone.value = result.zone;
  selection = result.selection;
  if (selection)
    outbound.replaceChildren(new Option(result.name ?? 'Selected outbound', key(selection)));
  controls();
  status.textContent = !result.supported
    ? 'Native timezone override is unavailable in this browser.'
    : (result.error ??
      (result.mode === 'off' ? 'Off' : `${result.zone}${result.name ? ' · ' + result.name : ''}`));
}
void api.tabs
  .query({ active: true, currentWindow: true })
  .then(async ([tab]) => {
    tabId = tab?.id;
    if (tabId === undefined) {
      apply.disabled = true;
      return;
    }
    const reply = await api.runtime.sendMessage({ type: 'timezone.get', tabId });
    if (reply.error) throw new Error(reply.error);
    if (reply.result) show(reply.result);
    if (mode.value === 'custom') await choices();
  })
  .catch(() => {
    status.textContent = 'Timezone controller unavailable.';
    apply.disabled = true;
  });
apply.addEventListener('click', async () => {
  applying = true;
  controls();
  status.textContent = ['main', 'custom'].includes(mode.value)
    ? 'Looking up outbound exit timezone…'
    : 'Applying…';
  try {
    const reply = await api.runtime.sendMessage({
      type: 'timezone.apply',
      tabId,
      mode: mode.value,
      zone: zone.value,
      selection,
    });
    if (reply.error) throw new Error(reply.error);
    show(reply.result);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Timezone override failed.';
  } finally {
    applying = false;
    controls();
  }
});
