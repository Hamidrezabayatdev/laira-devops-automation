import pg from 'pg';
import type { OutboxStatus } from '../schema/outbox.js';

export interface OutboxItem {
  id: string;
  workspaceId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  lastError: string | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
}

/**
 * Concurrency-safe outbox batch claim using FOR UPDATE SKIP LOCKED.
 * Multiple workers can safely poll simultaneously without contention or duplicate dispatch.
 * Automatically recovers items claimed by crashed workers whose claim exceeded staleTimeoutSeconds,
 * and recovers failed items after capped exponential backoff (1s, 2s, 4s... max 60s).
 */
export async function claimOutboxBatch(
  client: pg.PoolClient,
  workerId: string,
  limit = 20,
  staleTimeoutSeconds = 30
): Promise<OutboxItem[]> {
  const query = `
    WITH pending_items AS (
      SELECT id FROM app.outbox
      WHERE status = 'pending'
         OR (status = 'claimed' AND claimed_at < NOW() - make_interval(secs => $3))
         OR (
           status = 'failed'
           AND updated_at <= NOW() - make_interval(secs => LEAST(60.0, POWER(2::double precision, LEAST(10, GREATEST(0, retry_count - 1))::double precision)))
         )
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE app.outbox
    SET status = 'claimed',
        claimed_by = $2,
        claimed_at = date_trunc('milliseconds', NOW()),
        updated_at = NOW()
    WHERE id IN (SELECT id FROM pending_items)
    RETURNING *;
  `;

  const res = await client.query(query, [limit, workerId, staleTimeoutSeconds]);

  return res.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    topic: row.topic,
    payload: row.payload,
    status: row.status,
    retryCount: row.retry_count,
    lastError: row.last_error,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
  }));
}

export async function markOutboxDispatched(
  poolOrClient: pg.Pool | pg.PoolClient,
  outboxId: string,
  workerId: string,
  claimedAt: Date
): Promise<boolean> {
  const query = `
    UPDATE app.outbox
    SET status = 'dispatched',
        dispatched_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
      AND status = 'claimed'
      AND claimed_by = $2
      AND date_trunc('milliseconds', claimed_at) = date_trunc('milliseconds', $3::timestamptz)
    RETURNING id
  `;

  const res = await poolOrClient.query(query, [outboxId, workerId, claimedAt]);
  return (res.rowCount ?? 0) > 0;
}

export async function markOutboxFailed(
  poolOrClient: pg.Pool | pg.PoolClient,
  outboxId: string,
  error: string,
  workerId: string,
  claimedAt: Date
): Promise<boolean> {
  const query = `
    UPDATE app.outbox
    SET status = 'failed',
        last_error = $2,
        retry_count = retry_count + 1,
        claimed_by = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE id = $1
      AND status = 'claimed'
      AND claimed_by = $3
      AND date_trunc('milliseconds', claimed_at) = date_trunc('milliseconds', $4::timestamptz)
    RETURNING id
  `;

  const res = await poolOrClient.query(query, [outboxId, error, workerId, claimedAt]);
  return (res.rowCount ?? 0) > 0;
}

export async function resetStaleOutboxClaims(
  poolOrClient: pg.Pool | pg.PoolClient,
  staleAfterSeconds = 60
): Promise<number> {
  const res = await poolOrClient.query(
    `UPDATE app.outbox
     SET status = 'pending',
         claimed_by = NULL,
         claimed_at = NULL,
         updated_at = NOW()
     WHERE status = 'claimed'
       AND claimed_at < NOW() - INTERVAL '1 second' * $1
     RETURNING id`,
    [staleAfterSeconds]
  );
  return res.rowCount ?? 0;
}
