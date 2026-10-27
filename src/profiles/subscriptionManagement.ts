import type { StashGroup } from './import';

export function subscriptionUrlKey(value: string): string {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
}

export interface RefreshProgress {
  completed: number;
  total: number;
  active: string;
  updated: string[];
  failed: { id: string; name: string; message: string }[];
  skipped: number;
}

/** One bounded foreground queue; a failed provider never cancels unrelated groups. */
export async function refreshSubscriptionGroups(
  ids: string[],
  resolve: (id: string) => StashGroup | undefined,
  refresh: (group: StashGroup) => Promise<void>,
  signal: AbortSignal,
  progress: (value: RefreshProgress) => void,
): Promise<RefreshProgress> {
  let result: RefreshProgress = {
    completed: 0,
    total: ids.length,
    active: '',
    updated: [],
    failed: [],
    skipped: 0,
  };
  for (const id of ids) {
    signal.throwIfAborted();
    const group = resolve(id);
    if (!group?.url) {
      result = { ...result, completed: result.completed + 1, skipped: result.skipped + 1 };
    } else {
      progress({ ...result, active: group.name });
      try {
        await refresh(group);
        signal.throwIfAborted();
        result = { ...result, completed: result.completed + 1, updated: [...result.updated, id] };
      } catch (error) {
        signal.throwIfAborted();
        result = {
          ...result,
          completed: result.completed + 1,
          failed: [
            ...result.failed,
            {
              id,
              name: group.name,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
    progress({ ...result, active: '' });
  }
  return result;
}
