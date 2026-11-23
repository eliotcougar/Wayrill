import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { LIMITS, CONFIG_LIMIT_LABEL } from './limits';

export function routingUrl(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid routing URL.');
  }
  if (
    value.length > 8192 ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error('Use an HTTP(S) URL without login credentials or a fragment.');
  if (url.protocol === 'http:' && !allowHttp) throw new Error('Use HTTPS or enable Allow HTTP.');
  return url.href;
}

/** Downloads use the unelevated app token and the existing bounded native transport. */
export async function downloadRoutingRules(
  value: string,
  allowHttp: boolean,
  viaWayrill: boolean,
  signal: AbortSignal,
): Promise<string> {
  const url = routingUrl(value, allowHttp);
  signal.throwIfAborted();
  if (isTauri()) {
    const id = crypto.randomUUID().replaceAll('-', '');
    const cancel = () => void invoke('routing_source_download_cancel', { id }).catch(() => {});
    let admitted = false;
    const ready = new Channel<null>(() => {
      admitted = true;
      if (signal.aborted) cancel();
    });
    let onAbort: () => void = () => {};
    let text: string;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          if (admitted) cancel();
          reject(new DOMException('Routing download cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      text = await Promise.race([
        aborted,
        invoke<string>('routing_source_download', { id, ready, url, allowHttp, viaWayrill }),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(String(error), { cause: error });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    if (new TextEncoder().encode(text).length > LIMITS.configBytes)
      throw new Error(`Routing files must be at most ${CONFIG_LIMIT_LABEL}.`);
    return text;
  }
  if (viaWayrill) throw new Error('Download through Wayrill in the Windows app.');
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'Could not download these rules. Browser previews need the source to allow CORS; open a file or use the Windows app.',
    );
  }
  if (!response.ok) throw new Error(`Routing server returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The routing server returned an empty response.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > LIMITS.configBytes)
        throw new Error(`Routing files must be at most ${CONFIG_LIMIT_LABEL}.`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Routing files must be UTF-8 text.');
  }
}
