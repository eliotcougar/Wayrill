import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  errorMessage,
  type ActionRequest,
  type RemoteClient,
  type ServerJob,
} from './remoteClient';

type JobLane = 'server' | 'deployment';
const key = (session: string, lane: JobLane) =>
  (lane === 'deployment' ? 'wayrill.remote.deployment.' : 'wayrill.remote.job.') + session;
const RESULT_LIFETIME = 60 * 60 * 1000;
const resultExpiresAt = (job: ServerJob) =>
  Math.min(Date.now(), job.updatedAt * 1000) + RESULT_LIFETIME;

function persist(
  slot: string,
  request: ActionRequest | null,
  accepted = false,
  expiresAt?: number,
) {
  try {
    if (request) localStorage.setItem(slot, JSON.stringify({ ...request, accepted, expiresAt }));
    else localStorage.removeItem(slot);
  } catch {
    /* Storage may be unavailable. The current job can still be monitored. */
  }
}

function restore(session: string, lane: JobLane): JobState {
  try {
    const slot = key(session, lane);
    const legacySlot = key(session, 'server');
    const raw = localStorage.getItem(slot);
    const legacy = lane === 'deployment' && raw === null;
    const value: unknown = JSON.parse(
      raw ?? (legacy ? localStorage.getItem(legacySlot) : null) ?? 'null',
    );
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
        'restartNginx',
        'reboot',
        'applyConfig',
      ].includes(String(value.action))
    ) {
      const { accepted, expiresAt, ...request } = value as ActionRequest & {
        accepted?: boolean;
        expiresAt?: number;
      };
      if (request.action === 'applyConfig' && (legacy || lane === 'server')) {
        const destination = key(session, 'deployment');
        if (localStorage.getItem(destination) === null) {
          localStorage.setItem(destination, JSON.stringify({ ...request, accepted }));
        }
        localStorage.removeItem(legacySlot);
        if (lane === 'server') return { phase: 'idle' };
      } else if (lane === 'deployment' && request.action !== 'applyConfig') {
        return { phase: 'idle' };
      }
      if (!legacy && typeof expiresAt === 'number' && expiresAt <= Date.now()) {
        persist(slot, null);
      } else {
        return {
          phase: accepted === true || typeof expiresAt === 'number' ? 'observing' : 'checking',
          attempt: { session, request },
        };
      }
    }
  } catch {
    /* Storage may be unavailable. The current job can still be monitored. */
  }
  return { phase: 'idle' };
}

type Attempt = { session: string; request: ActionRequest };
type Monitoring = {
  phase: 'checking' | 'observing';
  attempt: Attempt;
  job?: ServerJob;
  error?: string;
};
type JobState =
  | { phase: 'idle' }
  | { phase: 'submitting'; attempt: Attempt }
  | Monitoring
  | { phase: 'paused'; attempt: Attempt; resume: Monitoring; error: string }
  | { phase: 'rejected'; attempt: Attempt; error: string; retry: boolean }
  | { phase: 'completed'; attempt: Attempt; job: ServerJob; expiresAt?: number };

