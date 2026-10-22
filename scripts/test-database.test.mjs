import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIsolatedTestDatabase } from './test-database.mjs';

test('isolated test DB requires explicit local test URL and no override', () => {
  const app = 'postgres://fixture:synthetic@localhost:55433/laira';
  assert.equal(isIsolatedTestDatabase('postgres://fixture:synthetic@localhost:55433/laira_test', app), true);
  assert.equal(isIsolatedTestDatabase('postgresql://fixture:synthetic@[::1]:55433/laira_test', app), true);
  for (const url of [undefined, '', app, 'postgres://localhost/contest', 'postgres://remote.example/laira_test', 'https://localhost/laira_test', 'postgres://localhost/laira_test?host=remote.example', 'postgres://localhost/laira_test#fragment']) {
    assert.equal(isIsolatedTestDatabase(url, app), false);
  }
  assert.equal(isIsolatedTestDatabase(app + '_test', app + '_test'), false);
  assert.equal(isIsolatedTestDatabase('postgres://other@127.0.0.1:55433/laira_test', 'postgres://fixture@localhost:55433/laira_test'), false);
  assert.equal(isIsolatedTestDatabase('postgres://localhost/laira_test', 'postgres://other@127.0.0.1:5432/laira_test'), false);
});
