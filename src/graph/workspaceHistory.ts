import type { GraphState } from './types';
import type { Stash } from '../profiles/import';
import { toDocument } from './model';
import { jsonEqual } from './xrayJson';

export interface WorkspaceRevision {
  /** An explicit whole-graph transition, distinct from edits within that graph. */
  viewportKey?: number;
  graph: GraphState;
  stash?: Stash;
}
export interface WorkspaceHistory {
  past: WorkspaceRevision[];
  present: WorkspaceRevision;
  future: WorkspaceRevision[];
}
export const initialWorkspaceHistory = (graph: GraphState, stash?: Stash): WorkspaceHistory => ({
  past: [],
  present: { graph, stash },
  future: [],
});
export function commitWorkspaceHistory(
  history: WorkspaceHistory,
  present: WorkspaceRevision,
): WorkspaceHistory {
  if (present.viewportKey === undefined && history.present.viewportKey !== undefined)
    present = { ...present, viewportKey: history.present.viewportKey };
  if (
    history.present.stash === present.stash &&
    jsonEqual(toDocument(history.present.graph), toDocument(present.graph))
  )
    return { ...history, present };
  return { past: [...history.past.slice(-79), history.present], present, future: [] };
}
export function undoWorkspaceHistory(history: WorkspaceHistory): WorkspaceHistory {
  const present = history.past.at(-1);
  return present
    ? { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] }
    : history;
}
export function redoWorkspaceHistory(history: WorkspaceHistory): WorkspaceHistory {
  const present = history.future[0];
  return present
    ? { past: [...history.past, history.present], present, future: history.future.slice(1) }
    : history;
}
