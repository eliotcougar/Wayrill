import './background.js';
import { extensionApi } from './api.js';
import { TimezoneController, timezoneRequest } from './timezone.js';

const api = extensionApi();
const timezone = new TimezoneController(api);
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== api.runtime.id ||
    sender.url !== api.runtime.getURL('popup.html') ||
    !Number.isInteger(message?.tabId) ||
    !['timezone.get', 'timezone.apply', 'timezone.choices'].includes(message.type)
  )
    return false;
  const operation =
    message.type === 'timezone.get'
      ? timezone.read()
      : message.type === 'timezone.choices'
        ? timezoneRequest(api, 'timezoneChoices', {
            query: message.query ?? '',
            ...(message.groupId ? { groupId: message.groupId } : {}),
          })
        : timezone.apply(message.tabId, message.mode, message.zone, message.selection);
  void operation.then(
    (result) => respond({ result }),
    (error) =>
      respond({ error: error instanceof Error ? error.message : 'Timezone operation failed.' }),
  );
  return true;
});
