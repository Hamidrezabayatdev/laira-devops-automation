import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  createRun,
  getRun,
  getRunEvents,
  getOrCreateOwnerWorkspace,
  claimRunForExecution,
  updateRunHeartbeat,
  FencingError,
} from '../src/index.js';
import { runMigrations } from '../src/migrator.js';
import { executeDemoFixtureRun } from '../../../apps/worker/src/handlers/demo-fixture.js';
import { WorkerHeartbeatManager } from '../../../apps/worker/src/heartbeat.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Worker Fixture Handler & Recovery Tests (packages test runner)', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping Worker integration tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
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

  it.skipIf(!testDbUrl)(
    'executes demo fixture run, resolves workspace from DB, emits monotonic events, and marks success',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Worker Test Owner' },
        githubUserId: `gh_worker_pkg_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
        input: { target: 'liara-app' },
      });

      // Execute worker handler
      const result = await executeDemoFixtureRun(pool, 'worker-pkg-1', run.id);
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
    }
  );

  it.skipIf(!testDbUrl)(
    'tolerates duplicate dispatch idempotently without re-emitting duplicated events',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Idempotency Owner' },
        githubUserId: `gh_idempotent_pkg_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // First delivery
      await executeDemoFixtureRun(pool, 'worker-1', run.id);

      // Redelivery
      const redeliveredResult = await executeDemoFixtureRun(pool, 'worker-2', run.id);
      expect(redeliveredResult.run.status).toBe('succeeded');
      expect(redeliveredResult.eventsEmitted).toBe(0);

      const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
      expect(events.length).toBe(5);
    }
  );

  it.skipIf(!testDbUrl)(
    'recovers running job after worker restart / crash without corrupting sequence',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Crash Recovery Owner' },
        githubUserId: `gh_crash_pkg_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // Partial execution before crash (lease expired)
      await pool.query(
        `UPDATE app.runs SET status = 'running', claimed_by = 'crashed_worker', heartbeat_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`,
        [run.id]
      );
      await pool.query(
        `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
         VALUES ($1, $2, $3, 2, 'step_progress', '{"step":"discovery","progress":30,"message":"partial"}'::jsonb, NOW())`,
        [`evt_${crypto.randomUUID().replace(/-/g, '')}`, workspace.id, run.id]
      );

      // Recovery
      const recoveryResult = await executeDemoFixtureRun(pool, 'recovered_worker', run.id);
      expect(recoveryResult.run.status).toBe('succeeded');
      expect(recoveryResult.recovered).toBe(true);

      const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(events.find((e) => e.type === 'fixture_inspection')).toBeDefined();
    }
  );

  it.skipIf(!testDbUrl)(
    'records worker heartbeats and transitions status cleanly during shutdown',
    async () => {
      const workerId = `test_worker_pkg_${Date.now()}`;
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
    'fences out stale workers from extending another owners lease via updateRunHeartbeat',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Heartbeat Fence Owner' },
        githubUserId: `gh_hb_fence_${Date.now()}`,
      });
      trackedWorkspaceIds.add(workspace.id);

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      // Worker 1 claims run
      const claim1 = await claimRunForExecution(pool, 'worker-hb-1', run.id, 30);
      expect(claim1).not.toBeNull();
      expect(claim1?.claimedBy).toBe('worker-hb-1');

      // Worker 1 legitimately extends heartbeat
      await expect(
        updateRunHeartbeat(pool, 'worker-hb-1', run.id)
      ).resolves.toBeUndefined();

      // Simulate lease expiration and Worker 2 takeover
      await pool.query(
        `UPDATE app.runs SET claimed_by = 'worker-hb-2', heartbeat_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
        [run.id]
      );

      const beforeCheck = await pool.query(
        `SELECT heartbeat_at FROM app.runs WHERE id = $1`,
        [run.id]
      );
      const originalHeartbeat = beforeCheck.rows[0].heartbeat_at;

      // Stale Worker 1 attempts to update heartbeat -> throws FencingError!
      await expect(
        updateRunHeartbeat(pool, 'worker-hb-1', run.id)
      ).rejects.toThrow(FencingError);

      // Verify heartbeat_at was NOT modified by stale worker
      const afterCheck = await pool.query(
        `SELECT heartbeat_at FROM app.runs WHERE id = $1`,
        [run.id]
      );
      expect(afterCheck.rows[0].heartbeat_at.toISOString()).toBe(originalHeartbeat.toISOString());

      // Worker 2 (active owner) can update heartbeat
      await expect(
        updateRunHeartbeat(pool, 'worker-hb-2', run.id)
      ).resolves.toBeUndefined();

      // Completing the run fences out even the former owner from further heartbeats
      await pool.query(
        `UPDATE app.runs SET status = 'succeeded' WHERE id = $1`,
        [run.id]
      );
      await expect(
        updateRunHeartbeat(pool, 'worker-hb-2', run.id)
      ).rejects.toThrow(FencingError);
    }
  );
});
