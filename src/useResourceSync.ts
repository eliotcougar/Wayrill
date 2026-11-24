import { parseJson } from './graph/xrayJson';
import { useEffect, useMemo, useState } from 'react';
import {
  desktopServiceAvailable,
  errorText,
  mutationOutcomeUnknown,
  serviceCall,
  type ResourceScheduleVersion,
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
            const base = await serviceCall<ResourceScheduleVersion>('resources.scheduleVersion');
            if (!active || base.instanceId !== instanceId) return;
            await serviceCall('resources.configure', { base, schedule });
            if (active) setError('');
            return;
          } catch (e) {
            if (!active) return;
            const busy = !!e && typeof e === 'object' && 'code' in e && e.code === 'BUSY';
            const conflict =
              !!e && typeof e === 'object' && 'code' in e && e.code === 'RESOURCE_SCHEDULE_CHANGED';
            if (!busy && !conflict) setError('Resource files: ' + errorText(e));
            const retryable = !!e && typeof e === 'object' && 'retryable' in e && e.retryable;
            // Read a fresh revision while this schedule is still current. The
            // service rejects any older request that arrives after it commits.
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
