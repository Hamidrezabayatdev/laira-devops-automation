import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import {
  createRun,
  getRun,
  getRunEvents,
  getOrCreateOwnerWorkspace,
  claimRunForExecution,
  appendRunEvent,
  completeRun,
  updateRunHeartbeat,
  FencingError,
  claimOutboxBatch,
  markOutboxDispatched,
  markOutboxFailed,
} from '@laira/db';
import { runMigrations } from '../../../packages/db/src/migrator.js';
import { executeDemoFixtureRun } from '../src/handlers/demo-fixture.js';
import { WorkerHeartbeatManager } from '../src/heartbeat.js';
import { OutboxPoller, BossDispatcher, BossSendOptions, safeErrorMessage } from '../src/outbox-poller.js';
import { parseBoundedPositiveInt, parseBoundedNonNegativeInt, loadWorkerConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbUrl = process.env.TEST_DATABASE_URL;

export interface ChildTerminationResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Robust child process cleanup helper.
 * Drains stdout/stderr streams to prevent process pipe buffer deadlocks,
 * sends SIGTERM with fallback to SIGKILL, and awaits terminal process exit.
 */
async function safelyTerminateChild(
  child: ChildProcess,
  timeoutMs = 4000
): Promise<ChildTerminationResult> {
  // Ensure streams are flowing
  child.stdout?.resume();
  child.stderr?.resume();

  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise<ChildTerminationResult>((resolve) => {
    let settled = false;

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal });
      }
    };

    child.once('exit', onExit);

    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, timeoutMs);

    try {
      child.kill('SIGTERM');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  });
}

