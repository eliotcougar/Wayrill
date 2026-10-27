import { referenceSummary, policyReferenceKey } from '../components/editorSummaries';
import { libraryTerm } from './library';
import type { GraphState } from '../graph/types';
import type { PolicyPreviewResult } from './policyPreview';

export interface PolicyPreviewQuery {
  search: string;
  page: number;
}
const rows = new WeakMap<PolicyPreviewResult, ReturnType<typeof previewRows>>();
function previewRows(graph: GraphState, result: PolicyPreviewResult) {
  return result.summary.entries.map(({ reference, origins }) => {
    const summary = referenceSummary(graph, reference);
    return {
      key: policyReferenceKey(reference),
      summary,
      origins,
      search: libraryTerm(Object.values(summary).join(' ') + ' ' + origins.join(' ')),
    };
  });
}
export function policyPreviewView(
  graph: GraphState,
  result: PolicyPreviewResult,
  query: PolicyPreviewQuery,
) {
  let indexed = rows.get(result);
  if (!indexed) {
    indexed = previewRows(graph, result);
    rows.set(result, indexed);
  }
  const term = libraryTerm(query.search);
  const filtered = term ? indexed.filter((r) => r.search.includes(term)) : indexed;
  const page = Math.max(0, Math.min(Math.floor(query.page), Math.ceil(filtered.length / 25) - 1));
  const { manual, subscription, duplicates, rejected } = result.summary;
  return {
    summary: {
      manual,
      subscription,
      duplicates,
      rejected,
      total: indexed.length,
      matched: filtered.length,
      page,
      rows: filtered.slice(page * 25, (page + 1) * 25).map(({ search: _, ...row }) => row),
    },
    subscriptions: result.sources.subscriptions.map(({ entries, ...source }) => ({
      ...source,
      entryCount: entries.length,
    })),
    observed: result.observed,
    issues: result.issues,
    corePreview: result.corePreview,
  };
}
export type PolicyPreviewView = ReturnType<typeof policyPreviewView>;
export type PolicyPreviewSnapshot = Pick<PolicyPreviewResult, 'sources' | 'serialized'>;
