import { defineConfig } from 'vitest/config';
import { mergeConfig } from 'vite';
import appConfig from './vite.config.ts';

export default mergeConfig(
  appConfig,
  defineConfig({
    test: {
      environment: 'node',
      setupFiles: ['@wayrill/ui/browserTestSetup'],
      pool: 'threads',
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: ['src/**/*.integration.test.ts'],
    },
  }),
);
