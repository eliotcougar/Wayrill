export function portRangesOverlap(a: string, b: string): boolean {
  if (portRangeProblem(a) || portRangeProblem(b)) return false;
  const ranges = (value: string) =>
    value
      .split(',')
      .filter((v) => v.trim())
      .map((term) => {
        const [first, last = first] = term.trim().split('-').map(Number);
        return [first, last];
      });
  return ranges(a).some(([a1, a2]) => ranges(b).some(([b1, b2]) => a1 <= b2 && b1 <= a2));
}
export function portRangeProblem(value: string, min = 1): string | null {
  if (!value.trim()) return null;
  for (const entry of value.split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(entry.trim())) return 'Use comma-separated numbers or ranges.';
    const [first, last = first] = entry.trim().split('-').map(Number);
    if (first < min || last > 65535 || first > last)
      return `Values must be ${min}–65535 and ranges must ascend.`;
  }
  return null;
}
