import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
import { protectedWrite } from '../protectedStorage';
import { serializeStash } from './import';
import { serializeGraph } from '../graph/model';
import {
  refreshServiceStash,
  sendSubscriptionContext,
  waitSubscriptionJob,
  type SubscriptionStatus,
} from './serviceSubscriptions';
import type { GraphState } from '../graph/types';
import type useStash from './useStash';

export type MaintenanceStatus = SubscriptionStatus['statuses'][string];
export default function useSubscriptionMaintenance(
  store: Pick<ReturnType<typeof useStash>, 'get' | 'getBase'>,
  graph: GraphState,
  ready: boolean,
  paused: boolean,
  testUrl: string,
  egress = '',
  serviceStatus: SubscriptionStatus | null = null,
) {
  const [statuses, setStatuses] = useState<Record<string, MaintenanceStatus>>({});
  const [foregroundBusy, setForegroundBusy] = useState(false);
  const current = useRef({ store, ready, graph, testUrl });
  current.current = { store, ready, graph, testUrl };
  const foreground = useRef({ count: 0, done: Promise.resolve() });
  const testContext = JSON.stringify([graph.defaults, egress]);
  const cancel = useCallback((id?: string) => {
    void serviceCall('subscriptions.cancel', { ...(id ? { groupId: id } : {}) }).catch(() => {});
  }, []);
  const cancelAutomatic = useCallback((id: string) => {
    void serviceCall('subscriptions.cancel', { groupId: id, automaticOnly: true }).catch(() => {});
  }, []);
  const clearStatus = useCallback((id: string) => {
    setStatuses((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);
  const withForeground = useCallback(
    async <T>(action: () => T | Promise<T>, signal?: AbortSignal) => {
      const previous = foreground.current.done;
      let release!: () => void;
      foreground.current.done = new Promise<void>((resolve) => {
        release = resolve;
      });
      foreground.current.count++;
      setForegroundBusy(true);
      try {
        await previous;
        signal?.throwIfAborted();
        return await action();
      } finally {
        foreground.current.count--;
        setForegroundBusy(!!foreground.current.count);
        release();
      }
    },
    [],
  );
  const run = useCallback(
    async (
      id: string,
      operation: 'refresh' | 'test',
      entryIds?: string[],
      signal?: AbortSignal,
    ) => {
      const viewClosed = () =>
        signal?.reason instanceof DOMException && signal.reason.name === 'ViewClosed';
      const checkCancelled = () => {
        if (!viewClosed()) signal?.throwIfAborted();
      };
      checkCancelled();
      if (!current.current.ready || !desktopServiceAvailable())
        throw new Error('The subscription service is unavailable.');
      const store = current.current.store;
      await protectedWrite('stash', serializeStash(store.get()), store.getBase());
      checkCancelled();
      const { job } = await serviceCall<{ job: number }>('subscriptions.run', {
        groupId: id,
        operation,
        ...(entryIds ? { entryIds } : {}),
      });
      const abort = () => {
        if (!viewClosed()) cancel(id);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        await waitSubscriptionJob(job, signal);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      const state = await serviceCall<SubscriptionStatus>('subscriptions.status');
      await refreshServiceStash(state.version);
    },
    [cancel],
  );
  useEffect(() => {
    if (!ready || !serviceStatus) return;
    let cancelled = false;
    setStatuses(serviceStatus.statuses);
    if (serviceStatus.error) {
      setStatuses({
        ...serviceStatus.statuses,
        service: { state: 'error', message: errorText(serviceStatus.error) },
      });
      return;
    }
    void refreshServiceStash(serviceStatus.version).catch((e: unknown) => {
      if (!cancelled)
        setStatuses((previous) => ({
          ...previous,
          service: { state: 'error', message: errorText(e) },
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [ready, serviceStatus]);
  useEffect(() => {
    if (!ready || !desktopServiceAvailable()) return;
    const timer = setTimeout(() => {
      void sendSubscriptionContext({
        draft: serializeGraph(current.current.graph),
        testUrl: current.current.testUrl,
        testContext,
      }).catch((error: unknown) =>
        setStatuses((previous) => ({
          ...previous,
          service: { state: 'error', message: errorText(error) },
        })),
      );
    }, 1500);
    return () => clearTimeout(timer);
  }, [graph, ready, testUrl, testContext]);
  return {
    appliedRevision: serviceStatus?.appliedRevision ?? null,
    appliedSourceHash: serviceStatus?.appliedSourceHash ?? null,
    statuses,
    run,
    cancel,
    cancelAutomatic,
    clearStatus,
    withForeground,
    foregroundBusy,
    available: ready && !paused && desktopServiceAvailable(),
  };
}
export type SubscriptionMaintenanceController = ReturnType<typeof useSubscriptionMaintenance>;
export const SubscriptionMaintenanceContext =
  createContext<SubscriptionMaintenanceController | null>(null);
