import './background.js';
import { extensionApi } from './api.js';
import { TimezoneController } from './timezone.js';

const api = extensionApi();
const timezone = new TimezoneController(api);
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== api.runtime.id ||
    sender.url !== api.runtime.getURL('popup.html') ||
    !Number.isInteger(message?.tabId) ||
    !['timezone.get', 'timezone.apply'].includes(message.type)
  )
    return false;
  const operation =
    message.type === 'timezone.get'
      ? timezone.read()
      : timezone.apply(message.tabId, message.mode, message.zone);
  void operation.then(
    (result) => respond({ result }),
    (error) =>
      respond({ error: error instanceof Error ? error.message : 'Timezone operation failed.' }),
  );
  return true;
});
