import { jsonEqual, jsonRecord } from './xrayJson';
import type { GraphState } from './types';

const conflict = (): never => {
  throw new Error(
    'This configuration changed while this editor was open. Your draft is preserved; reopen the editor to use the current configuration.',
  );
};

/** Unedited fields follow refreshes; conflicting authored values require a new draft. */
function fields(before: unknown, draft: unknown, latest: unknown): unknown {
  if (jsonEqual(before, draft)) return latest;
  if (jsonEqual(before, latest) || jsonEqual(draft, latest)) return draft;
  if (jsonRecord(before) && jsonRecord(draft) && jsonRecord(latest))
    return Object.fromEntries(
      [...new Set([...Object.keys(before), ...Object.keys(draft), ...Object.keys(latest)])]
        .map((key) => [key, fields(before[key], draft[key], latest[key])])
        .filter(([, value]) => value !== undefined),
    );
  return conflict();
}

function rows<T extends { id: string }>(
  before: T[],
  draft: T[],
  latest: T[],
  check?: (before: T, draft: T, latest: T) => void,
): T[] {
  const originals = new Map(before.map((row) => [row.id, row]));
  const edits = new Map(draft.map((row) => [row.id, row]));
  const current = new Map(latest.map((row) => [row.id, row]));
  const order = jsonEqual(
    before.map((row) => row.id),
    draft.map((row) => row.id),
  )
    ? [...current.keys(), ...edits.keys()]
    : [...edits.keys(), ...current.keys()];
  return [...new Set(order)].flatMap((id) => {
    const original = originals.get(id),
      edit = edits.get(id),
      now = current.get(id);
    if (original && edit && now) check?.(original, edit, now);
    const value = fields(original, edit, now) as T | undefined;
    return value === undefined ? [] : [value];
  });
}

/** Commit an atomic modal draft without replacing changes made while it was open. */
export function commitEditorDraft(
  before: GraphState,
  draft: GraphState,
  latest: GraphState,
): GraphState {
  const { nodes: oldNodes, edges: oldEdges, ...oldFields } = before;
  const { nodes: draftNodes, edges: draftEdges, ...draftFields } = draft;
  const { nodes: currentNodes, edges: currentEdges, ...currentFields } = latest;
  return {
    ...(fields(oldFields, draftFields, currentFields) as Omit<GraphState, 'nodes' | 'edges'>),
    nodes: rows(oldNodes, draftNodes, currentNodes, (before, draft, latest) => {
      if (before.data.kind !== latest.data.kind && !jsonEqual(before.data, draft.data)) conflict();
    }),
    edges: rows(oldEdges, draftEdges, currentEdges),
  };
}
