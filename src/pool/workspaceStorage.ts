import { parseGraph, toDocument, validateGraphSize } from '../graph/model';
import type { GraphState } from '../graph/types';
import { jsonRecord } from '../graph/xrayJson';
import { protectedRead } from '../protectedStorage';

export type PoolBaseline = { hash: string; graph: GraphState };
const baselineDocuments = new WeakMap<GraphState, string>();

function graphText(graph: GraphState, indent?: number) {
  const text = JSON.stringify(toDocument(graph), null, indent);
  validateGraphSize(text);
  return text;
}

export function serializeWorkspace(graph: GraphState, baseline?: PoolBaseline): string {
  if (!baseline || baseline.graph.poolId !== graph.poolId) return graphText(graph, 2);
  const draft = graphText(graph);
  const hash = JSON.stringify(baseline.hash);
  const record = `{"format":"wayrill.pool-workspace","version":1,"hash":${hash},"graph":${draft}`;
  // The draft and the ancestor it was edited against have one durable commit.
  if (baseline.graph === graph) return record + '}';
  let saved = baselineDocuments.get(baseline.graph);
  if (saved === undefined) {
    saved = graphText(baseline.graph);
    baselineDocuments.set(baseline.graph, saved);
  }
  return `${record},"baseline":${saved}}`;
}

export async function readWorkspace(text: string): Promise<{
  graph: GraphState;
  baseline?: PoolBaseline;
}> {
  const raw: unknown = JSON.parse(text);
  if (jsonRecord(raw) && raw.format === 'wayrill.pool-workspace') {
    if (raw.version !== 1 || typeof raw.hash !== 'string')
      throw new Error('This Pool workspace format is unsupported.');
    const graph = parseGraph(JSON.stringify(raw.graph));
    const baseline = raw.baseline === undefined ? graph : parseGraph(JSON.stringify(raw.baseline));
    if (!graph.poolId || baseline.poolId !== graph.poolId)
      throw new Error('The Pool workspace has an incompatible merge baseline.');
    return { graph, baseline: { hash: raw.hash, graph: baseline } };
  }

  const graph = parseGraph(text);
  if (graph.poolId && jsonRecord(raw) && typeof raw.poolBaseHash === 'string') {
    // Import a matching baseline from older desktops. An interrupted old
    // update may already have replaced it, in which case the draft can still open.
    try {
      const saved = await protectedRead('pool-base');
      const metadata: unknown = saved && JSON.parse(saved);
      if (saved && jsonRecord(metadata) && metadata.poolBaseHash === raw.poolBaseHash) {
        const baseline = parseGraph(saved);
        if (baseline.poolId === graph.poolId)
          return { graph, baseline: { hash: raw.poolBaseHash, graph: baseline } };
      }
    } catch {
      // The follower archives a conflicting draft if its ancestor is unavailable.
    }
  }
  return { graph };
}
