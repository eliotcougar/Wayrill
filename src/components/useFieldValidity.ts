import { useCallback, useState } from 'react';

/** Track only unresolved fields, optionally forwarding their validity to an enclosing editor. */
export default function useFieldValidity(parent?: (id: string, valid: boolean) => void) {
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const report = useCallback(
    (id: string, valid: boolean) => {
      setInvalid((current) => {
        if (valid ? !current[id] : current[id]) return current;
        const next = { ...current };
        if (valid) delete next[id];
        else next[id] = true;
        return next;
      });
      parent?.(id, valid);
    },
    [parent],
  );
  return { invalid, report, blocked: Object.keys(invalid).length > 0 };
}
