import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorMessage,
  type ActionRequest,
  type RemoteClient,
  type ServerJob,
} from './remoteClient';

const key = (session: string) => 'wayrill.remote.job.' + session;
const RESULT_LIFETIME = 60 * 60 * 1000;
const resultExpiresAt = (job: ServerJob) =>
  Math.min(Date.now(), job.updatedAt * 1000) + RESULT_LIFETIME;

function persist(session: string, request: ActionRequest | null, expiresAt?: number) {
  try {
    if (request) localStorage.setItem(key(session), JSON.stringify({ ...request, expiresAt }));
    else localStorage.removeItem(key(session));
  } catch {
    /* Storage may be unavailable. The current job can still be monitored. */
  }
}

function restore(session: string): ActionRequest | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(session)) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      /^[a-f0-9]{32}$/.test(value.id) &&
      'action' in value &&
      [
        'refreshApt',
        'upgradeAll',
        'distUpgrade',
        'upgradePackage',
        'restartXray',
        'reboot',
        'applyConfig',
      ].includes(String(value.action))
    ) {
      const { expiresAt, ...request } = value as ActionRequest & { expiresAt?: number };
      if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
        persist(session, null);
        return null;
      }
      return request;
    }
  } catch {
    /* Storage may be unavailable. The current job can still be monitored. */
  }
  return null;
}

export function useServerJob(client: RemoteClient, session: string, onFinished: () => void) {
  const [request, setRequest] = useState(() => restore(session));
  const [job, setJob] = useState<ServerJob | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);
  const notified = useRef('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dismiss = useCallback(() => {
    setRequest(null);
    setJob(null);
    setError('');
    setRetry(false);
    persist(session, null);
  }, [session]);
  const accept = useCallback(
    (result: ServerJob, expected: ActionRequest) => {
      if (result.id !== expected.id) throw new Error('The server returned another job’s progress.');
      const expiresAt = result.state === 'running' ? undefined : resultExpiresAt(result);
      // Older app versions saved only a request ID. Read its status once, but do
      // not redisplay an already expired result or repeat the action.
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        dismiss();
        return;
      }
      setJob(result);
      setError('');
      persist(session, expected, expiresAt);
      if (result.state !== 'running' && notified.current !== result.id) {
        notified.current = result.id;
        finished.current();
      }
    },
    [dismiss, session],
  );
  useEffect(() => {
    if (!job || job.state === 'running') return;
    const timer = setTimeout(dismiss, Math.max(0, resultExpiresAt(job) - Date.now()));
    return () => clearTimeout(timer);
  }, [dismiss, job]);
  const submit = async (next: ActionRequest) => {
    setRequest(next);
    setJob(null);
    setRetry(false);
    setError('');
    setLaunching(true);
    persist(session, next);
    try {
      const result = await client.startAction(session, next);
      if (mounted.current) accept(result, next);
    } catch (reason) {
      if (mounted.current) {
        setError(errorMessage(reason));
        if (
          reason &&
          typeof reason === 'object' &&
          'code' in reason &&
          ['SUDO', 'JOB_BUSY'].includes(String(reason.code))
        )
          setRetry(true);
      }
    } finally {
      if (mounted.current) setLaunching(false);
    }
  };
  const terminal = job && job.state !== 'running';
  useEffect(() => {
    if (!request || launching || terminal || retry) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await client.pollAction(session, request.id);
        if (!disposed) accept(result, request);
      } catch (reason) {
        if (!disposed) {
          setError(errorMessage(reason));
          if (
            reason &&
            typeof reason === 'object' &&
            'code' in reason &&
            ['JOB_NOT_FOUND', 'SUDO'].includes(String(reason.code))
          ) {
            setRetry(true);
            return;
          }
        }
      }
      if (!disposed)
        timer = setTimeout(() => {
          void poll();
        }, 3000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [accept, client, launching, request, retry, session, terminal]);
  return {
    request,
    job,
    launching,
    error,
    retry,
    active: !!request && !terminal,
    start: (action: Omit<ActionRequest, 'id'>) =>
      submit({ ...action, id: crypto.randomUUID().replaceAll('-', '') }),
    retryRequest: () => request && submit(request),
    dismiss,
  };
}
