import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  readServiceStash,
  restoreServiceStash,
  writeServiceStash,
} from './profiles/serviceSubscriptions';
import { validatePreferences, writePreferences, type Preferences } from './backup/preferences';

export const protectedStorageAvailable = () =>
  isTauri() && document.documentElement.dataset.app !== 'pool';
export type StorageSlot = 'workspace' | 'stash' | 'pool-base' | 'pool-previous';
const operations = new Map<StorageSlot, Promise<unknown>>();
let savedWorkspace: string | null | undefined;
type RestoreIntent = { id: string; workspace: boolean; stash: boolean; preferences?: Preferences };
type RestoreDocuments = {
  workspace?: string;
  stash?: { base: string; document: string };
  preferences?: Preferences;
};
let restorePhase: 'idle' | 'committing' | 'pending' = 'idle';
let startupRecovery: Promise<void> | undefined;
let recoveryNotice: string | undefined;
export const backupRestorePending = () => restorePhase === 'pending';
export function takeBackupRecoveryNotice() {
  const notice = recoveryNotice;
  recoveryNotice = undefined;
  return notice;
}

const readSlot = (key: string) => invoke<string | null>('protected_read', { key });
const writeSlot = (key: string, text: string) => invoke<void>('protected_write', { key, text });

async function requiredSlot(key: string) {
  const text = await readSlot(key);
  if (text === null) throw new Error('A staged backup document is missing.');
  return text;
}

async function finishRestore() {
  await invoke('protected_finish_restore');
  restorePhase = 'idle';
}

async function replayRestore(intent: RestoreIntent) {
  if (
    !/^[0-9a-f]{32}$/.test(intent.id) ||
    typeof intent.workspace !== 'boolean' ||
    typeof intent.stash !== 'boolean'
  )
    throw new Error('The backup restore record is invalid.');
  if (intent.preferences) validatePreferences(intent.preferences);
  const workspace = intent.workspace ? await requiredSlot('restore-workspace') : undefined;
  let stash: string | undefined;
  if (intent.stash) {
    const document = await requiredSlot('restore-stash');
    const base = await requiredSlot('restore-base');
    let rejected = false;
    try {
      stash = await restoreServiceStash(intent.id, base, document, () => {
        rejected = true;
      });
    } catch (error) {
      // A completed rejection proves no Stash change. A lost reply leaves the
      // checkpoint intact so the same identity can be reconciled on retry.
      if (rejected) await finishRestore();
      throw error;
    }
  }
  if (workspace !== undefined) {
    await writeSlot('workspace', workspace);
    savedWorkspace = workspace;
  }
  if (intent.preferences) writePreferences(intent.preferences).commit();
  await finishRestore();
  return stash;
}

function recoverRestore() {
  startupRecovery ??= (async () => {
    const pending = await readSlot('restore');
    if (pending !== null) {
      restorePhase = 'committing';
      try {
        await replayRestore(JSON.parse(pending) as RestoreIntent);
      } catch (error) {
        if (restorePhase === 'committing') {
          restorePhase = 'pending';
          throw error;
        }
        recoveryNotice = `The previous backup restore was rejected. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  })().catch((error: unknown) => {
    startupRecovery = undefined;
    throw error;
  });
  return startupRecovery;
}

export async function restoreProtectedWorkspace(documents: RestoreDocuments) {
  await recoverRestore();
  if (restorePhase === 'committing') throw new Error('A backup restore is already running.');
  restorePhase = 'committing';
  return enqueue('workspace', async () => {
    try {
      const pending = await readSlot('restore');
      if (pending !== null) {
        const intent = JSON.parse(pending) as RestoreIntent;
        if (
          (intent.workspace ? await requiredSlot('restore-workspace') : undefined) !==
            documents.workspace ||
          (intent.stash ? await requiredSlot('restore-stash') : undefined) !==
            documents.stash?.document ||
          JSON.stringify(intent.preferences) !== JSON.stringify(documents.preferences)
        )
          throw new Error(
            'A different backup restore is pending. Finish that restore before opening another backup.',
          );
        return await replayRestore(intent);
      }
      if (documents.workspace !== undefined)
        await writeSlot('restore-workspace', documents.workspace);
      if (documents.stash) {
        await writeSlot('restore-base', documents.stash.base);
        await writeSlot('restore-stash', documents.stash.document);
      }
      const intent: RestoreIntent = {
        id: crypto.randomUUID().replaceAll('-', ''),
        workspace: documents.workspace !== undefined,
        stash: documents.stash !== undefined,
        preferences: documents.preferences,
      };
      await writeSlot('restore', JSON.stringify(intent));
      return await replayRestore(intent);
    } catch (error) {
      restorePhase =
        (await readSlot('restore').catch(() => 'unknown')) === null ? 'idle' : 'pending';
      throw error;
    }
  });
}

function enqueue<T>(key: StorageSlot, operation: () => Promise<T>): Promise<T> {
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  operations.set(key, next);
  return next;
}

export function protectedRead(key: StorageSlot): Promise<string | null> {
  const restored = recoverRestore();
  return enqueue(key, async () => {
    await restored;
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

export function saveCompanionDraft(text: string, request: number): Promise<void> {
  return protectedWrite('workspace', text, undefined, request);
}

export function protectedWrite(
  key: StorageSlot,
  text: string,
  base?: string,
  companionRequest?: number,
): Promise<void> {
  // The service library already owns its ordered lane. Capture its snapshot
  // provenance now, before another queued read can acknowledge a newer base.
  if ((key === 'stash' || key === 'workspace') && restorePhase !== 'idle')
    return Promise.reject(new Error('Finish the pending backup restoration before saving.'));
  if (key === 'stash') return writeServiceStash(text, base);
  return enqueue(key, async () => {
    // Compare after earlier operations finish: a reverted draft may follow an
    // in-flight write. Only successful reads/writes establish the saved value.
    // The service owns Stash and can update it independently. Its versioned
    // client handles deduplication; only the desktop-owned workspace is cached.
    if (key === 'workspace' && savedWorkspace === text && companionRequest === undefined) return;
    await invoke<void>('protected_write', {
      key,
      text,
      ...(companionRequest === undefined ? {} : { companionRequest }),
    });
    if (key === 'workspace') savedWorkspace = text;
  });
}
