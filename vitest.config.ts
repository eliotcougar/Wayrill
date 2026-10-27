import { defineConfig } from 'vitest/config';
import { mergeConfig } from 'vite';
import appConfig from './vite.config.ts';

export default mergeConfig(
  appConfig,
  defineConfig({
    test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
  }),
);
