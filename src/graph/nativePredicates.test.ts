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
it('preserves equivalent names and narrows compatible process paths/folders', () => {
  expect(intersectPredicates({ process: ['browser'] }, { process: ['browser.exe'] })).toEqual({
    process: ['browser'],
  });
  expect(
    intersectPredicates({ process: ['browser.exe'] }, { process: ['C:/Apps/browser.exe'] }),
  ).toEqual({ process: ['C:/Apps/browser.exe'] });
  expect(
    intersectPredicates({ process: ['C:/Apps/'] }, { process: ['C:/Apps/browser.exe'] }),
  ).toEqual({ process: ['C:/Apps/browser.exe'] });
  expect(intersectPredicates({ process: ['C:/Apps/'] }, { process: ['C:/Apps/Tools/'] })).toEqual({
    process: ['C:/Apps/Tools/'],
  });
  expect(
    intersectPredicates(
      { process: ['C:/Apps/browser.exe'] },
      { process: ['C:\\Apps\\browser.exe'] },
    ),
  ).toEqual({ process: ['C:/Apps/browser.exe'] });
  expect(intersectPredicates({ process: ['browser'] }, { process: ['other.exe'] })).toBeNull();
  // Preserve upstream's case sensitivity for process matching.
  expect(intersectPredicates({ process: ['browser'] }, { process: ['Browser.exe'] })).toBeNull();
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
it('intersects local OS names using Xray case-insensitive semantics', () => {
  expect(intersectPredicates({ localOS: ['Windows', 'linux'] }, { localOS: ['windows'] })).toEqual({
    localOS: ['Windows'],
  });
});
