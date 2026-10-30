export interface SourceMatch {
  identity?: string;
  name?: string;
  role: string;
  exact: string;
  shape: string;
  tokens: ReadonlySet<string>;
}

/** Stable IDs first, then unique legacy content. Never transfer edits by position. */
export function matchSourceRows(previous: SourceMatch[], incoming: SourceMatch[]) {
  const result = new Map<number, number>(),
    used = new Set<number>();
  const match = (predicate: (old: SourceMatch, next: SourceMatch) => boolean) => {
    for (const [i, next] of incoming.entries()) {
      if (result.has(i)) continue;
      const choices = previous.flatMap((old, j) =>
        !used.has(j) && predicate(old, next) ? [j] : [],
      );
      if (choices.length !== 1) continue;
      const chosen = choices[0];
      if (
        incoming.some((other, j) => j !== i && !result.has(j) && predicate(previous[chosen], other))
      )
        continue;
      result.set(i, chosen);
      used.add(chosen);
    }
  };
  const legacy = (old: SourceMatch, next: SourceMatch) => !old.identity || !next.identity;
  match((old, next) => !!next.identity && old.identity === next.identity);
  match((old, next) => legacy(old, next) && old.exact === next.exact);
  match(
    (old, next) =>
      legacy(old, next) && old.role === next.role && !!old.name && old.name === next.name,
  );
  match(
    (old, next) =>
      legacy(old, next) &&
      old.shape === next.shape &&
      [...old.tokens].some((token) => next.tokens.has(token)),
  );
  match((old, next) => legacy(old, next) && old.shape === next.shape);
  return result;
}

/** Keep local rows in their original gaps while the provider may reorder its rows. */
export function preserveLocalRows<T extends { id: string }>(
  previous: T[],
  updated: T[],
  keep: (row: T) => T | undefined,
): T[] {
  const retained = new Set(updated.map((row) => row.id)),
    gaps = new Map<string | null, T[]>();
  let anchor: string | null = null;
  for (const row of previous) {
    if (retained.has(row.id)) {
      anchor = row.id;
      continue;
    }
    const local = keep(row);
    if (local) gaps.set(anchor, [...(gaps.get(anchor) ?? []), local]);
  }
  return [
    ...(gaps.get(null) ?? []),
    ...updated.flatMap((row) => [row, ...(gaps.get(row.id) ?? [])]),
  ];
}
