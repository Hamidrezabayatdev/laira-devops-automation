# @laira/worker

Persistent background worker daemon and queue consumer for the Laira DevOps automation platform.

## Architecture & Responsibilities

The worker daemon runs as an independent long-running process separated from the web app:

1. **Heartbeat Manager (`src/heartbeat.ts`)**:
   Periodically updates `app.worker_heartbeats` with host, PID, and alive/stopped status. On graceful shutdown (`SIGTERM`/`SIGINT`), transitions status to `stopped`.

2. **Outbox Poller (`src/outbox-poller.ts`)**:
   Polls `app.outbox` using `FOR UPDATE SKIP LOCKED`.
   - **Crash Recovery**: Automatically re-claims items left in `claimed` state if the previous worker crashed (`claimed_at < NOW() - 30s`).
   - **Deduplication**: Enqueues to pg-boss with a stable `singletonKey: "outbox_<id>"`, preventing duplicate executions if a crash occurs after queue dispatch but before marking dispatched.

3. **Lease Fencing & Fixture Execution (`src/handlers/demo-fixture.ts`)**:
   - Resolves tenant and workspace identity strictly from verified DB run rows, never from untrusted message payloads.
   - Claims runs atomically with heartbeat-based lease expiration (30 seconds).
   - Enforces fencing (`FencingError`): if a worker stalls and another worker takes over the lease, the stale worker is fenced out from appending events or marking completion.
   - All run events enforce strict monotonic sequence numbers (`seq: 1, 2, 3...`) and schema validation.
   - Executes in read-only mode in Phase 0; live provider mutations are strictly prohibited.

## Worker Startup Commands

```bash
# Build the worker package
pnpm --filter @laira/worker run build

# Start the worker daemon
node --env-file=.env apps/worker/dist/index.js

# Or via package script
pnpm --filter @laira/worker run start
```

## Material Testing Scope & Limitations

- **Simulated Recovery vs Actual Process Restart**:
  - Automated tests simulate worker crash recovery by advancing timestamps in the database (`heartbeat_at = NOW() - INTERVAL '60 seconds'`) and verifying that a replacement worker takes over the run, reclaims outbox items, and fences out stale workers.
  - An actual OS process crash and restart lifecycle test requires `pg-boss` and workspace packages to be linked via root `pnpm install` (which is managed by the root workspace orchestrator; lockfile edits were avoided).
- All 7 worker integration tests pass cleanly against isolated test PostgreSQL `127.0.0.1:55433`.
