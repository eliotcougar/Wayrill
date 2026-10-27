import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { protectedStorageAvailable, protectedWrite } from './protectedStorage';
export default function useClosePersistence(
  workspace: () => string,
  workspaceReady: boolean,
  stash: () => string,
  stashReady: boolean,
  onError: (message: string) => void,
  stashBase?: () => string,
) {
  const latest = useRef({ workspace, workspaceReady, stash, stashReady, onError, stashBase });
  latest.current = { workspace, workspaceReady, stash, stashReady, onError, stashBase };
  const close = () => {
    void invoke('desktop_exit').catch((e) => {
      latest.current.onError(
        `Could not close Wayrill: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };
  useEffect(() => {
    if (!protectedStorageAvailable()) return;
    let active = true,
      remove: (() => void) | undefined,
      closing = false;
    const saveAndClose = async () => {
      if (closing) return;
      closing = true;
      try {
        // A user can still edit while a native save is pending. Flush again
        // if either document changed, so closing cannot lose that newer edit.
        for (;;) {
          const data = latest.current;
          const workspaceText = data.workspaceReady ? data.workspace() : null;
          const stashText = data.stashReady ? data.stash() : null;
          const base = data.stashBase?.();
          if (workspaceText !== null) await protectedWrite('workspace', workspaceText);
          if (stashText !== null) await protectedWrite('stash', stashText, base);
          const next = latest.current;
          if (
            workspaceText === (next.workspaceReady ? next.workspace() : null) &&
            stashText === (next.stashReady ? next.stash() : null) &&
            data.workspaceReady === next.workspaceReady &&
            data.stashReady === next.stashReady
          )
            break;
        }
        await getCurrentWindow().destroy();
      } catch (e) {
        void invoke('desktop_close_cancel', {
          message: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
        latest.current.onError(
          `Could not save before closing: ${e instanceof Error ? e.message : String(e)} Export your changes, then try again.`,
        );
        closing = false;
      }
    };
    void getCurrentWindow()
      .listen('wayrill-desktop-exit', () => {
        void saveAndClose();
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
