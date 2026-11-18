import { expect, it } from 'vitest';
import { diagnoseRuntimeGraph } from './diagnostics';
import { parseGraph, serializeGraph } from './model';
import { bundledExamples } from './examples';
import { compileRuntimeGraph } from './runtime';
import { checkCoreConfig } from '../test/coreIntegration';

it.each(bundledExamples)('$label is accepted by the packaged Xray core', (example) => {
  const graph = parseGraph(serializeGraph(example.create()));
  expect(diagnoseRuntimeGraph(graph).filter((issue) => issue.severity === 'error')).toEqual([]);
  const result = checkCoreConfig(example.id, compileRuntimeGraph(graph).config);
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
