import { useCallback, useEffect, useRef } from 'react';

// File reads cannot be aborted. Ignore completion after another read, a draft
// edit or unmount, so the user's newest action always wins.
export default function useFileRead() {
  const generation = useRef(0);
  const cancel = useCallback(() => {
    generation.current += 1;
  }, []);
  const begin = useCallback(() => {
    const current = ++generation.current;
    return () => current === generation.current;
  }, []);
  useEffect(() => cancel, [cancel]);
  return { begin, cancel };
}
