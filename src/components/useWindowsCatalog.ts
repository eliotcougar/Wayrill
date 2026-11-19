import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { serviceCall, desktopServiceAvailable, errorText } from '../serviceClient';
export interface WindowsCatalog {
  ownerSid: string;
  packages: { family: string; name: string; publisher: string }[];
  services: { name: string; displayName: string; pid: number }[];
  processes: { pid: number; name: string; path: string | null }[];
  interfaces: {
    id: string;
    name: string;
    description: string;
    status: number;
    captureExcluded?: boolean;
    addresses?: { address: string; prefixLength: number }[];
  }[];
  excludedCaptureInterfaces?: string[];
  captureInterfaces?: { id: string; name: string; monitored: boolean }[];
}
export function useWindowsCatalog(enabled = true) {
  const pool = document.documentElement.dataset.app === 'pool';
  const available = pool ? isTauri() : desktopServiceAvailable();
  const [catalog, setCatalog] = useState<WindowsCatalog | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [generation, setGeneration] = useState(0),
    [receivedAt, setReceivedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !available) return;
    let active = true;
    setLoading(true);
    setError('');
    const read = pool
      ? invoke<WindowsCatalog>('pool_windows_catalog')
      : serviceCall<WindowsCatalog>('windows.catalog');
    void read
      .then((value) => {
        if (active) {
          setCatalog(value);
          setReceivedAt(Date.now());
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [available, enabled, generation, pool]);
  return {
    available,
    catalog,
    error,
    loading,
    receivedAt,
    refresh: () => setGeneration((v) => v + 1),
  };
}
