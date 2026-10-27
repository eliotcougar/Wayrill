import { useEffect, useRef, useState } from 'react';
import { errorText } from './serviceClient';
import {
  protectedRead,
  protectedStorageAvailable,
  protectedWrite,
  type StorageSlot,
} from './protectedStorage';

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
    void protectedRead(slot)
      .then(async (text) => {
        if (!active) return;
        // A corrupt or unsupported document leaves this slot unwritable, including on close.
        await load.current(text);
        if (active) setReady(true);
      })
      .catch((e) => {
        if (active) {
          setError(errorText(e));
          setStatus('unavailable');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
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
