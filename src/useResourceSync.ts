import { parseJson } from './graph/xrayJson';
import { useEffect, useState } from 'react';
import { desktopServiceAvailable, errorText, serviceCall } from './serviceClient';
import { readResources, resourcePlans } from './graph/resources';
import type { GraphState } from './graph/types';
let pending: Promise<unknown> = Promise.resolve();
/** Serialize schedule writes; rapid Apply/Undo must leave the latest schedule installed. */
export default function useResourceSync(graph: GraphState, connected: boolean) {
  const [error, setError] = useState('');
  let key = '';
  try {
    key = JSON.stringify({
      files: resourcePlans(graph),
      reloadAfterAutoUpdates: readResources(graph.defaults).reloadAfterAutoUpdates,
    });
  } catch {
    /* Graph diagnostics report invalid drafts. */
  }
  useEffect(() => {
    if (!key || !connected || !desktopServiceAvailable()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        for (let delay = 250; active; delay = Math.min(delay * 2, 5000)) {
          try {
            await serviceCall('resources.configure', parseJson(key) as Record<string, unknown>);
            if (active) setError('');
            return;
          } catch (e) {
            if (!active) return;
            if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'BUSY') {
              setError('Resource files: ' + errorText(e));
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, delay);
            });
            wake = undefined;
          }
        }
      });
    return () => {
      active = false;
      clearTimeout(timer);
      wake?.();
    };
  }, [key, connected]);
  return error;
}
