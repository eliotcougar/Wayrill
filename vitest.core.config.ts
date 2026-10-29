import config from './vitest.config.ts';

export default {
  ...config,
  test: {
    ...config.test,
    include: ['src/**/*.integration.test.ts'],
    exclude: [],
    testTimeout: 30000,
  },
};
