import type { RuleTable } from './rules';

/** Rebind all materialized, baseline and override destinations as one operation. */
export function remapTrafficSource(
  table: RuleTable,
  outputs: ReadonlyMap<string, string>,
): RuleTable {
  const remap = (id: string) => outputs.get(id) ?? id;
  return {
    ...table,
    ...(table.source
      ? {
          source: {
            ...table.source,
            bindings: Object.fromEntries(
              Object.entries(table.source.bindings).map(([role, id]) => [role, remap(id)]),
            ),
          },
        }
      : {}),
    rules: table.rules.map((rule) => ({
      ...rule,
      output: remap(rule.output),
      ...(rule.source
        ? {
            source: {
              ...rule.source,
              base: { ...rule.source.base, output: remap(rule.source.base.output) },
              edits: {
                ...rule.source.edits,
                ...(rule.source.edits.fields
                  ? {
                      fields: {
                        ...rule.source.edits.fields,
                        ...(rule.source.edits.fields.output
                          ? { output: remap(rule.source.edits.fields.output) }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    })),
  };
}
