import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, serviceCall, type ServiceError } from '../serviceClient';

export type PoolStatus = {
  connection: {
    name: string;
    poolName?: string | null;
    address: string;
    appliedAt: number;
    refreshMinutes: number;
    personalSettings?: boolean;
  } | null;
  busy: boolean;
  applying?: boolean;
  recovering?: boolean;
  error: ServiceError | null;
  deviceErrors?: ServiceError[];
  lastCheckAt?: number | null;
};

export default function usePoolStatus(enabled: boolean, dialogOpen: boolean) {
  const [status, setStatus] = useState<PoolStatus>();
  const [error, setError] = useState('');
  const request = useRef(0);
  const accept = useCallback((next: PoolStatus) => {
    request.current++;
    setStatus(next);
    setError('');
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    async function read() {
      const id = ++request.current;
      try {
        const next = await serviceCall<PoolStatus>('pool.status');
        if (active && id === request.current) accept(next);
      } catch (reason) {
        if (active && id === request.current && (reason as ServiceError | null)?.code !== 'BUSY')
          setError(errorText(reason));
      } finally {
        if (active) timer = window.setTimeout(() => void read(), dialogOpen ? 3000 : 8000);
      }
    }
    void read();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [accept, enabled, dialogOpen]);

  return { status, error, accept };
}
