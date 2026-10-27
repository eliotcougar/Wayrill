import { useCallback, useEffect, useState } from 'react';
import { desktopServiceAvailable, errorText, serviceCall } from './serviceClient';
import type { SharingInspection } from './graph/internetSharing';

export default function useInternetSharing(refreshKey: unknown) {
  const [state, setState] = useState<{ value?: SharingInspection; error?: string; busy: boolean }>({
    busy: false,
  });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!desktopServiceAvailable()) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 250;
    setState((previous) => ({ ...previous, busy: true, error: undefined }));
    const inspect = async () => {
      try {
        const value = await serviceCall<SharingInspection>('tun.sharing.get');
        if (current) setState({ value, busy: false });
      } catch (error) {
        if (!current) return;
        // Apply owns the service during transitions. A rejected read says
        // nothing about whether sharing exists, and must be retried afterward.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'BUSY') {
          timer = setTimeout(() => void inspect(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        } else setState({ error: errorText(error), busy: false });
      }
    };
    void inspect();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [refresh, refreshKey]);
  return { ...state, refresh: useCallback(() => setRefresh((r) => r + 1), []) };
}
