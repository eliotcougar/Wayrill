import './background.js';
import { extensionApi } from './api.js';
import { TimezoneController, timezoneRequest } from './timezone.js';

const api = extensionApi();
const timezone = new TimezoneController(api);
api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wayrill.timezone') return;
  if (port.sender?.id !== api.runtime.id || port.sender.url !== api.runtime.getURL('popup.html')) {
    port.disconnect();
    return;
  }
  let connected = true,
    handled = false;
  port.onDisconnect.addListener(() => {
    connected = false;
  });
  const respond = (/** @type {object} */ reply) => {
    // The popup can close before its native operation finishes. The service
    // still owns the desired policy; only delivery of this reply is optional.
    if (connected) {
      try {
        port.postMessage(reply);
      } catch {
        connected = false;
      }
    }
  };
  port.onMessage.addListener((message) => {
    if (handled) return;
    handled = true;
    if (!['timezone.get', 'timezone.apply', 'timezone.choices'].includes(message?.type)) {
      respond({ error: 'Unknown timezone request.' });
      return;
    }
    const operation =
      message.type === 'timezone.get'
        ? timezone.read()
        : message.type === 'timezone.choices'
          ? timezoneRequest(api, 'timezoneChoices', {
              query: message.query ?? '',
              ...(message.groupId ? { groupId: message.groupId } : {}),
              ...(message.selected ? { selected: message.selected } : {}),
            })
          : timezone.apply(message.mode, message.zone, message.selection, message.revision);
    void operation.then(
      (result) => respond({ result }),
      (error) =>
        respond({ error: error instanceof Error ? error.message : 'Timezone operation failed.' }),
    );
  });
});
