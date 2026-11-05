import { compactSelectors as compact } from '@wayrill/core/prefixSelectors';
export { prefixMatches } from '@wayrill/core/prefixSelectors';
export const compactSelectors = (selected: readonly string[], all: readonly string[]) =>
  compact(selected, all, ['wt-']);
