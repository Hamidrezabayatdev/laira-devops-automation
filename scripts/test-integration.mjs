import { spawnSync } from 'node:child_process';
import { isIsolatedTestDatabase } from './test-database.mjs';

// Load configuration with Node's --env-file flag, but never print URLs or secrets.
// Refuse to redirect tests to the application's database or a remote service.
if (!isIsolatedTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)) {
  console.error('Integration checks require a distinct localhost database ending in _test, without query overrides.');
  process.exit(1);
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const testEnv = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
// Routine integration tests must never inherit billable provider credentials.
for (const name of ['BOX_API_KEY', 'BOXAPI_API_KEY', 'LIARA_API_TOKEN', 'AGENT_ROUTER_API_KEY', 'AUTH_GITHUB_SECRET', 'AUTH_SECRET', 'NEXTAUTH_SECRET', 'ENCRYPTION_MASTER_KEY']) {
  delete testEnv[name];
}
// These suites share one isolated database, global outbox and pg-boss queue.
// Child workers must not consume another file's direct-handler fixture jobs.
// Unit tests remain parallel; integration files run serially until each has its own DB.
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--no-file-parallelism', ...args], {
  stdio: 'inherit',
  env: testEnv,
});
if (result.error) {
  console.error('Unable to start integration test runner.');
  process.exit(1);
}
process.exit(result.status ?? 1);
