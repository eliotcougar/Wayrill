import { useEffect, useRef, useState } from 'react';
import { errorText } from './serviceClient';
import {
  protectedRead,
  protectedStorageAvailable,
  protectedWrite,
  type StorageSlot,
} from './protectedStorage';

function canRetryRead(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return [
    'BUSY',
    'DISCONNECTED',
    'OS_ERROR',
    'PROTECTED_STORAGE_BUSY',
    'SERVICE_STOPPING',
    'SERVICE_UNAVAILABLE',
    'SUBSCRIPTION_JOB_UNAVAILABLE',
    'TIMEOUT',
  ].includes(String(error.code));
}

export default function useProtectedSlot(
  slot: StorageSlot,
  serialize: () => string,
  onLoad: (text: string | null) => void | Promise<void>,
  base?: string,
) {
  const desktop = protectedStorageAvailable();
  const [ready, setReady] = useState(!desktop);
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'saving' | 'saved' | 'unavailable' | 'session'>(
    desktop ? 'saving' : 'session',
  );
  const load = useRef(onLoad);
  load.current = onLoad;

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const fail = (error: unknown) => {
      setError(errorText(error));
      setStatus('unavailable');
      setLoading(false);
    };
    async function read() {
      let text: string | null;
      try {
        text = await protectedRead(slot);
      } catch (error) {
        if (!active) return;
        if (canRetryRead(error)) {
          setError(errorText(error));
          timer = setTimeout(() => void read(), delay);
          delay = Math.min(delay * 2, 10_000);
        } else fail(error);
        return;
      }
      if (!active) return;
      try {
        await load.current(text);
      } catch (error) {
        // Parsing failures leave the saved document intact and the slot unwritable.
        if (active) fail(error);
        return;
      }
      if (!active) return;
      setError('');
      setReady(true);
      setLoading(false);
    }
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [desktop, slot]);

  useEffect(() => {
    if (!desktop || !ready) return;
    let active = true;
    setStatus('saving');
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => protectedWrite(slot, serialize(), base))
        .then(() => {
          if (active) {
            setStatus('saved');
            setError('');
          }
        })
        .catch((e) => {
          if (active) {
            setStatus('unavailable');
            setError(errorText(e));
          }
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [base, desktop, ready, serialize, slot]);

  return { ready, loading, error, status };
}
