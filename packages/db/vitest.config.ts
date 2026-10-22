import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      'pg': path.resolve(__dirname, '../../node_modules/.pnpm/node_modules/pg'),
      '@laira/security': path.resolve(__dirname, '../security/src/index.ts'),
      '@laira/db': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
  },
});
