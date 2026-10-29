import { expect, it } from 'vitest';
import { intersectPredicates } from './routingPaths';

it('retains Xray protocol prefix matches across chained filters', () => {
  const a = ['http', 'tls'],
    b = ['http/1.1', 'quic'];
  const merged = intersectPredicates({ protocol: a }, { protocol: b })!;
  const protocols = ['', 'http', 'http/1.1', 'http/1.1-extra', 'http/2', 'tls', 'quic'];
  for (const protocol of protocols) {
    const expected =
      !!protocol &&
      a.some((p) => protocol.indexOf(p) === 0) &&
      b.some((p) => protocol.indexOf(p) === 0);
    const actual =
      !!protocol && (merged.protocol as string[]).some((p) => protocol.indexOf(p) === 0);
    expect(actual, protocol).toBe(expected);
  }
  expect(merged.protocol).toEqual(['http/1.1']);
});
it('rejects unrepresentable process conjunctions instead of dropping or broadening them', () => {
  expect(() => intersectPredicates({ process: ['browser'] }, { process: ['C:/Apps/'] })).toThrow(
    /name AND folder/,
  );
  expect(() => intersectPredicates({ process: ['self/'] }, { process: ['browser'] })).toThrow(
    /Runtime process/,
  );
  expect(intersectPredicates({ process: ['self/'] }, { process: ['self/'] })).toEqual({
    process: ['self/'],
  });
});