describe('Worker Fixture Handler & Recovery Tests', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping Worker integration tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
    const queueTable = await pool.query(`SELECT to_regclass('pgboss.job') AS name`);
    if (queueTable.rows[0]?.name) {
      await pool.query(`DELETE FROM pgboss.job WHERE name = 'run.execute'`);
    }
  });

  afterEach(async () => {
    if (pool && trackedWorkspaceIds.size > 0) {
      const ids = Array.from(trackedWorkspaceIds);
      await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
    }
  });

  afterAll(async () => {
    if (pool) {
      if (trackedWorkspaceIds.size > 0) {
        const ids = Array.from(trackedWorkspaceIds);
        await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
      }
      await pool.end();
    }
  });

  it('safely maps errors to static categorized text without leaking canaries or raw messages', () => {
    const canaryError = new Error('postgres://app_user:secret_password@10.0.0.1/prod_db canary_leak_token_999');
    expect(safeErrorMessage(canaryError)).toBe('Database operation failed with internal error');
    expect(safeErrorMessage(canaryError)).not.toContain('canary');
    expect(safeErrorMessage(canaryError)).not.toContain('secret_password');

    const fencingError = new FencingError('Worker A lost lease to Worker B');
    expect(safeErrorMessage(fencingError)).toBe(
      'Operation rejected: worker claim lease conflict (fenced out)'
    );

    const zodLikeError = { name: 'ZodError', issues: [] };
    expect(safeErrorMessage(zodLikeError)).toBe(
      'Validation failure: payload does not match schema'
    );

    expect(safeErrorMessage(null)).toBe('Unknown error occurred');
    expect(safeErrorMessage(undefined)).toBe('Unknown error occurred');
  });

  it.skipIf(!testDbUrl)(
    'executes demo fixture run, resolves workspace from DB, emits monotonic events, and marks success',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Worker Test Owner' },
        githubUserId: `gh_worker_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
        input: { target: 'liara-app' },
      });

      // Execute worker handler
      const result = await executeDemoFixtureRun(pool, 'worker-unit-1', run.id);
      expect(result.run.status).toBe('succeeded');
      expect(result.eventsEmitted).toBe(4);

      // Check DB run state
      const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
      expect(checkRun?.status).toBe('succeeded');
      expect(checkRun?.output).toMatchObject({
        mode: 'read_only_fixture',
        status: 'verified',
        providerMutations: 0,
      });

      // Check all persisted events have monotonic sequence numbers
      const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
      expect(events.length).toBe(5);
      for (let i = 0; i < events.length; i++) {
        expect(events[i].seq).toBe(i + 1);
      }

      expect(events[0].type).toBe('run_started');
      expect(events[1].type).toBe('step_progress');
      expect(events[2].type).toBe('fixture_inspection');
      expect(events[3].type).toBe('step_completed');
      expect(events[4].type).toBe('run_succeeded');
    }
  );

  it.skipIf(!testDbUrl)(
    'tolerates duplicate dispatch idempotently without re-emitting duplicated events',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Idempotency Owner' },
        githubUserId: `gh_idempotent_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // First delivery
      await executeDemoFixtureRun(pool, 'worker-1', run.id);

      // Redelivery (e.g. pg-boss redelivering message)
      const redeliveredResult = await executeDemoFixtureRun(pool, 'worker-2', run.id);
      expect(redeliveredResult.run.status).toBe('succeeded');
      expect(redeliveredResult.eventsEmitted).toBe(0);

      const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
      expect(events.length).toBe(5);
    }
  );

  it.skipIf(!testDbUrl)(
    'recovers running job after simulated worker crash with expired lease without corrupting sequence',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Crash Recovery Owner' },
        githubUserId: `gh_crash_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // Simulate partial execution before worker crash:
      // Claim run and append only step_progress (seq 2) with expired lease
      await pool.query(
        `UPDATE app.runs SET status = 'running', claimed_by = 'crashed_worker', heartbeat_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`,
        [run.id]
      );
      await pool.query(
        `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
         VALUES ($1, $2, $3, 2, 'step_progress', '{"step":"discovery","progress":30,"message":"partial"}'::jsonb, NOW())`,
        [`evt_${crypto.randomUUID().replace(/-/g, '')}`, workspace.id, run.id]
      );

      // New worker restarts and resumes run
      const recoveryResult = await executeDemoFixtureRun(pool, 'recovered_worker', run.id);
      expect(recoveryResult.run.status).toBe('succeeded');
      expect(recoveryResult.recovered).toBe(true);

      // Check all events are orderly and monotonically sequential
      const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(events.find((e) => e.type === 'fixture_inspection')).toBeDefined();
      expect(events.find((e) => e.type === 'run_succeeded')).toBeDefined();
    }
  );

  it.skipIf(!testDbUrl)(
    'fences out stale workers from appending events or completing runs after takeover',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Fencing Owner' },
        githubUserId: `gh_fence_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // Worker 1 claims run
      const claim1 = await claimRunForExecution(pool, 'worker-fence-1', run.id);
      expect(claim1).not.toBeNull();
      expect(claim1?.claimedBy).toBe('worker-fence-1');

      // Worker 2 attempts to claim while Worker 1 has active lease -> fails
      const claim2Denied = await claimRunForExecution(pool, 'worker-fence-2', run.id, 30);
      expect(claim2Denied).toBeNull();

      // Simulate Worker 1 stalling: heartbeat expires
      await pool.query(
        `UPDATE app.runs SET heartbeat_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`,
        [run.id]
      );

      // Worker 2 takes over the expired lease
      const claim2Allowed = await claimRunForExecution(pool, 'worker-fence-2', run.id, 30);
      expect(claim2Allowed).not.toBeNull();
      expect(claim2Allowed?.claimedBy).toBe('worker-fence-2');

      // Stale Worker 1 wakes up and attempts to append event -> throws FencingError!
      await expect(
        appendRunEvent(pool, 'worker-fence-1', run.id, {
          type: 'step_progress',
          payload: { step: 'stale_worker', progress: 50, message: 'stale attempt' },
        })
      ).rejects.toThrow(FencingError);

      // Stale Worker 1 attempts to complete run -> throws FencingError!
      await expect(
        completeRun(pool, 'worker-fence-1', run.id, { result: 'stale' })
      ).rejects.toThrow(FencingError);

      // Stale Worker 1 attempts to update heartbeat -> throws FencingError!
      await expect(
        updateRunHeartbeat(pool, 'worker-fence-1', run.id)
      ).rejects.toThrow(FencingError);

      // Worker 2 can legitimately update heartbeat
      await expect(
        updateRunHeartbeat(pool, 'worker-fence-2', run.id)
      ).resolves.toBeUndefined();

      // Worker 2 can legitimately append event and complete run
      const validEvent = await appendRunEvent(pool, 'worker-fence-2', run.id, {
        type: 'step_progress',
        payload: { step: 'active_worker', progress: 50, message: 'valid progress' },
      });
      expect(validEvent.seq).toBe(2);

      const completed = await completeRun(pool, 'worker-fence-2', run.id, { outcome: 'ok' });
      expect(completed.status).toBe('succeeded');
    }
  );

  it.skipIf(!testDbUrl)(
    'reclaims stale outbox items abandoned by crashed workers',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Outbox Recovery Owner' },
        githubUserId: `gh_outbox_rec_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const outboxId = `outbox_crash_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, claimed_by, claimed_at, created_at, updated_at)
         VALUES ($1, $2, 'run.dispatched', '{"runId":"run_mock_1"}'::jsonb, 'claimed', 'crashed_worker', NOW() - INTERVAL '45 seconds', NOW() - INTERVAL '100 days', NOW())`,
        [outboxId, workspace.id]
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await claimOutboxBatch(client, 'recovery_worker', 100, 30);
        const reclaimed = claimed.find((item) => item.id === outboxId);
        expect(reclaimed).toBeDefined();
        expect(reclaimed?.claimedBy).toBe('recovery_worker');
        await client.query('ROLLBACK');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
        await pool.query(`DELETE FROM app.outbox WHERE id = $1`, [outboxId]);
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'deduplicates outbox dispatches via stable outbox-based job singletonKey',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Dedup Owner' },
        githubUserId: `gh_dedup_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const outboxId = `outbox_dedup_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, created_at, updated_at)
         VALUES ($1, $2, 'run.dispatched', '{"runId":"run_mock_dedup"}'::jsonb, 'pending', NOW(), NOW())`,
        [outboxId, workspace.id]
      );

      const dispatchedCalls: { name: string; data: object; options?: BossSendOptions }[] = [];
      const mockBoss: BossDispatcher = {
        send: async (name, data, options) => {
          dispatchedCalls.push({ name, data, options });
          return 'job_123';
        },
      };

      const poller = new OutboxPoller(
        pool,
        {
          databaseUrl: testDbUrl!,
          workerId: 'dedup_poller_worker',
          hostname: 'test-host',
          pid: process.pid,
          heartbeatIntervalMs: 5000,
          outboxIntervalMs: 1000,
          pgbossSchema: 'pgboss',
          runLeaseTimeoutSeconds: 30,
          pgbossExpireSeconds: 300,
          fixtureStepDelayMs: 0,
        },
        mockBoss
      );

      try {
        const count = await poller.pollOnce();
        expect(count).toBeGreaterThanOrEqual(1);

        const dispatchCall = dispatchedCalls.find(
          (c) => (c.data as Record<string, unknown>).outboxId === outboxId
        );
        expect(dispatchCall).toBeDefined();
        expect(dispatchCall?.options?.singletonKey).toBe(`outbox_${outboxId}`);
      } finally {
        await pool.query(`DELETE FROM app.outbox WHERE id = $1`, [outboxId]);
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'records worker heartbeats and transitions status cleanly during shutdown',
    async () => {
      const workerId = `test_worker_${Date.now()}`;
      const heartbeat = new WorkerHeartbeatManager(pool, {
        databaseUrl: testDbUrl!,
        workerId,
        hostname: 'test-host',
        pid: 1234,
        heartbeatIntervalMs: 5000,
        outboxIntervalMs: 1000,
        pgbossSchema: 'pgboss',
        runLeaseTimeoutSeconds: 30,
        pgbossExpireSeconds: 300,
        fixtureStepDelayMs: 0,
      });

      await heartbeat.start();

      const hbRow1 = await pool.query(
        `SELECT * FROM app.worker_heartbeats WHERE worker_id = $1`,
        [workerId]
      );
      expect(hbRow1.rows.length).toBe(1);
      expect(hbRow1.rows[0].status).toBe('alive');

      await heartbeat.stop();

      const hbRow2 = await pool.query(
        `SELECT * FROM app.worker_heartbeats WHERE worker_id = $1`,
        [workerId]
      );
      expect(hbRow2.rows[0].status).toBe('stopped');
    }
  );

  it.skipIf(!testDbUrl)(
    'persists queue run while worker is offline and executes durably on child worker process startup',
    async () => {
      const workerScriptPath = path.resolve(__dirname, '../dist/index.js');
      const uniqueWorkerId = `real_proc_offline_${Date.now()}`;
      let child: ChildProcess | null = null;

      let testError: unknown = null;
      try {
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Offline Queue Owner' },
          githubUserId: `gh_proc_offline_${Date.now()}`,
        });
        trackedWorkspaceIds.add(workspace.id);

        // 1. Enqueue run in DB + outbox while worker process is NOT running
        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'demo_fixture',
          input: { target: 'liara-app' },
        });

        const checkInitial = await getRun(pool, { workspaceId: workspace.id }, run.id);
        expect(checkInitial?.status).toBe('queued');

        // 2. Start real child worker process with stream draining
        let childStarted = false;
        let childOperational = false;
        child = spawn(process.execPath, [workerScriptPath], {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            WORKER_ID: uniqueWorkerId,
            DATABASE_URL: testDbUrl!, // Isolated test database ONLY
            TEST_FIXTURE_STEP_DELAY_MS: '0',
            OUTBOX_INTERVAL_MS: '100',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout?.on('data', (d) => {
          const str = d.toString();
          if (str.includes('Starting')) childStarted = true;
          if (str.includes('Worker fully operational')) childOperational = true;
        });
        child.stdout?.resume();
        child.stderr?.resume();

        // 3. Poll until child worker picks up from outbox, executes via pg-boss, and marks succeeded
        let terminalStatus = '';
        let lastStatus = '';
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const check = await getRun(pool, { workspaceId: workspace.id }, run.id);
          if (check) {
            lastStatus = check.status;
            if (check.status === 'succeeded' || check.status === 'failed') {
              terminalStatus = check.status;
              break;
            }
          }
        }

        if (terminalStatus !== 'succeeded') {
          const outboxRes = await pool.query(
            `SELECT status, (claimed_by IS NOT NULL) AS is_claimed FROM app.outbox WHERE payload->>'runId' = $1`,
            [run.id]
          );
          console.error(
            `[diagnostic] offline child test failed: targetStatus=${lastStatus}, outboxStatus=${outboxRes.rows[0]?.status ?? 'missing'}, isClaimed=${outboxRes.rows[0]?.is_claimed ?? false}, childStarted=${childStarted}, childOperational=${childOperational}, childExitCode=${child.exitCode}, childSignal=${child.signalCode}`
          );
        }

        expect(terminalStatus).toBe('succeeded');

        // 4. Verify monotonic sequence of events and single terminal outcome
        const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
        expect(events.length).toBe(5);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(events[0].type).toBe('run_started');
        expect(events[1].type).toBe('step_progress');
        expect(events[2].type).toBe('fixture_inspection');
        expect(events[3].type).toBe('step_completed');
        expect(events[4].type).toBe('run_succeeded');
      } catch (err) {
        testError = err;
        throw err;
      } finally {
        if (child) {
          const term = await safelyTerminateChild(child);
          if (!testError) {
            expect(term.code).toBe(0);

            const hb = await pool.query(
              `SELECT status FROM app.worker_heartbeats WHERE worker_id = $1`,
              [uniqueWorkerId]
            );
            expect(hb.rows.length).toBe(1);
            expect(hb.rows[0].status).toBe('stopped');
          }
        }
      }
    },
    20000
  );

  it.skipIf(!testDbUrl)(
    'automatically recovers and completes run across worker crash via real pg-boss supervisor expiry sweep without direct DB job manipulation',
    async () => {
      const workerScriptPath = path.resolve(__dirname, '../dist/index.js');
      const workerIdA = `real_proc_A_${Date.now()}`;
      const workerIdB = `real_proc_B_${Date.now()}`;
      let childA: ChildProcess | null = null;
      let childB: ChildProcess | null = null;

      let testError: unknown = null;
      const phaseMilestonesB: string[] = [];
      try {
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Auto Recovery Owner' },
          githubUserId: `gh_auto_proc_${Date.now()}`,
        });
        trackedWorkspaceIds.add(workspace.id);

        // 1. Spawn Worker A configured with:
        // - Fast job expiry (PGBOSS_EXPIRE_SECONDS=2)
        // - Fast supervisor sweep (PGBOSS_SUPERVISE_INTERVAL_SECONDS=1)
        // - Fast run lease timeout (RUN_LEASE_TIMEOUT_SECONDS=2)
        // - Controlled test step delay (TEST_FIXTURE_STEP_DELAY_MS=2000) so we can kill it mid-run
        childA = spawn(process.execPath, [workerScriptPath], {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            WORKER_ID: workerIdA,
            DATABASE_URL: testDbUrl!,
            PGBOSS_EXPIRE_SECONDS: '2',
            PGBOSS_SUPERVISE_INTERVAL_SECONDS: '1',
            RUN_LEASE_TIMEOUT_SECONDS: '2',
            OUTBOX_INTERVAL_MS: '100',
            TEST_FIXTURE_STEP_DELAY_MS: '2000',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        childA.stdout?.resume();
        childA.stderr?.resume();

        // Wait for Worker A to establish alive heartbeat (confirming operational readiness)
        let workerAAlive = false;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const res = await pool.query(
            `SELECT status FROM app.worker_heartbeats WHERE worker_id = $1`,
            [workerIdA]
          );
          if (res.rows.length > 0 && res.rows[0].status === 'alive') {
            workerAAlive = true;
            break;
          }
        }
        expect(workerAAlive).toBe(true);

        // 2. Create run in DB with outbox dispatch
        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'demo_fixture',
          input: { target: 'liara-app' },
        });

        // Wait for Worker A to start executing and emit partial step_progress (seq 2)
        let stepProgressEmitted = false;
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const evts = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
          if (evts.some((e) => e.type === 'step_progress')) {
            stepProgressEmitted = true;
            break;
          }
        }
        if (!stepProgressEmitted) {
          const state = await pool.query(
            `SELECT r.status AS run_status, o.status AS outbox_status,
                    j.state AS job_state, j.retry_count
             FROM app.runs r
             LEFT JOIN app.outbox o ON o.payload->>'runId' = r.id
             LEFT JOIN pgboss.job j ON j.data->>'runId' = r.id AND j.name = 'run.execute'
             WHERE r.id = $1`, [run.id]
          );
          console.error('[diagnostic] crash-test precondition:', JSON.stringify(state.rows));
        }
        expect(stepProgressEmitted).toBe(true);

        // 3. Forcefully kill Worker A mid-execution (SIGKILL)
        childA.kill('SIGKILL');
        await new Promise<void>((resolve) => {
          childA?.once('exit', () => resolve());
        });

        // Verify run was left in partial running state
        const midEvents = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
        expect(midEvents.length).toBeLessThan(5);

        // 4. Wait real TTL (2.2s) so Worker A's heartbeat lease naturally expires without manual SQL edits
        await new Promise((r) => setTimeout(r, 2200));

        // NOTE: We do NOT manually touch or modify pgboss.job or app.runs!
        // Instead, Worker B starts with superviseIntervalSeconds=1,
        // which automatically detects the expired active job from dead Worker A,
        // expires it, and re-queues it for retry via pg-boss's built-in supervisor!
        // Worker B's claimRunForExecution then acquires the expired lease naturally.

        // 5. Spawn Worker Process B
        childB = spawn(process.execPath, [workerScriptPath], {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            WORKER_ID: workerIdB,
            DATABASE_URL: testDbUrl!,
            PGBOSS_EXPIRE_SECONDS: '2',
            PGBOSS_SUPERVISE_INTERVAL_SECONDS: '1',
            RUN_LEASE_TIMEOUT_SECONDS: '2',
            OUTBOX_INTERVAL_MS: '100',
            TEST_FIXTURE_STEP_DELAY_MS: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        childB.stdout?.on('data', (d) => {
          const str = d.toString();
          if (str.includes('Starting')) phaseMilestonesB.push('starting');
          if (str.includes('Worker fully operational')) phaseMilestonesB.push('operational');
          if (str.includes('Graceful shutdown complete')) phaseMilestonesB.push('shutdown_complete');
        });
        childB.stdout?.resume();
        childB.stderr?.resume();

        // Wait for Worker B to establish alive heartbeat (confirming operational readiness)
        let workerBAlive = false;
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const res = await pool.query(
            `SELECT status FROM app.worker_heartbeats WHERE worker_id = $1`,
            [workerIdB]
          );
          if (res.rows.length > 0 && res.rows[0].status === 'alive') {
            workerBAlive = true;
            break;
          }
        }
        expect(workerBAlive).toBe(true);

        // 6. Poll until pg-boss supervisor expires Worker A's abandoned job,
        // retries it, and Worker B takes over and drives the run to terminal 'succeeded'
        let finalRunStatus = '';
        for (let i = 0; i < 70; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const check = await getRun(pool, { workspaceId: workspace.id }, run.id);
          if (check && (check.status === 'succeeded' || check.status === 'failed')) {
            finalRunStatus = check.status;
            break;
          }
        }

        expect(finalRunStatus).toBe('succeeded');

        // 7. Verify monotonic sequence of events and single terminal outcome
        const finalEvents = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
        expect(finalEvents.length).toBe(5);
        expect(finalEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(finalEvents[0].type).toBe('run_started');
        expect(finalEvents[1].type).toBe('step_progress');
        expect(finalEvents[2].type).toBe('fixture_inspection');
        expect(finalEvents[3].type).toBe('step_completed');
        expect(finalEvents[4].type).toBe('run_succeeded');
      } catch (err) {
        testError = err;
        throw err;
      } finally {
        if (childA) {
          await safelyTerminateChild(childA);
        }
        if (childB) {
          const termB = await safelyTerminateChild(childB);
          if (!testError) {
            expect(termB.code).toBe(0);

            const hbB = await pool.query(
              `SELECT status FROM app.worker_heartbeats WHERE worker_id = $1`,
              [workerIdB]
            );
            expect(hbB.rows.length).toBe(1);
            expect(hbB.rows[0].status).toBe('stopped');
          }
        }
      }
    },
    30000
  );

  it('validates WorkerConfig numeric environment variables with finite positive bounded integers', () => {
    expect(parseBoundedPositiveInt('invalid', 30)).toBe(30);
    expect(parseBoundedPositiveInt('NaN', 30)).toBe(30);
    expect(parseBoundedPositiveInt('-5', 30)).toBe(30);
    expect(parseBoundedPositiveInt('0', 30)).toBe(30);
    expect(parseBoundedPositiveInt('3.14', 30)).toBe(30);
    expect(parseBoundedPositiveInt('', 30)).toBe(30);
    expect(parseBoundedPositiveInt(undefined, 30)).toBe(30);
    expect(parseBoundedPositiveInt('2', 30)).toBe(2);
    expect(parseBoundedPositiveInt('500', 30, { min: 1, max: 100 })).toBe(100);
    expect(parseBoundedPositiveInt('0', 30, { min: 5, max: 100 })).toBe(30);

    expect(parseBoundedNonNegativeInt('invalid', 0)).toBe(0);
    expect(parseBoundedNonNegativeInt('-1', 0)).toBe(0);
    expect(parseBoundedNonNegativeInt('0', 10)).toBe(0);
    expect(parseBoundedNonNegativeInt('2500', 0)).toBe(2500);

    const prevEnv = { ...process.env };
    try {
      process.env.HEARTBEAT_INTERVAL_MS = 'not-a-number';
      process.env.OUTBOX_INTERVAL_MS = '-100';
      process.env.RUN_LEASE_TIMEOUT_SECONDS = 'NaN';
      process.env.PGBOSS_EXPIRE_SECONDS = '0';
      process.env.PGBOSS_SUPERVISE_INTERVAL_SECONDS = 'invalid';
      process.env.TEST_FIXTURE_STEP_DELAY_MS = 'bad';

      const config = loadWorkerConfig();
      expect(config.heartbeatIntervalMs).toBe(10000);
      expect(config.outboxIntervalMs).toBe(1000);
      expect(config.runLeaseTimeoutSeconds).toBe(30);
      expect(config.pgbossExpireSeconds).toBe(300);
      expect(config.pgbossSuperviseIntervalSeconds).toBeUndefined();
      expect(config.fixtureStepDelayMs).toBe(0);
    } finally {
      process.env = prevEnv;
    }
  });

  it('handles connect failure, claim failure, and mark failure without wedging outbox poller, and awaits in-flight poll on stop', async () => {
    const errorLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map(String).join(' '));
    };

    const canarySecret = 'CANARY_SECRET_NEVER_LEAK_12345';
    let connectFails = false;
    let claimFails = false;
    let markDispatchedFails = false;
    let simulatedPollDelayMs = 0;

    let rollbackCalled = false;
    let clientReleased = false;
    let currentBatch: any[] = [];

    const fakeClient = {
      query: async (queryText: string) => {
        if (queryText === 'BEGIN') {
          if (claimFails) {
            throw new Error(`BEGIN failed with canary: ${canarySecret}`);
          }
          return { rows: [] };
        }
        if (queryText === 'COMMIT') {
          return { rows: [] };
        }
        if (queryText === 'ROLLBACK') {
          rollbackCalled = true;
          return { rows: [] };
        }
        // claimOutboxBatch query
        if (typeof queryText === 'string' && queryText.includes('app.outbox')) {
          if (claimFails) {
            throw new Error(`claim query failed with canary: ${canarySecret}`);
          }
          return { rows: currentBatch };
        }
        return { rows: [] };
      },
      release: () => {
        clientReleased = true;
      },
    };

    let markDispatchedErrorInjected = false;
    const fakePool = {
      connect: async () => {
        clientReleased = false;
        rollbackCalled = false;
        if (connectFails) {
          throw new Error(`Connection refused with canary: ${canarySecret}`);
        }
        return fakeClient as unknown as pg.PoolClient;
      },
      query: async (queryText: string, params?: unknown[]) => {
        const normalized = typeof queryText === 'string' ? queryText.replace(/\s+/g, ' ') : '';
        if (normalized.includes("UPDATE app.outbox SET status = 'dispatched'")) {
          if (markDispatchedFails) {
            markDispatchedErrorInjected = true;
            throw new Error(`Mark dispatched query failed with canary: ${canarySecret}`);
          }
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const dispatched: any[] = [];
    const fakeBoss: BossDispatcher = {
      send: async (name, data, options) => {
        if (simulatedPollDelayMs > 0) {
          await new Promise((r) => setTimeout(r, simulatedPollDelayMs));
        }
        dispatched.push({ name, data, options });
        return 'job_fake_1';
      },
    };

    const poller = new OutboxPoller(
      fakePool,
      {
        databaseUrl: 'postgres://localhost/fake',
        workerId: 'test_robust_poller',
        hostname: 'test-host',
        pid: 1,
        heartbeatIntervalMs: 5000,
        outboxIntervalMs: 1000,
        pgbossSchema: 'pgboss',
        runLeaseTimeoutSeconds: 30,
        pgbossExpireSeconds: 300,
        fixtureStepDelayMs: 0,
      },
      fakeBoss
    );

    try {
      // 1. Connect failure
      connectFails = true;
      const count1 = await poller.pollOnce();
      expect(count1).toBe(0);

      // Verify no leak of canary secret in logs
      for (const log of errorLogs) {
        expect(log).not.toContain(canarySecret);
      }

      // 2. Claim query failure (recovers from connect failure, does not wedge!)
      connectFails = false;
      claimFails = true;
      const count2 = await poller.pollOnce();
      expect(count2).toBe(0);
      expect(rollbackCalled).toBe(true);
      expect(clientReleased).toBe(true);

      for (const log of errorLogs) {
        expect(log).not.toContain(canarySecret);
      }

      // 3. Mark failure (dispatches, mark throws, does not wedge!)
      claimFails = false;
      markDispatchedFails = true;
      currentBatch = [
        {
          id: 'outbox_mark_fail_1',
          workspace_id: 'ws_fake',
          topic: 'run.dispatched',
          payload: { runId: 'run_mark_fail' },
          status: 'claimed',
          claimed_by: 'test_robust_poller',
          claimed_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      const count3 = await poller.pollOnce();
      expect(count3).toBe(1);
      expect(markDispatchedErrorInjected).toBe(true);

      for (const log of errorLogs) {
        expect(log).not.toContain(canarySecret);
      }

      // 4. Subsequent poll works cleanly when working!
      markDispatchedFails = false;
      currentBatch = [
        {
          id: 'outbox_clean_1',
          workspace_id: 'ws_fake',
          topic: 'run.dispatched',
          payload: { runId: 'run_clean' },
          status: 'claimed',
          claimed_by: 'test_robust_poller',
          claimed_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      const count4 = await poller.pollOnce();
      expect(count4).toBe(1);
      expect(dispatched.some((d) => (d.data as any).runId === 'run_clean')).toBe(true);

      // 5. stop() during pending poll awaits completion
      simulatedPollDelayMs = 150;
      currentBatch = [
        {
          id: 'outbox_delay_1',
          workspace_id: 'ws_fake',
          topic: 'run.dispatched',
          payload: { runId: 'run_delayed' },
          status: 'claimed',
          claimed_by: 'test_robust_poller',
          claimed_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      let pollFinished = false;
      const pollPromise = poller.pollOnce().then((res) => {
        pollFinished = true;
        return res;
      });

      // Stop while in flight
      expect(pollFinished).toBe(false);
      const stopPromise = poller.stop();
      expect(pollFinished).toBe(false);

      await stopPromise;
      // After stop resolves, the pending poll must have finished
      expect(pollFinished).toBe(true);
      const delayResult = await pollPromise;
      expect(delayResult).toBe(1);
    } finally {
      console.error = originalConsoleError;
      await poller.stop();
    }
  });

  it.skipIf(!testDbUrl)(
    'retries failed outbox dispatches with exponential backoff and recovers durably without manual SQL edits',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Outbox Retry Owner' },
        githubUserId: `gh_outbox_retry_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const outboxId = `outbox_retry_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, retry_count, created_at, updated_at)
         VALUES ($1, $2, 'run.dispatched', '{"runId":"run_retry_test"}'::jsonb, 'pending', 0, NOW(), NOW())`,
        [outboxId, workspace.id]
      );

      let targetSendAttempts = 0;
      const dispatchedJobs: { name: string; data: object; options?: BossSendOptions }[] = [];
      const failFirstMockBoss: BossDispatcher = {
        send: async (name, data, options) => {
          const payload = data as { outboxId?: string; runId?: string };
          if (payload?.outboxId === outboxId) {
            targetSendAttempts++;
            if (targetSendAttempts === 1) {
              throw new Error('transient pg-boss network timeout canary_fail');
            }
          }
          dispatchedJobs.push({ name, data, options });
          return 'job_retry_success';
        },
      };

      const poller = new OutboxPoller(
        pool,
        {
          databaseUrl: testDbUrl!,
          workerId: 'retry_poller_worker',
          hostname: 'test-host',
          pid: process.pid,
          heartbeatIntervalMs: 5000,
          outboxIntervalMs: 1000,
          pgbossSchema: 'pgboss',
          runLeaseTimeoutSeconds: 30,
          pgbossExpireSeconds: 300,
          fixtureStepDelayMs: 0,
        },
        failFirstMockBoss
      );

      try {
        // 1. First poll: send fails for target
        await poller.pollOnce();
        expect(targetSendAttempts).toBe(1);

        // Check DB row: status must be 'failed', retry_count = 1, last_error safe
        const row1 = await pool.query(
          `SELECT status, retry_count, last_error, claimed_by FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(row1.rows[0].status).toBe('failed');
        expect(row1.rows[0].retry_count).toBe(1);
        expect(row1.rows[0].claimed_by).toBeNull();
        expect(row1.rows[0].last_error).toBe('Database operation failed with internal error');
        expect(row1.rows[0].last_error).not.toContain('canary_fail');

        // 2. Immediate second poll before backoff expires (delay is 1s): should NOT dispatch target!
        await poller.pollOnce();
        expect(targetSendAttempts).toBe(1); // Not called again!

        const rowImmediate = await pool.query(
          `SELECT status, retry_count FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(rowImmediate.rows[0].status).toBe('failed');
        expect(rowImmediate.rows[0].retry_count).toBe(1);

        // 3. Wait out natural 1-second backoff (1.1s) without touching DB
        await new Promise((r) => setTimeout(r, 1100));

        // 4. Third poll: natural backoff has passed, poller reclaims and second attempt succeeds!
        await poller.pollOnce();
        expect(targetSendAttempts).toBe(2);

        // Check DB row: status must be 'dispatched'
        const row2 = await pool.query(
          `SELECT status, retry_count, dispatched_at FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(row2.rows[0].status).toBe('dispatched');
        expect(row2.rows[0].retry_count).toBe(1); // 1 failure recorded before success
        expect(row2.rows[0].dispatched_at).not.toBeNull();
        const targetJob = dispatchedJobs.find(
          (j) => (j.data as { outboxId?: string })?.outboxId === outboxId
        );
        expect(targetJob).toBeDefined();
        expect(targetJob?.options?.singletonKey).toBe(`outbox_${outboxId}`);
      } finally {
        await pool.query(`DELETE FROM app.outbox WHERE id = $1`, [outboxId]);
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'fences markOutboxDispatched and markOutboxFailed so stale workers cannot clobber newer claims',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Outbox Fencing Owner' },
        githubUserId: `gh_outbox_fence_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const outboxId = `outbox_fence_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, created_at, updated_at)
         VALUES ($1, $2, 'run.dispatched', '{"runId":"run_fence_test"}'::jsonb, 'pending', NOW(), NOW())`,
        [outboxId, workspace.id]
      );

      const client = await pool.connect();
      try {
        // 1. Worker 1 claims item
        await client.query('BEGIN');
        const batch1 = await claimOutboxBatch(client, 'worker_1', 10, 30);
        await client.query('COMMIT');
        const claim1 = batch1.find((i) => i.id === outboxId);
        expect(claim1).toBeDefined();
        expect(claim1?.claimedBy).toBe('worker_1');

        // 2. Simulate Worker 1 stalling: claim expires after staleTimeoutSeconds (aged for takeover)
        await pool.query(
          `UPDATE app.outbox SET claimed_at = NOW() - INTERVAL '35 seconds' WHERE id = $1`,
          [outboxId]
        );

        // 3. Worker 2 takes over the expired claim
        await client.query('BEGIN');
        const batch2 = await claimOutboxBatch(client, 'worker_2', 10, 30);
        await client.query('COMMIT');
        const claim2 = batch2.find((i) => i.id === outboxId);
        expect(claim2).toBeDefined();
        expect(claim2?.claimedBy).toBe('worker_2');

        // 4. Stale Worker 1 attempts markOutboxDispatched with its old workerId & claim timestamp
        const staleAckResult = await markOutboxDispatched(
          pool,
          outboxId,
          'worker_1',
          claim1!.claimedAt!
        );
        expect(staleAckResult).toBe(false); // Fenced out! 0 rows updated

        // 5. Stale Worker 1 attempts markOutboxFailed with its old workerId & claim timestamp
        const staleFailResult = await markOutboxFailed(
          pool,
          outboxId,
          'stale error',
          'worker_1',
          claim1!.claimedAt!
        );
        expect(staleFailResult).toBe(false); // Fenced out! 0 rows updated

        // 6. Verify item is STILL claimed by Worker 2, not marked dispatched or failed by Worker 1
        const checkItem = await pool.query(
          `SELECT status, claimed_by FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(checkItem.rows[0].status).toBe('claimed');
        expect(checkItem.rows[0].claimed_by).toBe('worker_2');

        // 7. Legitimate Worker 2 marks it dispatched -> succeeds!
        const validAckResult = await markOutboxDispatched(
          pool,
          outboxId,
          'worker_2',
          claim2!.claimedAt!
        );
        expect(validAckResult).toBe(true);

        const finalCheck = await pool.query(
          `SELECT status FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(finalCheck.rows[0].status).toBe('dispatched');

        // 8. Same owner & token: second fail after dispatch returns false and leaves status = 'dispatched'
        const secondFailResult = await markOutboxFailed(
          pool,
          outboxId,
          'delayed failure on already dispatched item',
          'worker_2',
          claim2!.claimedAt!
        );
        expect(secondFailResult).toBe(false);

        const checkStillDispatched = await pool.query(
          `SELECT status FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(checkStillDispatched.rows[0].status).toBe('dispatched');

        // 9. Same owner & token: duplicate dispatch returns false
        const duplicateAckResult = await markOutboxDispatched(
          pool,
          outboxId,
          'worker_2',
          claim2!.claimedAt!
        );
        expect(duplicateAckResult).toBe(false);
      } finally {
        client.release();
        await pool.query(`DELETE FROM app.outbox WHERE id = $1`, [outboxId]);
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'respects exponential backoff delay across repeated dispatch failures',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Outbox Backoff Owner' },
        githubUserId: `gh_outbox_backoff_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const outboxId = `outbox_backoff_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, retry_count, created_at, updated_at)
         VALUES ($1, $2, 'run.dispatched', '{"runId":"run_backoff_test"}'::jsonb, 'pending', 0, NOW(), NOW())`,
        [outboxId, workspace.id]
      );

      let targetSendAttempts = 0;
      let targetFailCount = 0;
      const failingBoss: BossDispatcher = {
        send: async (name, data, options) => {
          const payload = data as { outboxId?: string; runId?: string };
          if (payload?.outboxId === outboxId) {
            targetSendAttempts++;
            targetFailCount++;
            throw new Error(`Intentional dispatch failure #${targetFailCount}`);
          }
          return 'job_other_success';
        },
      };

      const poller = new OutboxPoller(
        pool,
        {
          databaseUrl: testDbUrl!,
          workerId: 'backoff_poller_worker',
          hostname: 'test-host',
          pid: process.pid,
          heartbeatIntervalMs: 5000,
          outboxIntervalMs: 1000,
          pgbossSchema: 'pgboss',
          runLeaseTimeoutSeconds: 30,
          pgbossExpireSeconds: 300,
          fixtureStepDelayMs: 0,
        },
        failingBoss
      );

      try {
        // Attempt 1: fails, retry_count becomes 1, backoff = 1s (2^0)
        await poller.pollOnce();
        let row = await pool.query(
          `SELECT status, retry_count FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(row.rows[0].status).toBe('failed');
        expect(row.rows[0].retry_count).toBe(1);
        expect(targetSendAttempts).toBe(1);

        // Wait 1.1s (past 1s backoff)
        await new Promise((r) => setTimeout(r, 1100));

        // Attempt 2: eligible, fails again, retry_count becomes 2, backoff = 2s (2^1)
        await poller.pollOnce();
        row = await pool.query(
          `SELECT status, retry_count FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(row.rows[0].status).toBe('failed');
        expect(row.rows[0].retry_count).toBe(2);
        expect(targetSendAttempts).toBe(2);

        // Check after 1s (halfway through 2s backoff) -> target is NOT eligible yet!
        await new Promise((r) => setTimeout(r, 1000));
        await poller.pollOnce();

        // Target dispatch attempts must remain unchanged, and row remains failed with retry_count 2
        expect(targetSendAttempts).toBe(2);
        row = await pool.query(
          `SELECT status, retry_count FROM app.outbox WHERE id = $1`,
          [outboxId]
        );
        expect(row.rows[0].status).toBe('failed');
        expect(row.rows[0].retry_count).toBe(2);

        // Wait another 1.2s (total > 2s elapsed) -> target is now eligible!
        await new Promise((r) => setTimeout(r, 1200));
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const claimed = await claimOutboxBatch(client, 'check_worker', 10, 30);
          await client.query('COMMIT');
          const found = claimed.find((i) => i.id === outboxId);
          expect(found).toBeDefined();
          expect(found?.retryCount).toBe(2);
        } finally {
          client.release();
        }
      } finally {
        await pool.query(`DELETE FROM app.outbox WHERE id = $1`, [outboxId]);
      }
    }
  );
});
