import { useEffect, useState, useSyncExternalStore } from 'react';
import { desktopServiceAvailable, errorText, serviceCall, serviceEvents } from './serviceClient';
import { RuntimeSession } from './runtimeSession';

export default function useRuntime() {
  const [session] = useState(() => new RuntimeSession(serviceCall));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
  return {
    ...state,
    desktop,
    refresh: session.refresh,
    run: session.run,
    setError: (error: string) => session.update({ error }),
    setNotice: (notice: string) => session.update({ notice }),
    clearEvents: () => session.update({ events: [] }),
  };
}

export type RuntimeController = ReturnType<typeof useRuntime>;
