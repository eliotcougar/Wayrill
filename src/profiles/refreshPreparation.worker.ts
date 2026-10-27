import { prepareRefresh, type RefreshRequest } from './refreshPreparation';
self.onmessage = (event: MessageEvent<RefreshRequest>) => {
  try {
    self.postMessage({ result: prepareRefresh(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Import failed.' });
  }
};
