import { expect, it } from 'vitest';
import { bundledExamples } from './examples';
import { compileRuntimeGraph } from './runtime';
import { checkCoreConfig } from '../test/coreIntegration';

it.each(bundledExamples)('$label is accepted by the packaged Xray core', (example) => {
  const result = checkCoreConfig(example.id, compileRuntimeGraph(example.create()).config);
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
