import { useEffect, useState } from 'react';
import type { GeoPage } from './geodata';
import { errorText, serviceCall } from './serviceClient';

type Query = Record<string, unknown> & { file: string; offset: number; limit: number };
type SettledPage = { key: string; input: Query; page?: GeoPage; error?: string };

export function useGeodataPage(query: Query | null, revision: string, debounceMs = 150) {
  const key = JSON.stringify([query, revision]);
  const [settled, setSettled] = useState<SettledPage>();
  useEffect(() => {
    const [pending] = JSON.parse(key) as [Query | null, string];
    if (!pending) return;
    const input = pending;
    let active = true;
    let tracked = true;
    let job: string | undefined;
    let timer: ReturnType<typeof setTimeout>;

    function cancel() {
      if (!job) return;
      const retiring = job;
      job = undefined;
      void serviceCall('resources.browseCancel', { job: retiring }).catch(() => {});
    }

    async function read() {
      try {
        const page = job
          ? await serviceCall<GeoPage>('resources.browseGet', { job })
          : await serviceCall<GeoPage & { job?: string }>(
              'resources.browse',
              tracked ? { ...input, track: true } : input,
            );
        if ('job' in page && typeof page.job === 'string') job = page.job;
        if (!active) {
          // A start reply can arrive after its view has already closed.
          cancel();
          return;
        }
        if (!page.ready) {
          timer = setTimeout(() => void read(), 250);
          return;
        }
        job = undefined;
        setSettled({ key, input, page });
      } catch (error) {
        if (!active) return;
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (tracked && !job && code === 'INVALID_PARAMS') {
          // Older services accept only the original query fields.
          tracked = false;
          void read();
        } else if (['BUSY', 'RESOURCE_CHANGED', 'RESOURCE_BROWSE_EXPIRED'].includes(code)) {
          if (code !== 'BUSY') job = undefined;
          timer = setTimeout(() => void read(), 350);
        } else {
          cancel();
          setSettled({ key, input, error: errorText(error) });
        }
      }
    }

    if (debounceMs) timer = setTimeout(() => void read(), debounceMs);
    else void read();
    return () => {
      active = false;
      clearTimeout(timer);
      cancel();
    };
  }, [key, debounceMs]);
  const current = settled?.key === key ? settled : undefined;
  return { page: current?.page, error: current?.error, loading: !!query && !current, settled };
}
