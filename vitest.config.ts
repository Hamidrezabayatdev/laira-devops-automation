import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@laira/security': path.resolve(__dirname, 'packages/security/src/index.ts'),
      '@laira/domain': path.resolve(__dirname, 'packages/domain/src/index.ts'),
      '@laira/db': path.resolve(__dirname, 'packages/db/src/index.ts'),
      '@': path.resolve(__dirname, 'apps/web/src'),
      zod: path.resolve(__dirname, 'packages/domain/node_modules/zod'),
      pg: path.resolve(__dirname, 'packages/db/node_modules/pg'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    maxWorkers: 4,
    minWorkers: 1,
    include: [
      'packages/*/{test,tests}/**/*.test.ts',
      'apps/*/{test,tests}/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 10000,
  },
});
