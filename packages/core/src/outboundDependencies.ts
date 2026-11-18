import { jsonArray, jsonRecord, jsonText } from './xrayJson';
import { nativeValue } from './nativeProperties';
import { outboundReferences } from './outboundReferences';

export function outboundDependencyProblems(
  config: Record<string, unknown>,
  virtualTargets: ReadonlySet<string> = new Set(),
): { tag: string; message: string }[] {
  const outputs = jsonArray(config.outbounds) ? config.outbounds.filter(jsonRecord) : [];
  const byTag = new Map(
    outputs.flatMap((output, index) => {
      const tag = nativeValue(output, 'tag');
      return typeof tag === 'string' && tag ? [[tag, index] as const] : [];
    }),
  );
  const problems: { tag: string; message: string }[] = [];
  const label = (index: number) =>
    jsonText(nativeValue(outputs[index], 'tag') ?? '') || `Outbound ${index + 1}`;
  const dependents = outputs.map(() => [] as number[]);
  const remaining = outputs.map((output, index) => {
    const targets = outboundReferences(output)
      .filter((ref) => ref.namespace === 'outbound')
      .map((ref) => ref.tag);
    let count = 0;
    for (const target of new Set(targets)) {
      const dependency = byTag.get(target);
      if (dependency !== undefined) {
        dependents[dependency].push(index);
        count++;
      } else if (!virtualTargets.has(target)) {
        problems.push({
          tag: label(index),
          message: `Dial-through destination ${target} is not defined in this configuration.`,
        });
      }
    }
    return count;
  });
  // Remove terminating paths first. Remaining nodes lead into a cycle. This
  // stays linear and avoids recursion even for very long imported chains.
  const ready = remaining.flatMap((count, index) => (count === 0 ? [index] : []));
  for (const index of ready) {
    for (const dependent of dependents[index]) {
      if (--remaining[dependent] === 0) ready.push(dependent);
    }
  }
  remaining.forEach((count, index) => {
    if (count)
      problems.push({
        tag: label(index),
        message: 'Dial-through settings lead to an outbound loop.',
      });
  });
  return problems;
}
