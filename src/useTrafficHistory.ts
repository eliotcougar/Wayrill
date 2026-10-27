import { useEffect, useRef, useState } from 'react';
import { serviceCall, errorText } from './serviceClient';
import type { RuntimeController } from './useRuntime';
import { mergeTrafficPoints, type TrafficHistory, type TrafficPoint } from './traffic';

export default function useTrafficHistory(runtime: RuntimeController) {
  const traffic = runtime.snapshot?.traffic;
  const revision = traffic?.revision;
  const generation = traffic?.generation;
  const lastSample = traffic?.lastSample;
  const counterEpoch = traffic?.counterEpoch ?? 0;
  const key = `${runtime.snapshot?.instanceId ?? ''}:${traffic?.generation ?? 0}:${counterEpoch}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [history, setHistory] = useState<{ key: string; points: TrafficPoint[] }>({
    key,
    points: [],
  });
  const [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const supported = runtime.capabilities.includes('xray.statistics');
  useEffect(() => {
    if (!runtime.connected || !supported || generation === undefined) return;
    let active = true;
    setError('');
    void serviceCall<TrafficHistory>('traffic.history')
      .then((result) => {
        if (
          !active ||
          currentKey.current !== key ||
          result.generation !== generation ||
          (result.counterEpoch ?? 0) !== counterEpoch ||
          result.revision !== revision
        )
          return;
        setHistory((previous) => ({
          key,
          points: mergeTrafficPoints(previous.key === key ? previous.points : [], result.points),
        }));
      })
      .catch((e) => {
        if (active && currentKey.current === key) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [runtime.connected, supported, key, generation, revision, counterEpoch, retry]);
  useEffect(() => {
    setHistory((previous) => ({
      key,
      points: mergeTrafficPoints(
        previous.key === key ? previous.points : [],
        lastSample ? [lastSample] : [],
      ),
    }));
  }, [key, lastSample]);
  return {
    points: history.key === key ? history.points : [],
    error,
    refresh: () => setRetry((v) => v + 1),
  };
}
