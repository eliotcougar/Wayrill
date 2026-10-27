import { expect, it } from 'vitest';
import { testBatches } from './outboundTestJobs';
import type { TestTarget } from './outboundTestPlan';

const target = (id: string, value = ''): TestTarget => ({
  id,
  outboundTag: 'out',
  config: { value },
});
it('bounds both the service target count and complete UTF-8 request payload', () => {
  const small = Array.from({ length: 17 }, (_, i) => target(String(i)));
  expect(testBatches(small).map((batch) => batch.length)).toEqual([8, 8, 1]);
  const large = [
    target('first', 'ж'.repeat(4 * 1024 * 1024)),
    target('second', 'x'.repeat(8 * 1024 * 1024)),
  ];
  const batches = testBatches(large);
  expect(batches).toEqual([[large[0]], [large[1]]]);
  for (const batch of batches)
    expect(
      new TextEncoder().encode(
        JSON.stringify({ targets: batch, testUrl: 'https://test.example', countryUrl: '' }),
      ).length,
    ).toBeLessThan(16 * 1024 * 1024);
  expect(testBatches([])).toEqual([]);
  expect(() => testBatches([target('oversized', 'x'.repeat(16 * 1024 * 1024))])).toThrow(
    'too large',
  );
});
