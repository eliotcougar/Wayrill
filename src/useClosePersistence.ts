import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  backupRestorePending,
  protectedStorageAvailable,
  protectedWrite,
} from './protectedStorage';
export default function useClosePersistence(
  workspace: () => string,
  workspaceReady: boolean,
  stash: () => string,
  stashReady: boolean,
  onError: (message: string) => void,
  stashBase?: () => string,
  onHandoff?: (frozen: boolean) => void,
) {
  const latest = useRef({
    workspace,
    workspaceReady,
    stash,
    stashReady,
    onError,
    stashBase,
    onHandoff,
  });
  latest.current = { workspace, workspaceReady, stash, stashReady, onError, stashBase, onHandoff };
  const close = () => {
    void invoke('desktop_exit').catch((e) => {
      latest.current.onError(
        `Could not close Wayrill: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };
  useEffect(() => {
    if (!protectedStorageAvailable()) return;
    let active = true;
    let remove: (() => void) | undefined;
    let latestAttempt = 0;
    let frozen = false;
    const freeze = (value: boolean) => {
      if (frozen === value) return;
      frozen = value;
      // The native completion can destroy the window as soon as it arrives.
      // Publish the edit guard synchronously before sending that completion.
      // oxlint-disable-next-line @eslint-react/dom-no-flush-sync
      flushSync(() => latest.current.onHandoff?.(value));
    };
    const saveAndClose = async (attempt: number) => {
      if (!active || attempt <= latestAttempt) return;
      latestAttempt = attempt;
      const current = () => active && latestAttempt === attempt;
      let error: string | null = null;
      try {
        // A user can still edit while a native save is pending. Flush again
        // if either document changed, so closing cannot lose that newer edit.
        while (!backupRestorePending()) {
          const data = latest.current;
          const workspaceText = data.workspaceReady ? data.workspace() : null;
          const stashText = data.stashReady ? data.stash() : null;
          const base = data.stashBase?.();
          if (workspaceText !== null) await protectedWrite('workspace', workspaceText);
          if (!current()) return;
          if (stashText !== null) await protectedWrite('stash', stashText, base);
          if (!current()) return;
          const unchanged = () => {
            const next = latest.current;
            return (
              workspaceText === (next.workspaceReady ? next.workspace() : null) &&
              stashText === (next.stashReady ? next.stash() : null) &&
              data.workspaceReady === next.workspaceReady &&
              data.stashReady === next.stashReady
            );
          };
          if (!unchanged()) continue;
          if (frozen) break;
          freeze(true);
          if (unchanged()) break;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (!current()) return;
      try {
        if (error === null) freeze(true);
        const accepted = await invoke<boolean>('desktop_close_complete', { attempt, error });
        if (!current()) return;
        if (!accepted || error !== null) freeze(false);
        if (accepted && error !== null)
          latest.current.onError(
            `Could not save before closing: ${error} Export your changes, then try again.`,
          );
      } catch (e) {
        if (current()) {
          freeze(false);
          latest.current.onError(
            `Could not close Wayrill: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    };
    void getCurrentWindow()
      .listen<number>('wayrill-desktop-exit', ({ payload }) => {
        void saveAndClose(payload);
      })
      .then((unsubscribe) => {
        if (active) {
          remove = unsubscribe;
          return invoke('desktop_ready');
        }
        unsubscribe();
      })
      .catch((e) => {
        if (active)
          latest.current.onError(
            `Could not prepare save-on-close: ${e instanceof Error ? e.message : String(e)}`,
          );
      });
    return () => {
      active = false;
      remove?.();
    };
  }, []);
  return protectedStorageAvailable() ? close : undefined;
}
