import { Capture } from './capture.js';

/** @type {Capture} */
let capture;
let storageError = '';
const ready = Promise.all([chrome.storage.session.get('pages'), chrome.tabs.query({})])
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
              await chrome.storage.session.set({ pages: [...capture.pages.values()] });
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
chrome.webRequest.onBeforeRequest.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.before(request);
  });
}, filter);
chrome.webRequest.onCompleted.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.finish(request, false);
  });
}, filter);
chrome.webRequest.onErrorOccurred.addListener((request) => {
  if (request.tabId < 0) return;
  change(() => {
    capture.finish(request, true);
  });
}, filter);
chrome.tabs.onRemoved.addListener((tabId) => {
  change(() => {
    capture.pages.delete(tabId);
  });
});
chrome.tabs.onReplaced.addListener((_added, removed) => {
  change(() => {
    capture.pages.delete(removed);
  });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('popup.html') ||
    message?.type !== 'snapshot' ||
    !Number.isInteger(message.tabId)
  )
    return false;
  void lane.then(() => respond({ page: capture.snapshot(message.tabId), storageError }));
  return true;
});
