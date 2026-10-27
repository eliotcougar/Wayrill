import { useState } from 'react';
import { jsonRecord, parseJson } from '../graph/xrayJson';
import { allLogItems, type LogVisibility } from './RoutingLogFilter';

type Scope = 'outputs' | 'rules';
type Visibility = LogVisibility<string | null>;

function read(key: string, scope: Scope): Visibility {
  try {
    const saved = parseJson(localStorage.getItem(key) ?? 'null');
    if (
      jsonRecord(saved) &&
      typeof saved.all === 'boolean' &&
      Array.isArray(saved.exceptions) &&
      saved.exceptions.every(
        (id: unknown): id is string | null =>
          typeof id === 'string' || (scope === 'rules' && id === null),
      )
    )
      return { all: saved.all, exceptions: new Set(saved.exceptions) };
  } catch {
    // Display preferences must not prevent opening the log.
  }
  return allLogItems();
}

export default function useRoutingLogVisibility(filterId: string, scope: Scope) {
  const key = `wayrill.routing-log.filters:${JSON.stringify([filterId, scope])}`;
  const [visibility, setVisibility] = useState(() => read(key, scope));
  const [error, setError] = useState('');
  const change = (next: Visibility) => {
    setVisibility(next);
    try {
      if (next.all && !next.exceptions.size) localStorage.removeItem(key);
      else
        localStorage.setItem(
          key,
          JSON.stringify({ all: next.all, exceptions: [...next.exceptions] }),
        );
      setError('');
    } catch {
      setError('Log filters changed for this session, but could not be saved.');
    }
  };
  return { visibility, change, error };
}
