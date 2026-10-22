import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 10_000,
  },
});
