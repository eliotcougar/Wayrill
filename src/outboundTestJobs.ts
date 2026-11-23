import { mutationOutcomeUnknown, serviceCall } from './serviceClient';

function hasCode(error: unknown, code: string) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function interruptible<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Outbound test request interrupted.'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([cancelled, work()]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export async function waitForTestJob(delay: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await interruptible(
      signal,
      () =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function startTestJob<T>(
  sourceToken: string,
  settings: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const start = () => serviceCall<T>('outbounds.testPlanStart', { sourceToken, settings });
  try {
    return await interruptible(signal, start);
  } catch (error) {
    signal.throwIfAborted();
    if (!mutationOutcomeUnknown(error)) throw error;
    // A lost reply does not tell us whether the single-use draft was consumed.
    try {
      return await queryTestJob<T>('outbounds.testGet', { sourceToken }, signal);
    } catch (error) {
      if (!hasCode(error, 'TEST_JOB_CHANGED')) throw error;
      // Even if the first request is still queued, both starts use one token.
      return interruptible(signal, start);
    }
  }
}

export async function queryTestJob<T>(
  method: 'outbounds.testGet' | 'outbounds.testCancel',
  params: Record<string, unknown>,
  signal: AbortSignal,
  retry = false,
): Promise<T> {
  for (;;) {
    try {
      return await interruptible(signal, () => serviceCall<T>(method, params));
    } catch (error) {
      if (!retry || (!mutationOutcomeUnknown(error) && !hasCode(error, 'BUSY'))) throw error;
      await waitForTestJob(200, signal);
    }
  }
}
