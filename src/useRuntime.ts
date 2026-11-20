import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { desktopServiceAvailable, errorText, serviceCall, serviceEvents } from './serviceClient';
import type { ServiceSnapshot } from './serviceClient';
import { RuntimeSession } from './runtimeSession';

export const LiveSnapshotContext = createContext<RuntimeSession | null>(null);
const idleSubscribe = () => () => {};

// Only the live widgets need every telemetry sample. Keep this subscription
// below the editor so incoming IPC never makes the entire canvas redraw.
export function useLiveSnapshot(fallback: ServiceSnapshot | null, enabled = true) {
  const session = useContext(LiveSnapshotContext);
  return useSyncExternalStore(
    enabled && session ? session.subscribe : idleSubscribe,
    enabled && session ? session.getLiveSnapshot : () => fallback,
  );
}

export default function useRuntime() {
  const [session] = useState(() => new RuntimeSession(serviceCall));
  const state = useSyncExternalStore(session.subscribe, session.getEditorState);
  const desktop = desktopServiceAvailable();
  useEffect(() => {
    if (!desktop) return;
    let active = true,
      remove: (() => void) | undefined;
    void serviceEvents(
      (message) => {
        if (active) session.message(message);
      },
      (state) => {
        if (active) session.transport(state);
      },
    )
      .then((unsubscribe) => {
        if (active) remove = unsubscribe;
        else unsubscribe();
      })
      .catch((error) => {
        if (active) session.update({ error: errorText(error) });
      });
    return () => {
      active = false;
      remove?.();
    };
  }, [desktop, session]);
  const runtime = {
    ...state,
    desktop,
    refresh: session.refresh,
    run: session.run,
    setError: (error: string) => session.update({ error }),
    setNotice: (notice: string) => session.update({ notice }),
    getEvents: session.getEvents,
    subscribeEvents: session.subscribeEvents,
    clearEvents: session.clearEvents,
  };
  return { runtime, session };
}

export type RuntimeController = ReturnType<typeof useRuntime>['runtime'];
