import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { protectedStorageAvailable } from './protectedStorage';
import { mainOutbound, starredChoices } from './quickSwitch';
import type { GraphState, StashLink } from './graph/types';
import type { Stash } from './profiles/import';

interface Selection {
  nodeId: string;
  choice: StashLink | null;
}
// One ordered lane prevents a delayed menu update from restoring stale targets.
let updates: Promise<unknown> = Promise.resolve();
const publish = (view: unknown) => {
  const result = updates.catch(() => {}).then(() => invoke('tray_quick_switch', { view }));
  updates = result;
  return result;
};

export default function useQuickSwitch({
  graph,
  stash,
  enabled,
  onReplace,
  onBrowse,
  onError,
}: {
  graph: GraphState;
  stash: Stash;
  enabled: boolean;
  onReplace: (nodeId: string, link: StashLink) => Promise<void>;
  onBrowse: (nodeId: string) => void;
  onError: (message: string) => void;
}) {
  const entries = useMemo(() => starredChoices(stash), [stash]);
  const nodeId = mainOutbound(graph)?.id ?? null;
  const text = JSON.stringify({ enabled, nodeId, entries });
  const latest = useRef({ text, enabled, nodeId, onReplace, onBrowse, onError });
  latest.current = { text, enabled, nodeId, onReplace, onBrowse, onError };
  const ready = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!protectedStorageAvailable()) return;
    let active = true;
    let remove: (() => void) | undefined;
    const fail = (error: unknown) => {
      if (!active) return;
      latest.current.onError(error instanceof Error ? error.message : String(error));
      const window = getCurrentWindow();
      void window
        .show()
        .then(() => window.unminimize())
        .then(() => window.setFocus())
        .catch(() => {});
    };
    void getCurrentWindow()
      .listen<Selection>('wayrill-tray-replace', ({ payload }) => {
        const current = latest.current;
        // A native menu can remain open while the workspace or service changes.
        if (!current.enabled || current.nodeId !== payload.nodeId || pending.current) return;
        if (!payload.choice) {
          current.onBrowse(payload.nodeId);
          return;
        }
        pending.current = true;
        void current
          .onReplace(payload.nodeId, payload.choice)
          .catch(fail)
          .finally(() => {
            pending.current = false;
          });
      })
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        remove = unsubscribe;
        ready.current = true;
        return publish(JSON.parse(latest.current.text));
      })
      .catch(fail);
    return () => {
      active = false;
      ready.current = false;
      remove?.();
      void publish({ enabled: false, nodeId: null, entries: [] }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!ready.current) return;
    void publish(JSON.parse(text)).catch((error: unknown) => {
      latest.current.onError(`Could not update the tray menu: ${String(error)}`);
    });
  }, [text]);
}