function monitoring(state: JobState): state is Monitoring {
  return state.phase === 'checking' || state.phase === 'observing';
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function rejection(code: string) {
  if (['BUSY', 'JOB_BUSY', 'SUDO'].includes(code)) return 'retry';
  if (['SYSTEMD', 'JOB_CONFLICT', 'ACTION_INVALID'].includes(code)) return 'dismiss';
  return undefined;
}

export function useServerJob(
  client: RemoteClient,
  session: string,
  onFinished: () => void,
  lane: JobLane = 'server',
) {
  const [state, setState] = useState<JobState>(() => restore(session, lane));
  const slot = key(session, lane);
  const current = useRef(state);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const transition = useCallback((expected: JobState, next: JobState) => {
    if (!mounted.current || current.current !== expected) return false;
    current.current = next;
    setState(next);
    return true;
  }, []);
  const clear = useCallback(
    (expected: Exclude<JobState, { phase: 'idle' }>) => {
      if (transition(expected, { phase: 'idle' })) persist(slot, null);
    },
    [slot, transition],
  );
  const reject = useCallback(
    (
      expected: Monitoring | Extract<JobState, { phase: 'submitting' }>,
      error: string,
      retry: boolean,
    ) => {
      if (transition(expected, { phase: 'rejected', attempt: expected.attempt, error, retry }))
        persist(slot, null);
    },
    [slot, transition],
  );
  const accept = useCallback(
    (result: ServerJob, expected: Monitoring | Extract<JobState, { phase: 'submitting' }>) => {
      const { attempt } = expected;
      const { request } = attempt;
      if (result.id !== request.id || result.action !== request.action)
        throw new Error('The server returned another job’s progress.');
      if (result.state === 'running') {
        if (
          transition(expected, { phase: 'observing', attempt, job: result }) &&
          (expected.phase !== 'observing' || !expected.job)
        )
          persist(slot, request, true);
        return;
      }
      // The editor may still be based on the pre-deployment configuration.
      const expiresAt =
        lane === 'deployment' && result.state === 'succeeded' && result.configResult
          ? undefined
          : resultExpiresAt(result);
      // Older app versions saved only a request ID. Read its status once, but do
      // not redisplay an already expired result or repeat the action.
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        clear(expected);
        return;
      }
      if (transition(expected, { phase: 'completed', attempt, job: result, expiresAt })) {
        persist(slot, request, true, expiresAt);
        finished.current();
      }
    },
    [clear, lane, slot, transition],
  );
  useEffect(() => {
    if (state.phase !== 'completed' || state.expiresAt === undefined) return;
    const timer = setTimeout(() => clear(state), Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [clear, state]);
  const submit = async (request: ActionRequest, expected: JobState) => {
    const attempt = { session, request };
    const starting = { phase: 'submitting', attempt } as const;
    if (!transition(expected, starting)) return;
    persist(slot, request);
    try {
      const job = await client.startAction(session, request);
      accept(job, starting);
    } catch (reason) {
      const outcome = rejection(errorCode(reason));
      if (outcome) reject(starting, errorMessage(reason), outcome === 'retry');
      else transition(starting, { phase: 'checking', attempt, error: errorMessage(reason) });
    }
  };
  const watched = monitoring(state) ? state.attempt : undefined;
  useEffect(() => {
    if (!watched) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const expected = current.current;
      if (!monitoring(expected) || expected.attempt !== watched) return;
      try {
        const result = await client.pollAction(watched.session, watched.request.id);
        if (!disposed) accept(result, expected);
      } catch (reason) {
        if (disposed) return;
        const error = errorMessage(reason);
        const code = errorCode(reason);
        if (code === 'JOB_NOT_FOUND' && expected.phase === 'checking') {
          reject(expected, error, true);
        } else if (['JOB_NOT_FOUND', 'SUDO', 'AUTH', 'HOST_KEY'].includes(code)) {
          transition(expected, { phase: 'paused', attempt: watched, resume: expected, error });
        } else {
          transition(expected, { ...expected, error });
        }
      }
      const next = current.current;
      if (!disposed && monitoring(next) && next.attempt === watched)
        timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [accept, client, reject, transition, watched]);
  const active = monitoring(state) || state.phase === 'submitting' || state.phase === 'paused';
  const acknowledge = useCallback(
    (jobId: string) => {
      const expected = current.current;
      if (
        expected.phase !== 'completed' ||
        expected.job.id !== jobId ||
        expected.expiresAt !== undefined
      )
        return;
      // Keep the result visible but release the saved reference once the
      // matching editor baseline has accepted it.
      persist(slot, null);
      transition(expected, { ...expected, expiresAt: Date.now() + RESULT_LIFETIME });
    },
    [slot, transition],
  );
  return {
    phase: state.phase,
    request: state.phase === 'idle' ? null : state.attempt.request,
    job:
      (state.phase === 'paused' ? state.resume.job : 'job' in state ? state.job : undefined) ??
      null,
    error: 'error' in state ? state.error : undefined,
    retry: state.phase === 'rejected' && state.retry,
    active,
    acknowledge,
    start: (action: Omit<ActionRequest, 'id'>) => {
      const expected = current.current;
      if (
        expected.phase === 'idle' ||
        expected.phase === 'rejected' ||
        expected.phase === 'completed'
      )
        return submit({ ...action, id: crypto.randomUUID().replaceAll('-', '') }, expected);
    },
    retryRequest: () => {
      if (state.phase === 'rejected' && state.retry) return submit(state.attempt.request, state);
    },
    checkProgress: () => {
      if (state.phase === 'paused') transition(state, { ...state.resume, error: undefined });
    },
    dismiss: () => {
      if (state.phase === 'rejected' || state.phase === 'paused' || state.phase === 'completed')
        clear(state);
    },
  };
}
