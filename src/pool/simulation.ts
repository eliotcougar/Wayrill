import { invoke } from '@tauri-apps/api/core';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import { workerRequest } from '../profiles/importClient';
import type { PoolPreview, PoolReview } from './PoolConnection';

export type SimulationWorkspace = { graph: GraphState; stash: Stash };

async function loadDelivery(review: PoolReview) {
  const { bundle, digest, recipient } = await invoke<{
    bundle: unknown;
    digest: string;
    recipient: string;
  }>('pool_simulation_download', { source: review.source });
  if (review.expectedDigest && review.expectedDigest !== digest)
    throw new Error('The Pool changed since your review. Go back and review the latest delivery.');
  return {
    digest,
    input: {
      bundle,
      recipient,
      capture: review.capture,
      bindings: review.bindings,
      poolSelection: review.selection,
      stash: '',
    },
  };
}

export type SimulationRequest = Awaited<ReturnType<typeof loadDelivery>>['input'] & {
  operation: 'poolInspect' | 'poolPrepare';
};

function compose<T>(request: SimulationRequest) {
  return workerRequest<T>(
    () => new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' }),
    request,
    undefined,
    'Pool delivery',
  );
}

export async function inspectInvitation(review: PoolReview): Promise<PoolPreview> {
  const { digest, input } = await loadDelivery(review);
  const poolEntries = await compose<Omit<PoolPreview, 'digest' | 'revision'>>({
    ...input,
    operation: 'poolInspect',
  });
  return { ...poolEntries, digest, revision: 0 };
}

export async function prepareSimulation(review: PoolReview) {
  const { input } = await loadDelivery(review);
  return compose<SimulationWorkspace>({ ...input, operation: 'poolPrepare' });
}

export function evaluateSimulatedRoute<T>(method: string, params: Record<string, unknown> = {}) {
  return invoke<T>('pool_simulation_route', { method, params });
}
