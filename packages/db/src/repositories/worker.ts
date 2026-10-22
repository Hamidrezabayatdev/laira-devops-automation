import crypto from 'node:crypto';
import pg from 'pg';
import type { Run, RunEvent } from './run.js';
import type { RunErrorPayload } from '../schema/runs.js';
import type { WorkerStatus } from '../schema/workers.js';
import { validateSafeEventPayload } from '../schema/events.js';

export class FencingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FencingError';
  }
}

export interface ResolveRunResult {
  run: Run;
  workspaceId: string;
}

export interface AppendRunEventParams {
  type: string;
  payload: Record<string, unknown>;
}

export interface UpsertWorkerHeartbeatParams {
  workerId: string;
  hostname: string;
  pid: number;
  status?: WorkerStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Worker-side resolution:
 * Workers resolve workspace and run attributes directly from stored database rows,
 * NEVER from unverified caller job payloads.
 */
export async function resolveRunForExecution(
  poolOrClient: pg.Pool | pg.PoolClient,
  runId: string
): Promise<ResolveRunResult | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.runs WHERE id = $1 LIMIT 1`,
    [runId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const run: Run = {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };

  return {
    run,
    workspaceId: row.workspace_id,
  };
}

/**
 * Atomically claim a run for execution with lease fencing.
 * - Claims queued runs.
 * - Permits idempotent re-claim by same worker.
 * - Allows takeover if previous worker's lease expired (heartbeat_at older than leaseTimeoutSeconds).
 * Returns null if another worker holds an active lease or run is already terminal.
 */
export async function claimRunForExecution(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  leaseTimeoutSeconds = 30
): Promise<Run | null> {
  const res = await poolOrClient.query(
    `UPDATE app.runs
     SET status = 'running',
         claimed_by = $1,
         claimed_at = NOW(),
         heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE id = $2
       AND (
         status = 'queued'
         OR (status = 'running' AND claimed_by = $1)
         OR (status = 'running' AND heartbeat_at < NOW() - make_interval(secs => $3))
       )
     RETURNING *`,
    [workerId, runId, leaseTimeoutSeconds]
  );

  if (res.rows.length === 0) {
    const existing = await poolOrClient.query(
      `SELECT * FROM app.runs WHERE id = $1 LIMIT 1`,
      [runId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // Return terminal run for idempotency check
      if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
        return {
          id: row.id,
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          type: row.type,
          status: row.status,
          input: row.input,
          output: row.output,
          error: row.error,
          claimedBy: row.claimed_by,
          claimedAt: row.claimed_at,
          heartbeatAt: row.heartbeat_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          finishedAt: row.finished_at,
        };
      }
    }
    return null;
  }

  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Appends a strictly monotonic sequence event for a run with fencing check.
 * Enforces:
 * 1. Fencing: only the worker currently holding the active claim may append events.
 * 2. Monotonicity: locks the run row during sequence assignment.
 * 3. Schema validation: event payload strictly conforms to minimal safe types.
 * 4. Extends the run's lease heartbeat.
 */
export async function appendRunEvent(
  pool: pg.Pool,
  workerId: string,
  runId: string,
  params: AppendRunEventParams
): Promise<RunEvent> {
  const validatedPayload = validateSafeEventPayload(params.type, params.payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock run row to serialize seq generation and check fencing
    const runRes = await client.query(
      `SELECT workspace_id, status, claimed_by FROM app.runs WHERE id = $1 FOR UPDATE`,
      [runId]
    );

    if (runRes.rows.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }

    const currentRun = runRes.rows[0];

    // Fencing check
    if (currentRun.status !== 'running') {
      throw new FencingError(
        `Cannot append event to run ${runId}: status is ${currentRun.status}`
      );
    }
    if (currentRun.claimed_by !== workerId) {
      throw new FencingError(
        `Worker ${workerId} is fenced out of run ${runId}: active claim belongs to ${currentRun.claimed_by}`
      );
    }

    const workspaceId = currentRun.workspace_id;

    const seqRes = await client.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM app.run_events WHERE run_id = $1`,
      [runId]
    );
    const nextSeq = Number(seqRes.rows[0].next_seq);

    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const insertRes = await client.query(
      `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       RETURNING *`,
      [eventId, workspaceId, runId, nextSeq, params.type, JSON.stringify(validatedPayload)]
    );

    // Extend lease heartbeat on the run
    await client.query(
      `UPDATE app.runs SET heartbeat_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [runId]
    );

    await client.query('COMMIT');

    const row = insertRes.rows[0];
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateRunHeartbeat(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string
): Promise<void> {
  const res = await poolOrClient.query(
    `UPDATE app.runs
     SET heartbeat_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND claimed_by = $2 AND status = 'running'
     RETURNING id`,
    [runId, workerId]
  );

  if (res.rows.length === 0) {
    throw new FencingError(
      `Worker ${workerId} failed to update heartbeat for run ${runId}: claim lost or run not running`
    );
  }
}

/**
 * Completes a run as succeeded with fencing guard.
 */
export async function completeRun(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  output: Record<string, unknown>
): Promise<Run> {
  const res = await poolOrClient.query(
    `UPDATE app.runs
     SET status = 'succeeded',
         output = $1::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND status = 'running' AND claimed_by = $3
     RETURNING *`,
    [JSON.stringify(output), runId, workerId]
  );

  if (res.rows.length === 0) {
    // Check if already completed
    const existing = await poolOrClient.query(`SELECT * FROM app.runs WHERE id = $1`, [runId]);
    if (existing.rows.length > 0 && existing.rows[0].status === 'succeeded') {
      const row = existing.rows[0];
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        type: row.type,
        status: row.status,
        input: row.input,
        output: row.output,
        error: row.error,
        claimedBy: row.claimed_by,
        claimedAt: row.claimed_at,
        heartbeatAt: row.heartbeat_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        finishedAt: row.finished_at,
      };
    }
    throw new FencingError(
      `Worker ${workerId} failed to complete run ${runId}: claim lost or run not in running state`
    );
  }

  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Fails a run with fencing guard.
 */
export async function failRun(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  error: RunErrorPayload
): Promise<Run> {
  const res = await poolOrClient.query(
    `UPDATE app.runs
     SET status = 'failed',
         error = $1::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND status = 'running' AND claimed_by = $3
     RETURNING *`,
    [JSON.stringify(error), runId, workerId]
  );

  if (res.rows.length === 0) {
    throw new FencingError(
      `Worker ${workerId} failed to fail run ${runId}: claim lost or run not in running state`
    );
  }

  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export async function upsertWorkerHeartbeat(
  poolOrClient: pg.Pool | pg.PoolClient,
  params: UpsertWorkerHeartbeatParams
): Promise<void> {
  await poolOrClient.query(
    `INSERT INTO app.worker_heartbeats (worker_id, hostname, pid, status, last_heartbeat_at, started_at, metadata)
     VALUES ($1, $2, $3, COALESCE($4, 'alive'), NOW(), NOW(), $5::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_heartbeat_at = NOW(),
       metadata = EXCLUDED.metadata`,
    [
      params.workerId,
      params.hostname,
      params.pid,
      params.status || 'alive',
      JSON.stringify(params.metadata || {}),
    ]
  );
}

export async function setWorkerStatus(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  status: WorkerStatus
): Promise<void> {
  await poolOrClient.query(
    `UPDATE app.worker_heartbeats
     SET status = $1, last_heartbeat_at = NOW()
     WHERE worker_id = $2`,
    [status, workerId]
  );
}
