import crypto from 'node:crypto';
import pg from 'pg';
import { AppError } from '@laira/security';
import type { RunStatus, RunErrorPayload } from '../schema/runs.js';
import { validateSafeEventPayload } from '../schema/events.js';
import type { WorkspaceScope } from './workspace.js';

export class ProjectNotFoundError extends AppError {
  constructor(_projectId?: string) {
    super({
      code: 'NOT_FOUND',
      message: 'Project not found',
      statusCode: 404,
    });
    this.name = 'ProjectNotFoundError';
  }
}

export interface Run {
  id: string;
  workspaceId: string;
  projectId: string | null;
  type: string;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: RunErrorPayload | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface RunEvent {
  id: string;
  workspaceId: string;
  runId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type { WorkspaceScope };

export interface CreateRunParams {
  id?: string;
  projectId?: string;
  type: string;
  input?: Record<string, unknown>;
  initialMessage?: string;
}

export interface GetRunEventsOptions {
  afterSeq?: number;
  limit?: number;
}

export async function createRun(
  pool: pg.Pool,
  workspace: WorkspaceScope,
  params: CreateRunParams
): Promise<Run> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate project scoped in transaction BEFORE writing with safe typed notfound error
    if (params.projectId !== undefined && params.projectId !== null) {
      const projRes = await client.query(
        `SELECT id FROM app.projects WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
        [params.projectId, workspace.workspaceId]
      );
      if (projRes.rows.length === 0) {
        throw new ProjectNotFoundError(params.projectId);
      }
    }

    const runId = params.id || `run_${crypto.randomUUID().replace(/-/g, '')}`;
    const initialInput = params.input || {};

    // 1. Insert Run
    const runRes = await client.query(
      `INSERT INTO app.runs (id, workspace_id, project_id, type, status, input, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, NOW(), NOW())
       RETURNING *`,
      [runId, workspace.workspaceId, params.projectId ?? null, params.type, JSON.stringify(initialInput)]
    );
    const runRow = runRes.rows[0];

    // 2. Insert initial RunEvent (seq = 1)
    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const initialPayload = validateSafeEventPayload('run_started', {
      step: 'init',
      message: params.initialMessage || `Run ${params.type} queued for execution`,
    });

    await client.query(
      `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
       VALUES ($1, $2, $3, 1, 'run_started', $4::jsonb, NOW())`,
      [eventId, workspace.workspaceId, runId, JSON.stringify(initialPayload)]
    );

    // 3. Insert Outbox item atomically
    const outboxId = `out_${crypto.randomUUID().replace(/-/g, '')}`;
    const outboxPayload = { runId };

    await client.query(
      `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, created_at, updated_at)
       VALUES ($1, $2, 'run.dispatched', $3::jsonb, 'pending', NOW(), NOW())`,
      [outboxId, workspace.workspaceId, JSON.stringify(outboxPayload)]
    );

    await client.query('COMMIT');

    return {
      id: runRow.id,
      workspaceId: runRow.workspace_id,
      projectId: runRow.project_id,
      type: runRow.type,
      status: runRow.status,
      input: runRow.input,
      output: runRow.output,
      error: runRow.error,
      claimedBy: runRow.claimed_by,
      claimedAt: runRow.claimed_at,
      heartbeatAt: runRow.heartbeat_at,
      createdAt: runRow.created_at,
      updatedAt: runRow.updated_at,
      finishedAt: runRow.finished_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getRun(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  runId: string
): Promise<Run | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.runs
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [runId, workspace.workspaceId]
  );

  if (res.rows.length === 0) return null;
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

export async function cancelRun(
  pool: pg.Pool,
  workspace: WorkspaceScope,
  runId: string,
  reason = 'Cancelled by owner'
): Promise<Run | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Select run with lock
    const runRes = await client.query(
      `SELECT * FROM app.runs
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [runId, workspace.workspaceId]
    );

    if (runRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const currentRun = runRes.rows[0];
    if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(currentRun.status)) {
      await client.query('ROLLBACK');
      // Terminal state already reached
      return {
        id: currentRun.id,
        workspaceId: currentRun.workspace_id,
        projectId: currentRun.project_id,
        type: currentRun.type,
        status: currentRun.status,
        input: currentRun.input,
        output: currentRun.output,
        error: currentRun.error,
        claimedBy: currentRun.claimed_by,
        claimedAt: currentRun.claimed_at,
        heartbeatAt: currentRun.heartbeat_at,
        createdAt: currentRun.created_at,
        updatedAt: currentRun.updated_at,
        finishedAt: currentRun.finished_at,
      };
    }

    // Monotonic next seq
    const seqRes = await client.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM app.run_events WHERE run_id = $1`,
      [runId]
    );
    const nextSeq = Number(seqRes.rows[0].next_seq);

    const now = new Date();
    const cancelPayload = validateSafeEventPayload('run_cancelled', {
      reason,
      cancelledAt: now.toISOString(),
    });

    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    await client.query(
      `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
       VALUES ($1, $2, $3, $4, 'run_cancelled', $5::jsonb, $6)`,
      [eventId, workspace.workspaceId, runId, nextSeq, JSON.stringify(cancelPayload), now]
    );

    const updateRes = await client.query(
      `UPDATE app.runs
       SET status = 'cancelled', updated_at = $1, finished_at = $1
       WHERE id = $2 AND workspace_id = $3
       RETURNING *`,
      [now, runId, workspace.workspaceId]
    );

    await client.query('COMMIT');

    const updated = updateRes.rows[0];
    return {
      id: updated.id,
      workspaceId: updated.workspace_id,
      projectId: updated.project_id,
      type: updated.type,
      status: updated.status,
      input: updated.input,
      output: updated.output,
      error: updated.error,
      claimedBy: updated.claimed_by,
      claimedAt: updated.claimed_at,
      heartbeatAt: updated.heartbeat_at,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
      finishedAt: updated.finished_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getRunEvents(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  runId: string,
  options?: GetRunEventsOptions
): Promise<RunEvent[]> {
  // First verify run belongs to workspace
  const runRes = await poolOrClient.query(
    `SELECT id FROM app.runs WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [runId, workspace.workspaceId]
  );
  if (runRes.rows.length === 0) {
    return [];
  }

  const afterSeq = options?.afterSeq ?? 0;
  const limit = options?.limit ?? 1000;

  const res = await poolOrClient.query(
    `SELECT * FROM app.run_events
     WHERE workspace_id = $1 AND run_id = $2 AND seq > $3
     ORDER BY seq ASC
     LIMIT $4`,
    [workspace.workspaceId, runId, afterSeq, limit]
  );

  return res.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
