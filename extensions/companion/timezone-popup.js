import { extensionApi } from './api.js';
const api = extensionApi();
const mode = /** @type {HTMLSelectElement} */ (document.getElementById('timezone-mode'));
const zone = /** @type {HTMLInputElement} */ (document.getElementById('timezone-zone'));
const manual = /** @type {HTMLElement} */ (document.getElementById('timezone-manual'));
const status = /** @type {HTMLElement} */ (document.getElementById('timezone-status'));
const apply = /** @type {HTMLButtonElement} */ (document.getElementById('timezone-apply'));
/** @type {number|undefined} */
let tabId;
mode.addEventListener('change', () => {
  manual.hidden = mode.value !== 'manual';
});
/** @param {{supported:boolean,mode:string,zone:string,error?:string,name?:string}} result */
function show(result) {
  mode.value = result.mode;
  zone.value = result.zone;
  manual.hidden = mode.value !== 'manual';
  apply.disabled = !result.supported;
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
    if (reply.result) show(reply.result);
  })
  .catch(() => {
    status.textContent = 'Timezone controller unavailable.';
    apply.disabled = true;
  });
apply.addEventListener('click', async () => {
  apply.disabled = true;
  status.textContent =
    mode.value === 'main' ? 'Looking up Main outbound exit timezone…' : 'Applying…';
  try {
    const reply = await api.runtime.sendMessage({
      type: 'timezone.apply',
      tabId,
      mode: mode.value,
      zone: zone.value,
    });
    if (reply.error) throw new Error(reply.error);
    show(reply.result);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Timezone override failed.';
  } finally {
    apply.disabled = false;
  }
});
