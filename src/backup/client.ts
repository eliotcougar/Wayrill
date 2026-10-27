import { workerRequest } from '../profiles/importClient';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import type { Preferences } from './preferences';
import type { BackupContent, BackupScope, RestoreSelection, RestoredWorkspace } from './model';

export type BackupRequest =
  | {
      operation: 'create';
      scope: BackupScope;
      graph: GraphState;
      stash: Stash;
      preferences: Preferences;
      filterIds: string[];
      password?: string;
    }
  | { operation: 'open'; text: string; password?: string }
  | {
      operation: 'restore';
      content: BackupContent;
      selection: RestoreSelection;
      graph: GraphState;
      stash: Stash;
    };
export interface OpenedBackup {
  encrypted: boolean;
  content?: BackupContent;
}
export function backupRequest<T extends string | OpenedBackup | RestoredWorkspace>(
  request: BackupRequest,
  signal?: AbortSignal,
): Promise<T> {
  return workerRequest<T>(
    () => new Worker(new URL('./backup.worker.ts', import.meta.url), { type: 'module' }),
    request,
    signal,
    'Backup',
  );
}
