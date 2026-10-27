import { useEffect, useState } from 'react';
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
export function useWindowsCatalog() {
  const [catalog, setCatalog] = useState<WindowsCatalog | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [generation, setGeneration] = useState(0),
    [receivedAt, setReceivedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!desktopServiceAvailable()) return;
    let active = true;
    setLoading(true);
    setError('');
    void serviceCall<WindowsCatalog>('windows.catalog')
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
  }, [generation]);
  return { catalog, error, loading, receivedAt, refresh: () => setGeneration((v) => v + 1) };
}
