import { extensionApi } from './api.js';
import { timezoneMessage } from './timezone.js';
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
/** @type {import('./timezone.js').Selection|undefined} */
let selection;
/** @type {{groupId:string,entryId:string,name:string,kind:string}[]} */
let items = [];
/** @typedef {{version:number,groupId:string|null,groups:{id:string,name:string}[],items:typeof items,selected:(typeof items)[number]|null,more:boolean}} ChoicePage */
let version = 0,
  request = 0,
  initializing = true,
  loading = false,
  supported = false,
  applying = false;
let revision = 0;
const key = (/** @type {{groupId:string,entryId:string}} */ item) =>
  JSON.stringify([item.groupId, item.entryId]);
const kinds = /** @type {Record<string,string>} */ ({
  'policy-group': 'Policy group',
  'proxy-chain': 'Chain',
});
for (const name of ['UTC', ...Intl.supportedValuesOf('timeZone')])
  zone.add(new Option(name.replaceAll('_', ' '), name));
function selectZone(/** @type {string} */ value) {
  if (!value) return;
  if (![...zone.options].some((option) => option.value === value))
    zone.add(new Option(value.replaceAll('_', ' '), value));
  zone.value = value;
}
selectZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
function controls() {
  const busy = initializing || applying;
  mode.disabled = zone.disabled = group.disabled = search.disabled = busy;
  outbound.disabled = busy || loading || items.length === 0;
  manual.hidden = mode.value !== 'manual';
  custom.hidden = mode.value !== 'custom';
  apply.disabled =
    !supported || busy || (mode.value === 'custom' && (loading || selection?.version !== version));
}
async function choices() {
  const ticket = ++request;
  loading = true;
  controls();
  choicesStatus.textContent = 'Reading Stash…';
  try {
    const reply = await timezoneMessage(api, {
      type: 'timezone.choices',
      query: search.value,
      groupId: group.value,
      selection,
    });
    if (ticket !== request) return;
    if (reply.error) throw new Error(reply.error);
    const result = /** @type {ChoicePage} */ (reply.result);
    group.replaceChildren(new Option('All groups', ''));
    for (const item of result.groups) group.add(new Option(item.name, item.id));
    group.value = result.groupId ?? '';
    version = result.version;
    items = result.items;
    outbound.replaceChildren(new Option('Select from Stash…', ''));
    for (const item of items)
      outbound.add(new Option(`${item.name} · ${kinds[item.kind] ?? 'Server'}`, key(item)));
    const selectionExpired = !!selection && !result.selected;
    const selected = result.selected;
    selection = selected
      ? { groupId: selected.groupId, entryId: selected.entryId, version }
      : undefined;
    if (selected) {
      if (!items.some((item) => key(item) === key(selected))) {
        const option = new Option(selected.name, key(selected));
        option.disabled = true;
        outbound.add(option);
      }
      outbound.value = key(selected);
    }
    choicesStatus.textContent = selectionExpired
      ? 'Stash changed. Select an outbound again.'
      : result.more
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
/** @type {ReturnType<typeof setTimeout>|undefined} */
let searchTimer;
mode.addEventListener('change', () => {
  clearTimeout(searchTimer);
  if (mode.value === 'custom') void choices();
  else {
    ++request;
    loading = false;
    controls();
  }
});
group.addEventListener('change', () => {
  clearTimeout(searchTimer);
  void choices();
});
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  ++request;
  loading = true;
  controls();
  searchTimer = setTimeout(() => {
    void choices();
  }, 300);
});
outbound.addEventListener('change', () => {
  const item = items.find((item) => key(item) === outbound.value);
  selection = item ? { groupId: item.groupId, entryId: item.entryId, version } : undefined;
  controls();
});
/** @param {{supported:boolean,mode:string,zone:string,revision:number,nativeZone?:string,selection?:import('./timezone.js').Selection,error?:string,name?:string}} result */
function show(result) {
  revision = result.revision;
  supported = result.supported;
  mode.value = result.mode;
  selectZone(result.zone);
  selection = result.selection;
  if (selection) {
    const value = key(selection);
    if (![...outbound.options].some((option) => option.value === value))
      outbound.add(new Option(result.name ?? 'Selected outbound', value));
    outbound.value = value;
  } else outbound.value = '';
  controls();
  status.textContent = !result.supported
    ? 'Native timezone override is unavailable in this browser.'
    : (result.error ??
      (result.mode === 'off'
        ? 'Off'
        : `${result.nativeZone ?? result.zone}${result.name ? ' · ' + result.name : ''}`));
}
controls();
void timezoneMessage(api, { type: 'timezone.get' })
  .then((reply) => {
    if (reply.error) throw new Error(reply.error);
    if (reply.result) show(reply.result);
    if (mode.value === 'custom') void choices();
  })
  .catch((error) => {
    status.textContent =
      error instanceof Error ? error.message : 'Timezone controller unavailable.';
  })
  .finally(() => {
    initializing = false;
    controls();
  });
apply.addEventListener('click', async () => {
  if (apply.disabled) return;
  applying = true;
  controls();
  status.textContent = ['main', 'custom'].includes(mode.value)
    ? 'Looking up outbound exit timezone…'
    : 'Applying…';
  try {
    const reply = await timezoneMessage(api, {
      type: 'timezone.apply',
      mode: mode.value,
      zone: zone.value,
      selection,
      revision,
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
