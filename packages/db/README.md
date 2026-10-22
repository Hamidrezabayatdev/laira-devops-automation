# @laira/db

Tenant-scoped persistence and data layer for the Laira DevOps automation platform.

## Architecture & Schemas

The database structure is organized strictly into isolated PostgreSQL schemas:

- `app`: Application data (users, accounts, sessions, verification tokens, workspaces, projects, connections, connection credentials, runs, run events, outbox, worker heartbeats).
- `pgboss`: Job queue persistence managed by pg-boss.
- `checkpoints`: Reserved for future durable execution graph checkpointing.

### Auth.js Compatibility & Security Contract

The `app.users`, `app.accounts`, `app.sessions`, and `app.verification_tokens` tables follow the standard Auth.js / NextAuth schema with strict security requirements:

1. **User ID Generation**:
   `app.users.id` defaults to `gen_random_uuid()::text` in SQL and `$defaultFn(() => crypto.randomUUID())` in Drizzle ORM, allowing user creation without explicit ID provision.

2. **OAuth Token Security**:
   For GitHub sign-in, repo tokens are NOT required for user authentication. The Web custom Auth.js adapter must strip `access_token` and `refresh_token` (set to `null` or omit) before persistence, OR encrypt them using `@laira/security`. Plaintext OAuth tokens must never be persisted.

## Migration CLI & Scripts

Migrations are executed transactionally using session-level advisory locking (`pg_advisory_lock(987654321)`) to guarantee safety under concurrent startup.

### Running Migrations

```bash
# Build the package
pnpm --filter @laira/db run build

# Run migrations using the CLI binary
node --env-file=.env packages/db/dist/bin/migrate.js

# Or via package script
pnpm --filter @laira/db run migrate
```

Environment variable `DATABASE_URL` (or `TEST_DATABASE_URL`) must be provided. Raw connection strings and credentials are sanitized and never exposed in logs.

## Testing

Integration tests require `TEST_DATABASE_URL` pointing to an isolated local PostgreSQL instance (e.g. `127.0.0.1:55433`).

```bash
node --env-file=.env node_modules/vitest/vitest.mjs run -c packages/db/vitest.config.ts
```
