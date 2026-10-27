import { importProfiles, parseStash, type Stash } from './import';
import { mergeLibraryUpdate, confirmStashSave } from './stashMerge';
self.onmessage = (
  event: MessageEvent<{
    text: string;
    name: string;
    stashOnly?: boolean;
    merge?: { base: string; local: Stash };
    confirmation?: { base: string; local: string };
  }>,
) => {
  try {
    if (event.data.confirmation) {
      self.postMessage({
        result: confirmStashSave(
          event.data.confirmation.base,
          event.data.confirmation.local,
          event.data.text,
        ),
      });
      return;
    }
    if (event.data.merge) {
      self.postMessage({
        result: mergeLibraryUpdate(event.data.merge.base, event.data.merge.local, event.data.text),
      });
      return;
    }
    const text = event.data.text;
    self.postMessage({
      result: event.data.stashOnly
        ? { ...parseStash(text), duplicates: 0, rejected: 0, problems: [] }
        : importProfiles(text, event.data.name),
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Import failed.' });
  }
};
