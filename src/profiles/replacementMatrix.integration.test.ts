import { expect, it } from 'vitest';
import { compileRuntimeGraph } from '../graph/runtime';
import { checkCoreConfig } from '../test/coreIntegration';
import { replacementCases } from './replacementMatrix.fixture';

for (const { label, candidate } of replacementCases) {
  it(label + ' passes the pinned Xray configuration parser', () => {
    const result = checkCoreConfig('replacement-' + label, compileRuntimeGraph(candidate()).config);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}
