import { preparedPreview } from './preparedPreview';
import type { GraphState, RuleNode } from '../graph/types';

export async function checkPrepared(
  graph: GraphState,
  node: RuleNode,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (typeof Worker === 'undefined') {
    preparedPreview(graph, node);
    return;
  }
  const worker = new Worker(new URL('./preparedPreview.worker.ts', import.meta.url), {
    type: 'module',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () => reject(new Error('Outbound validation timed out. Reopen the editor to retry.')),
        60000,
      );
      worker.onmessage = (e: MessageEvent<{ error?: string }>) =>
        e.data.error ? reject(new Error(String(e.data.error))) : resolve();
      worker.onerror = () =>
        reject(new Error('Unable to validate this outbound. Reopen the editor to retry.'));
      worker.postMessage({ graph, node, validationOnly: true });
    });
    signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    worker.terminate();
  }
}
