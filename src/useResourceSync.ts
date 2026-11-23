import { parseJson } from './graph/xrayJson';
import { useEffect, useMemo, useState } from 'react';
import {
  desktopServiceAvailable,
  errorText,
  mutationOutcomeUnknown,
  serviceCall,
} from './serviceClient';
import { readResources, resourceFiles } from './graph/resources';
import type { GraphState } from './graph/types';
let pending: Promise<unknown> = Promise.resolve();
/** Serialize schedule writes; rapid Apply/Undo must leave the latest schedule installed. */
export default function useResourceSync(graph: GraphState | null, instanceId: string | null) {
  const [error, setError] = useState('');
  const loaded = graph !== null;
  const defaults = graph?.defaults;
  const key = useMemo(() => {
    if (!loaded) return '';
    try {
      const resources = readResources(defaults);
      return JSON.stringify({
        files: resourceFiles(resources),
        reloadAfterAutoUpdates: resources.reloadAfterAutoUpdates,
      });
    } catch {
      // Graph diagnostics report invalid drafts.
      return '';
    }
  }, [loaded, defaults]);
  useEffect(() => {
    if (!key || !instanceId || !desktopServiceAvailable()) return;
    const schedule = parseJson(key) as Record<string, unknown>;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        for (let delay = 250; active; delay = Math.min(delay * 2, 5000)) {
          try {
            await serviceCall('resources.configure', schedule);
            if (active) setError('');
            return;
          } catch (e) {
            if (!active) return;
            const busy = !!e && typeof e === 'object' && 'code' in e && e.code === 'BUSY';
            if (!busy) setError('Resource files: ' + errorText(e));
            const retryable = !!e && typeof e === 'object' && 'retryable' in e && e.retryable;
            // The service serializes these writes and accepts an identical schedule again
            // if the previous reply was lost.
            if (!busy && !retryable && !mutationOutcomeUnknown(e)) return;
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
  }, [key, instanceId]);
  return error;
}
