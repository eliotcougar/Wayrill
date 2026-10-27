type Interval = [number, number];
function terms(value: string) {
  const intervals: Interval[] = [],
    invalid: string[] = [];
  for (const raw of value.split(',')) {
    const term = raw.trim();
    if (!term) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(term);
    const first = Number(match?.[1]),
      last = Number(match?.[2] ?? match?.[1]);
    if (!match || first > last || last > 65535) invalid.push(term);
    else intervals.push([first, last]);
  }
  return { intervals, invalid };
}
export function hasQuestionType(value: string, type: number): boolean {
  return terms(value).intervals.some(([first, last]) => first <= type && type <= last);
}
export function toggleQuestionType(value: string, type: number, selected: boolean): string {
  if (!Number.isInteger(type) || type < 0 || type > 65535)
    throw new Error('Invalid DNS record type');
  const { intervals, invalid } = terms(value);
  const next: Interval[] = [];
  for (const [first, last] of intervals) {
    if (selected || type < first || type > last) next.push([first, last]);
    else {
      if (first < type) next.push([first, type - 1]);
      if (last > type) next.push([type + 1, last]);
    }
  }
  if (selected) next.push([type, type]);
  next.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const range of next) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return [...merged.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)), ...invalid].join(',');
}
