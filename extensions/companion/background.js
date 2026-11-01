import { Capture } from './capture.js';
import { extensionApi } from './api.js';

const api = extensionApi();

/** @type {Capture} */
let capture;
let storageError = '';
const ready = Promise.all([api.storage.session.get('pages'), api.tabs.query({})])
  .then(([saved, tabs]) => {
    const open = new Set(tabs.filter((tab) => !tab.incognito).map((tab) => tab.id));
    const pages = /** @type {import('./capture.js').Page[]} */ (
      Array.isArray(saved.pages) ? saved.pages : []
    );
    capture = new Capture(pages.filter((page) => open.has(page.tabId)));
  })
  .catch(() => {
    capture = new Capture();
    storageError = 'Session storage is unavailable. Capture may reset when the extension sleeps.';
  });

// One ordered lane prevents a late storage write from resurrecting a closed tab
// or overwriting the next navigation after a service-worker restart.
let lane = ready;
let writes = Promise.resolve();
/** @type {ReturnType<typeof setTimeout>|undefined} */
let flushTimer;
/** @param {() => void} action */
function change(action) {
  lane = lane
    .then(() => {
      action();
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          writes = writes
            .then(async () => {
              await lane;
              await api.storage.session.set({ pages: [...capture.pages.values()] });
              storageError = '';
            })
            .catch(() => {
              storageError =
                'Session storage is unavailable. Capture may reset when the extension sleeps.';
            });
        }, 250);
      }
    })
    .catch(() => {
      storageError = 'Capture failed. Reload this page to start again.';
    });
}

const filter = { urls: ['<all_urls>'] };
// An unpacked upgrade can start new code before its cached manifest is reloaded.
api.webNavigation.onCommitted.addListener((navigation) => {
  change(() => {
    capture.committed(navigation);
  });
});
api.webRequest.onBeforeRequest.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.before(request);
  });
}, filter);
api.webRequest.onCompleted.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.finish(request, false);
  });
}, filter);
api.webRequest.onErrorOccurred.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.finish(request, true);
  });
}, filter);
api.tabs.onRemoved.addListener((tabId) => {
  change(() => {
    capture.pages.delete(tabId);
  });
});
api.tabs.onReplaced?.addListener((_added, removed) => {
  change(() => {
    capture.pages.delete(removed);
  });
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== api.runtime.id ||
    sender.url !== api.runtime.getURL('popup.html') ||
    message?.type !== 'snapshot' ||
    !Number.isInteger(message.tabId)
  )
    return false;
  void lane.then(() => respond({ page: capture.snapshot(message.tabId), storageError }));
  return true;
});
