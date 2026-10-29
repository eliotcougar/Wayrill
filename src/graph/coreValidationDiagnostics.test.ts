import { expect, it } from 'vitest';
import { createTrafficExample } from './example';
import { coreResourceFailure } from './coreValidationDiagnostics';
it('does not label unrelated validation failures as resource errors', () => {
  expect(coreResourceFailure(createTrafficExample(), 'invalid TLS setting')).toBeNull();
});
