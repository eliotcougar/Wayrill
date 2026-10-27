import { invoke, isTauri } from '@tauri-apps/api/core';
import { readServiceStash, writeServiceStash } from './profiles/serviceSubscriptions';

export const protectedStorageAvailable = () => isTauri();
export type StorageSlot = 'workspace' | 'stash';
const operations = new Map<StorageSlot, Promise<unknown>>();
let savedWorkspace: string | null | undefined;

function enqueue<T>(key: StorageSlot, operation: () => Promise<T>): Promise<T> {
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  operations.set(key, next);
  return next;
}

export function protectedRead(key: StorageSlot): Promise<string | null> {
  return enqueue(key, async () => {
    let text: string | null;
    if (key === 'stash') {
      text = await readServiceStash();
      if (text === null) {
        const legacy = await invoke<string | null>('protected_read', { key });
        if (legacy !== null) {
          await writeServiceStash(legacy);
          text = await readServiceStash();
        }
      }
    } else text = await invoke<string | null>('protected_read', { key });
    if (key === 'workspace') savedWorkspace = text;
    return text;
  });
}

export function protectedWrite(key: StorageSlot, text: string, base?: string): Promise<void> {
  // The service library already owns its ordered lane. Capture its snapshot
  // provenance now, before another queued read can acknowledge a newer base.
  if (key === 'stash') return writeServiceStash(text, base);
  return enqueue(key, async () => {
    // Compare after earlier operations finish: a reverted draft may follow an
    // in-flight write. Only successful reads/writes establish the saved value.
    // The service owns Stash and can update it independently. Its versioned
    // client handles deduplication; only the desktop-owned workspace is cached.
    if (key === 'workspace' && savedWorkspace === text) return;
    await invoke<void>('protected_write', { key, text });
    if (key === 'workspace') savedWorkspace = text;
  });
}
