import type { StashLink } from '../graph/types';
import { serviceCall, type ServiceError } from '../serviceClient';
import { confirmServiceStashSave } from './importClient';
export type { SubscriptionStatus } from '../serviceClient';

export interface LibraryChange {
  base: string;
  text: string;
}
const listeners = new Set<(change: LibraryChange) => void | Promise<void>>();
let base = '',
  version = -1;
interface SaveCheckpoint {
  authored: string;
  uncertain?: { base: string; document: string };
}
let checkpoint: SaveCheckpoint | undefined,
  pendingSaves = 0;

async function confirmSave(current: string | null) {
  if (!checkpoint?.uncertain) return;
  const { base, document } = checkpoint.uncertain;
  if (current === null) {
    if (base !== '') throw new Error('The service did not retain the subscription library.');
    checkpoint = { authored: base };
    return;
  }
  const state = await confirmServiceStashSave(base, document, current);
  if (state === 'conflict') {
    // This is now an ordinary three-way edit conflict, not an unknown commit.
    // Keep the UI's original base so correcting that edit can be saved normally.
    checkpoint = undefined;
    throw new Error(
      'The previous Stash save could not be confirmed because the same item changed. Your edits were preserved.',
    );
  }
  checkpoint = { authored: state === 'applied' ? document : base };
}
let operations: Promise<unknown> = Promise.resolve();
const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = operations.catch(() => {}).then(action);
  operations = result;
  return result;
};
export function subscribeLibrary(listener: (change: LibraryChange) => void | Promise<void>) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
async function publish(text: string, previous: string, acknowledge = false) {
  if (text !== previous || acknowledge)
    await Promise.all(
      [...listeners].map((listener) => Promise.resolve(listener({ base: previous, text }))),
    );
}
export async function readSubscriptionDocument(kind: 'stash' | 'applied') {
  for (let attempt = 0; attempt < 3; attempt++) {
    let text = '',
      offset = 0,
      revision: number | undefined;
    try {
      for (;;) {
        const part = await serviceCall<{
          text: string;
          nextOffset: number;
          totalBytes: number;
          version: number;
          initialized: boolean;
        }>('subscriptions.read', {
          kind,
          offset,
          ...(revision === undefined ? {} : { version: revision }),
        });
        revision = part.version;
        if (!part.initialized) return { text: null, version: revision };
        text += part.text;
        if (part.nextOffset === part.totalBytes) return { text, version: revision };
        if (part.nextOffset <= offset || part.totalBytes > 64 * 1024 * 1024)
          throw new Error('Invalid subscription document response.');
        offset = part.nextOffset;
      }
    } catch (error) {
      if ((error as ServiceError).code !== 'REVISION_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new Error('Subscription document changed while reading.');
}
export async function waitSubscriptionJob(job: number, signal?: AbortSignal) {
  for (;;) {
    signal?.throwIfAborted();
    const result = await serviceCall<{ busy: boolean; error: ServiceError | null }>(
      'subscriptions.job',
      { job },
    );
    if (!result.busy) {
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function transferSubscriptionDocument(kind: 'save' | 'context' | 'source', payload: unknown) {
  const bytes = new TextEncoder().encode(
    kind === 'source' ? String(payload) : JSON.stringify(payload),
  );
  const started = await serviceCall<{ token: string; chunkBytes: number }>(
    'subscriptions.uploadStart',
    { kind, bytes: bytes.length },
  );
  let committed = false;
  try {
    for (let offset = 0; offset < bytes.length;) {
      let end = Math.min(offset + started.chunkBytes, bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
      await serviceCall('subscriptions.uploadChunk', { token: started.token, offset, text });
      offset = end;
    }
    const result = await serviceCall<{ job: number; sourceGraphToken?: string }>(
      'subscriptions.uploadCommit',
      {
        token: started.token,
      },
    );
    committed = true;
    return result;
  } finally {
    if (!committed)
      await serviceCall('subscriptions.uploadAbort', { token: started.token }).catch(() => {});
  }
}
// Only byte transfers share the service's single upload slot. Waiting for a
// library job must not block staging the graph for a command that will drain it.
let transfers: Promise<unknown> = Promise.resolve();
export async function uploadSubscriptionDocument(
  kind: 'save' | 'context' | 'source',
  payload: unknown,
) {
  const transfer = transfers
    .catch(() => {})
    .then(() => transferSubscriptionDocument(kind, payload));
  transfers = transfer;
  const { job, sourceGraphToken } = await transfer;
  if (kind === 'source') {
    if (!sourceGraphToken) throw new Error('The service did not retain the source graph.');
    return sourceGraphToken;
  }
  await waitSubscriptionJob(job);
}
export function readServiceStash() {
  return enqueue(async () => {
    const result = await readSubscriptionDocument('stash');
    base = result.text ?? '';
    version = result.version;
    if (!pendingSaves) checkpoint = undefined;
    return result.text;
  });
}
export function writeServiceStash(text: string, sourceBase = base) {
  // A renderer snapshot belongs to the base it actually consumed, not a newer
  // service read awaiting its merge worker. Consecutive local saves instead
  // follow their submitted predecessor, including a deliberate reversion.
  pendingSaves++;
  return enqueue(async () => {
    if (checkpoint?.uncertain) {
      const current = await readSubscriptionDocument('stash');
      await confirmSave(current.text);
    }
    const expectedBase = checkpoint?.authored ?? sourceBase;
    if (text === expectedBase) return;
    // A lost response is not cancellation. Retain both possible outcomes until
    // the next successful read confirms which authored delta reached storage.
    checkpoint = { authored: expectedBase, uncertain: { base: expectedBase, document: text } };
    await uploadSubscriptionDocument('save', { base: expectedBase, document: text });
    checkpoint = { authored: text };
    const result = await readSubscriptionDocument('stash');
    if (!result.text) throw new Error('The service did not retain the subscription library.');
    await publish(result.text, text, true);
    base = result.text;
    version = result.version;
    if (pendingSaves === 1) checkpoint = undefined;
  }).finally(() => {
    pendingSaves--;
  });
}
export function refreshServiceStash(expectedVersion: number) {
  return enqueue(async () => {
    if (version === expectedVersion && !checkpoint) return;
    const result = await readSubscriptionDocument('stash');
    if (result.text) {
      await confirmSave(result.text);
      await publish(result.text, checkpoint?.authored ?? base, !!checkpoint);
      base = result.text;
      version = result.version;
      if (!pendingSaves) checkpoint = undefined;
    }
  });
}
export const sendSubscriptionContext = (value: {
  draft?: string;
  testUrl?: string;
  testContext?: string;
}) => enqueue(() => uploadSubscriptionDocument('context', value));
export const stageSubscriptionGraph = (text: string) => uploadSubscriptionDocument('source', text);

/** An explicit assignment, ordered after library saves, resolved by the service. */
export async function replaceRunningOutbound(nodeId: string, link: StashLink) {
  const { job } = await enqueue(() =>
    serviceCall<{ job: number }>('subscriptions.replace', {
      nodeId,
      groupId: link.groupId,
      entryId: link.entryId,
    }),
  );
  try {
    await waitSubscriptionJob(job);
    return true;
  } catch (error) {
    if (!['SUPERSEDED', 'CANCELLED'].includes((error as ServiceError).code)) throw error;
    return false;
  }
}
