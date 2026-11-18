import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config.ts';
for (const key of [
  'WAYRILL_REMOTE_TEST_CORE',
  'WAYRILL_REMOTE_TEST_CERTIFICATE',
  'WAYRILL_REMOTE_TEST_KEY',
]) {
  if (!process.env[key])
    throw new Error('Run tools/Check-AquiferCore.ps1; missing executable prerequisite: ' + key);
}
export default mergeConfig(
  base,
  defineConfig({
    test: {
      environment: 'node',
      setupFiles: ['@wayrill/ui/browserTestSetup'],
      include: ['src/**/*.integration.test.{ts,tsx}'],
    },
  }),
);
