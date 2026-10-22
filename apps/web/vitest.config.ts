import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'zod': path.resolve(__dirname, '../../node_modules/.pnpm/zod@3.24.2/node_modules/zod'),
      'pg': path.resolve(__dirname, '../../node_modules/.pnpm/node_modules/pg'),
      'drizzle-orm': path.resolve(__dirname, '../../node_modules/.pnpm/node_modules/drizzle-orm'),
      '@laira/security': path.resolve(__dirname, '../../packages/security/src/index.ts'),
      '@laira/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
    },
  },
});
