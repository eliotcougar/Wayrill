// Xray matches outbound tags by prefix. Sorted exclusions let us preserve an
// exact set without checking every selected tag against every other outbound.
export function prefixMatches(sorted: readonly string[], prefix: string): boolean {
  let low = 0,
    high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  return low < sorted.length && sorted[low].startsWith(prefix);
}

export function compactSelectors(selected: readonly string[], all: readonly string[]): string[] {
  const members = new Set(selected);
  const excluded = [...all.filter((tag) => !members.has(tag)), 'wayrill-telemetry-'].sort();
  const prefixes = new Set<string>();
  for (const tag of members) {
    let prefix = '';
    // Prefixes must end at a Unicode code point, never half an emoji surrogate.
    for (const character of tag) {
      prefix += character;
      if (!prefixMatches(excluded, prefix)) break;
    }
    if (!prefix || prefixMatches(excluded, prefix))
      throw new Error(`Outbound tag ${tag} cannot select an exact member set.`);
    prefixes.add(prefix);
  }
  const result: string[] = [];
  for (const prefix of [...prefixes].sort()) {
    if (!result.length || !prefix.startsWith(result.at(-1)!)) result.push(prefix);
  }
  return result;
}
