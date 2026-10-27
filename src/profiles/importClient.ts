import type { RefreshRequest, PreparedRefresh } from './refreshPreparation';
import type { ImportResult, Stash } from './import';
export function confirmServiceStashSave(base: string, local: string, text: string) {
  return workerRequest<'applied' | 'not-applied' | 'conflict'>(
    () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }),
    { text, confirmation: { base, local } },
  );
}
export function mergeServiceStash(
  base: string,
  local: Stash,
  text: string,
): Promise<ImportResult | null> {
  return workerRequest<ImportResult | null>(
    () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }),
    { text, name: 'Service stash', stashOnly: true, merge: { base, local } },
  );
}
export function parseImport(
  text: string,
  name: string,
  stashOnly = false,
  signal?: AbortSignal,
): Promise<ImportResult> {
  return workerRequest<ImportResult>(
    () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }),
    { text, name, stashOnly },
    signal,
  );
}
export function prepareImport(
  request: RefreshRequest,
  signal?: AbortSignal,
): Promise<PreparedRefresh> {
  return workerRequest<PreparedRefresh>(
    () =>
      new Worker(new URL('./refreshPreparation.worker.ts', import.meta.url), { type: 'module' }),
    request,
    signal,
  );
}
export function workerRequest<T>(
  createWorker: () => Worker,
  request: unknown,
  signal?: AbortSignal,
  label = 'Import',
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException(`${label} cancelled.`, 'AbortError'));
      return;
    }
    const worker = createWorker();
    const timeout = setTimeout(() => {
      done();
      reject(new Error(`${label} processing timed out.`));
    }, 60000);
    const done = () => {
      clearTimeout(timeout);
      worker.terminate();
      signal?.removeEventListener('abort', cancel);
      worker.onmessage = null;
      worker.onerror = null;
    };
    const cancel = () => {
      done();
      reject(new DOMException(`${label} cancelled.`, 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (e: MessageEvent<{ error?: string; result: T }>) => {
      done();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = () => {
      done();
      reject(new Error(`Could not process the ${label.toLowerCase()}.`));
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      done();
      reject(
        error instanceof Error
          ? error
          : new Error('Could not submit the import.', { cause: error }),
      );
    }
  });
}
