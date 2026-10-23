import crypto from 'node:crypto';
import pg from 'pg';
import { AppError } from '@laira/security';
import type { WorkspaceScope } from './workspace.js';
import { getConnection } from './connection.js';

export type MonitorStatus = 'unknown' | 'healthy' | 'degraded' | 'recovering' | 'paused';
export type HealthPath = '/' | '/api/health';

export const ALLOWED_HEALTH_PATHS: readonly HealthPath[] = ['/', '/api/health'] as const;
export const MIN_MONITOR_INTERVAL_SECONDS = 60;
export const MAX_MONITOR_INTERVAL_SECONDS = 3600;
export const DEFAULT_MONITOR_INTERVAL_SECONDS = 60;
export const DEFAULT_LEASE_EXPIRY_SECONDS = 120;

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface MonitorEvidence {
  httpStatus: number | null;
  probeKind: 'http';
  providerState: string;
  checkedAt: string;
}

export interface AppMonitor {
  id: string;
  workspaceId: string;
  connectionId: string;
  appSlug: string;
  healthPath: HealthPath;
  intervalSeconds: number;
  isActive: boolean;
  nextCheckAt: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastStatus: MonitorStatus;
  lastCheckedAt: Date | null;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppMonitorIncident {
  id: string;
  workspaceId: string;
  monitorId: string;
  status: 'open' | 'resolved';
  failureCount: number;
  evidence: MonitorEvidence;
  openedAt: Date;
  lastFailedAt: Date;
  resolvedAt: Date | null;
}

export type SafeAppMonitor = Omit<AppMonitor, 'claimToken' | 'leaseExpiresAt'>;

export function toSafeMonitorDto(monitor: AppMonitor): SafeAppMonitor {
  const { claimToken, leaseExpiresAt, ...safe } = monitor;
  return safe;
}

export interface RegisterAppMonitorParams {
  connectionId: string;
  appSlug: string;
  healthPath?: string;
  intervalSeconds?: number;
}

export interface RecordCheckResultParams {
  monitorId: string;
  claimToken: string;
  checkedAt?: Date;
  testLeaseExpiryNow?: Date;
  httpStatus: number | null;
  probeOk: boolean;
  providerState: string;
  providerConfirmedRecovery?: boolean;
}

export interface CheckRecordOutcome {
  monitor: AppMonitor | null;
  incident: AppMonitorIncident | null;
  incidentAction: 'none' | 'opened' | 'updated' | 'resolved';
}

export function validateMonitorAppSlug(rawSlug: string): string {
  if (!rawSlug || typeof rawSlug !== 'string' || !rawSlug.trim()) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'App slug is required',
      statusCode: 400,
    });
  }
  const slug = rawSlug.trim().toLowerCase();
  if (!SLUG_REGEX.test(slug)) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Invalid app slug: must be 1-64 alphanumeric characters, hyphens, or underscores',
      statusCode: 400,
    });
  }
  return slug;
}

export function validateMonitorHealthPath(rawPath?: string): HealthPath {
  if (!rawPath) return '/';
  const trimmed = rawPath.trim();
  if (trimmed === '/' || trimmed === '/api/health') {
    return trimmed;
  }
  throw new AppError({
    code: 'BAD_REQUEST',
    message: 'Health path must be strictly "/" or "/api/health"',
    statusCode: 400,
  });
}

export function validateMonitorInterval(interval?: number): number {
  if (interval === undefined || interval === null) {
    return DEFAULT_MONITOR_INTERVAL_SECONDS;
  }
  if (!Number.isInteger(interval) || interval < MIN_MONITOR_INTERVAL_SECONDS || interval > MAX_MONITOR_INTERVAL_SECONDS) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: `Interval must be an integer between ${MIN_MONITOR_INTERVAL_SECONDS} and ${MAX_MONITOR_INTERVAL_SECONDS} seconds`,
      statusCode: 400,
    });
  }
  return interval;
}

function mapMonitorRow(row: any): AppMonitor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    appSlug: row.app_slug,
    healthPath: row.health_path,
    intervalSeconds: row.interval_seconds,
    isActive: row.is_active,
    nextCheckAt: row.next_check_at,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    lastStatus: row.last_status,
    lastCheckedAt: row.last_checked_at,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIncidentRow(row: any): AppMonitorIncident {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    monitorId: row.monitor_id,
    status: row.status,
    failureCount: row.failure_count,
    evidence: row.evidence,
    openedAt: row.opened_at,
    lastFailedAt: row.last_failed_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Idempotently registers or updates an app monitor bound strictly to workspace and connection.
 */
export async function registerAppMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  params: RegisterAppMonitorParams
): Promise<AppMonitor> {
  const connectionId = params.connectionId?.trim();
  if (!connectionId) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection ID is required',
      statusCode: 400,
    });
  }

  const connection = await getConnection(poolOrClient, scope, connectionId);
  if (!connection) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: 'Connection not found in workspace',
      statusCode: 404,
    });
  }

  if (connection.provider !== 'liara') {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection provider must be liara',
      statusCode: 400,
    });
  }

  const appSlug = validateMonitorAppSlug(params.appSlug);
  const healthPath = validateMonitorHealthPath(params.healthPath);
  const intervalSeconds = validateMonitorInterval(params.intervalSeconds);

  const monitorId = `mon_${crypto.randomUUID().replace(/-/g, '')}`;

  const res = await poolOrClient.query(
    `INSERT INTO app.app_monitors (
       id, workspace_id, connection_id, app_slug, health_path, interval_seconds,
       is_active, next_check_at, consecutive_failures, consecutive_successes,
       last_status, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), 0, 0, 'unknown', NOW(), NOW())
     ON CONFLICT (workspace_id, connection_id, app_slug)
     DO UPDATE SET
       health_path = EXCLUDED.health_path,
       interval_seconds = EXCLUDED.interval_seconds,
       is_active = true,
       updated_at = NOW()
     RETURNING *`,
    [monitorId, scope.workspaceId, connectionId, appSlug, healthPath, intervalSeconds]
  );

  return mapMonitorRow(res.rows[0]);
}

export async function getAppMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  monitorId: string
): Promise<AppMonitor | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.app_monitors
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [monitorId, scope.workspaceId]
  );
  if (res.rows.length === 0) return null;
  return mapMonitorRow(res.rows[0]);
}

export async function getAppMonitorByTarget(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  connectionId: string,
  appSlug: string
): Promise<AppMonitor | null> {
  const cleanSlug = validateMonitorAppSlug(appSlug);
  const res = await poolOrClient.query(
    `SELECT * FROM app.app_monitors
     WHERE workspace_id = $1 AND connection_id = $2 AND app_slug = $3
     LIMIT 1`,
    [scope.workspaceId, connectionId, cleanSlug]
  );
  if (res.rows.length === 0) return null;
  return mapMonitorRow(res.rows[0]);
}

export async function listAppMonitors(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope
): Promise<AppMonitor[]> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.app_monitors
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [scope.workspaceId]
  );
  return res.rows.map(mapMonitorRow);
}

export async function pauseAppMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  monitorId: string
): Promise<AppMonitor | null> {
  const res = await poolOrClient.query(
    `UPDATE app.app_monitors
     SET is_active = false,
         last_status = 'paused',
         claim_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    [monitorId, scope.workspaceId]
  );
  if (res.rows.length === 0) return null;
  return mapMonitorRow(res.rows[0]);
}

export async function resumeAppMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  monitorId: string
): Promise<AppMonitor | null> {
  const res = await poolOrClient.query(
    `UPDATE app.app_monitors
     SET is_active = true,
         next_check_at = NOW(),
         claim_token = NULL,
         lease_expires_at = NULL,
         last_status = CASE WHEN last_status = 'paused' THEN 'unknown' ELSE last_status END,
         updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    [monitorId, scope.workspaceId]
  );
  if (res.rows.length === 0) return null;
  return mapMonitorRow(res.rows[0]);
}

/**
 * Atomically acquires exclusive lease for a specific monitor BEFORE network dispatch.
 * Fails if monitor is paused or active lease is held by another worker/CLI.
 * Never overwrites an active unexpired lease.
 */
export async function claimSpecificMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  monitorId: string,
  options?: {
    scope?: WorkspaceScope;
    leaseTimeoutSeconds?: number;
    now?: Date;
  }
): Promise<{ claimed: boolean; claimToken: string | null; monitor: AppMonitor | null }> {
  const leaseSeconds = options?.leaseTimeoutSeconds ?? DEFAULT_LEASE_EXPIRY_SECONDS;
  const token = crypto.randomUUID();
  const now = options?.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  const values: any[] = [token, leaseExpiresAt, monitorId];
  let query = `
    UPDATE app.app_monitors
    SET claim_token = $1,
        lease_expires_at = $2,
        updated_at = NOW()
    WHERE id = $3
      AND is_active = true
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  `;

  if (options?.scope) {
    values.push(options.scope.workspaceId);
    query += ` AND workspace_id = $4`;
  }

  query += ` RETURNING *`;

  const res = await poolOrClient.query(query, values);
  if (res.rows.length === 0) {
    return { claimed: false, claimToken: null, monitor: null };
  }

  return {
    claimed: true,
    claimToken: token,
    monitor: mapMonitorRow(res.rows[0]),
  };
}

/**
 * Re-validates that a claimed lease is still active and monitor has not been paused.
 */
export async function isClaimActive(
  poolOrClient: pg.Pool | pg.PoolClient,
  monitorId: string,
  claimToken: string
): Promise<boolean> {
  const res = await poolOrClient.query(
    `SELECT 1 FROM app.app_monitors
     WHERE id = $1
       AND claim_token = $2
       AND is_active = true
       AND (lease_expires_at IS NULL OR lease_expires_at >= NOW())
     LIMIT 1`,
    [monitorId, claimToken]
  );
  return res.rows.length > 0;
}

/**
 * Claims due monitors atomically using FOR UPDATE SKIP LOCKED with lease fencing.
 */
export async function claimDueMonitors(
  pool: pg.Pool,
  params?: {
    now?: Date;
    leaseTimeoutSeconds?: number;
    limit?: number;
  }
): Promise<AppMonitor[]> {
  const now = params?.now ?? new Date();
  const leaseSeconds = params?.leaseTimeoutSeconds ?? DEFAULT_LEASE_EXPIRY_SECONDS;
  const limit = Math.max(1, Math.min(params?.limit ?? 10, 50));
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Select candidate due monitor IDs with SKIP LOCKED
    const dueRes = await client.query(
      `SELECT id FROM app.app_monitors
       WHERE is_active = true
         AND next_check_at <= $1
         AND (lease_expires_at IS NULL OR lease_expires_at < $1)
       ORDER BY next_check_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit]
    );

    if (dueRes.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const claimed: AppMonitor[] = [];
    for (const row of dueRes.rows) {
      const claimToken = crypto.randomUUID();
      const updateRes = await client.query(
        `UPDATE app.app_monitors
         SET claim_token = $1,
             lease_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [claimToken, leaseExpiresAt, row.id]
      );
      if (updateRes.rows.length > 0) {
        claimed.push(mapMonitorRow(updateRes.rows[0]));
      }
    }

    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically records the check result using lease write fencing and updates incidents.
 *
 * Rules:
 * - Lease write fencing: fails/returns null if claim_token mismatch or lease expired.
 * - HTTP failures:
 *   - Increments consecutive_failures, resets consecutive_successes to 0.
 *   - Status degrades.
 *   - Exactly at 3 consecutive failures: opens ONE incident (persisted).
 *   - At > 3 consecutive failures: updates the existing open incident without creating duplicates.
 * - HTTP successes:
 *   - Increments consecutive_successes, resets consecutive_failures to 0.
 *   - If open incident exists and consecutive_successes >= 3 AND provider confirmed recovery:
 *     resolves the open incident, status becomes 'healthy'.
 *   - If open incident exists but consecutive_successes < 3 or provider unconfirmed:
 *     status becomes 'recovering', incident remains open.
 *   - If no open incident: status becomes 'healthy'.
 */
export async function recordMonitorCheckResult(
  poolOrClient: pg.Pool | pg.PoolClient,
  params: RecordCheckResultParams
): Promise<CheckRecordOutcome> {
  const evidenceTime = params.checkedAt ?? new Date();

  // Run in a transaction if this is a Pool
  const client = 'connect' in poolOrClient ? await poolOrClient.connect() : poolOrClient;
  const isDedicatedClient = 'connect' in poolOrClient;

  try {
    if (isDedicatedClient) {
      await client.query('BEGIN');
    }

    // 1. Verify lease fencing and lock row FOR UPDATE.
    // Production ALWAYS uses database clock NOW() for lease expiry fencing.
    // testLeaseExpiryNow is exclusively permitted in tests to verify clock edge cases.
    const curRes = await client.query(
      `SELECT * FROM app.app_monitors
       WHERE id = $1
         AND claim_token = $2
         AND (lease_expires_at IS NULL OR lease_expires_at >= COALESCE($3, NOW()))
       FOR UPDATE`,
      [params.monitorId, params.claimToken, params.testLeaseExpiryNow ?? null]
    );

    if (curRes.rows.length === 0) {
      // Lease write fence violation (stale worker or expired lease)
      if (isDedicatedClient) {
        await client.query('COMMIT');
      }
      return { monitor: null, incident: null, incidentAction: 'none' };
    }

    const current = mapMonitorRow(curRes.rows[0]);

    // If monitor was paused while check was in flight, drop result
    if (!current.isActive) {
      if (isDedicatedClient) {
        await client.query('COMMIT');
      }
      return { monitor: current, incident: null, incidentAction: 'none' };
    }

    // 2. Fetch any open incident for this monitor
    const incRes = await client.query(
      `SELECT * FROM app.app_monitor_incidents
       WHERE monitor_id = $1 AND status = 'open'
       FOR UPDATE
       LIMIT 1`,
      [current.id]
    );
    const openIncident = incRes.rows.length > 0 ? mapIncidentRow(incRes.rows[0]) : null;

    let nextFailures = current.consecutiveFailures;
    let nextSuccesses = current.consecutiveSuccesses;
    let nextStatus: MonitorStatus = current.lastStatus;
    let resultingIncident: AppMonitorIncident | null = openIncident;
    let incidentAction: 'none' | 'opened' | 'updated' | 'resolved' = 'none';

    const evidence: MonitorEvidence = {
      httpStatus: params.httpStatus,
      probeKind: 'http',
      providerState: params.providerState,
      checkedAt: evidenceTime.toISOString(),
    };

    if (!params.probeOk) {
      // Failure
      nextFailures = current.consecutiveFailures + 1;
      nextSuccesses = 0;
      nextStatus = 'degraded';

      if (nextFailures === 3) {
        if (!openIncident) {
          const newIncidentId = `inc_${crypto.randomUUID().replace(/-/g, '')}`;
          const insertedInc = await client.query(
            `INSERT INTO app.app_monitor_incidents (
               id, workspace_id, monitor_id, status, failure_count, evidence, opened_at, last_failed_at
             )
             VALUES ($1, $2, $3, 'open', $4, $5, $6, $6)
             RETURNING *`,
            [newIncidentId, current.workspaceId, current.id, nextFailures, JSON.stringify(evidence), evidenceTime]
          );
          resultingIncident = mapIncidentRow(insertedInc.rows[0]);
          incidentAction = 'opened';
        } else {
          // Open incident already exists, update it
          const updatedInc = await client.query(
            `UPDATE app.app_monitor_incidents
             SET failure_count = $1,
                 last_failed_at = $2,
                 evidence = $3
             WHERE id = $4
             RETURNING *`,
            [nextFailures, evidenceTime, JSON.stringify(evidence), openIncident.id]
          );
          resultingIncident = mapIncidentRow(updatedInc.rows[0]);
          incidentAction = 'updated';
        }
      } else if (nextFailures > 3 && openIncident) {
        const updatedInc = await client.query(
          `UPDATE app.app_monitor_incidents
           SET failure_count = $1,
               last_failed_at = $2,
               evidence = $3
           WHERE id = $4
           RETURNING *`,
          [nextFailures, evidenceTime, JSON.stringify(evidence), openIncident.id]
        );
        resultingIncident = mapIncidentRow(updatedInc.rows[0]);
        incidentAction = 'updated';
      }
    } else {
      // Success
      nextSuccesses = current.consecutiveSuccesses + 1;
      nextFailures = 0;

      if (openIncident) {
        if (nextSuccesses >= 3 && params.providerConfirmedRecovery === true) {
          // 3 consecutive successes AND provider confirmation: recover incident!
          const resolvedInc = await client.query(
            `UPDATE app.app_monitor_incidents
             SET status = 'resolved',
                 resolved_at = $1,
                 evidence = $2
             WHERE id = $3
             RETURNING *`,
            [evidenceTime, JSON.stringify(evidence), openIncident.id]
          );
          resultingIncident = mapIncidentRow(resolvedInc.rows[0]);
          incidentAction = 'resolved';
          nextStatus = 'healthy';
        } else {
          // Incident remains open; stay truthful in recovering state
          nextStatus = 'recovering';
          resultingIncident = openIncident;
          incidentAction = 'none';
        }
      } else {
        nextStatus = 'healthy';
      }
    }

    const nextCheckAt = new Date(evidenceTime.getTime() + current.intervalSeconds * 1000);

    // 3. Clear claim and release lease
    const updateRes = await client.query(
      `UPDATE app.app_monitors
       SET consecutive_failures = $1,
           consecutive_successes = $2,
           last_status = $3,
           last_checked_at = $4,
           next_check_at = $5,
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [nextFailures, nextSuccesses, nextStatus, evidenceTime, nextCheckAt, current.id]
    );

    if (isDedicatedClient) {
      await client.query('COMMIT');
    }

    return {
      monitor: mapMonitorRow(updateRes.rows[0]),
      incident: resultingIncident,
      incidentAction,
    };
  } catch (err) {
    if (isDedicatedClient) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw err;
  } finally {
    if (isDedicatedClient) {
      (client as pg.PoolClient).release();
    }
  }
}

export async function getOpenIncidentForMonitor(
  poolOrClient: pg.Pool | pg.PoolClient,
  monitorId: string
): Promise<AppMonitorIncident | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.app_monitor_incidents
     WHERE monitor_id = $1 AND status = 'open'
     LIMIT 1`,
    [monitorId]
  );
  if (res.rows.length === 0) return null;
  return mapIncidentRow(res.rows[0]);
}

export async function listMonitorIncidents(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  monitorId?: string
): Promise<AppMonitorIncident[]> {
  const values: any[] = [scope.workspaceId];
  let query = `SELECT * FROM app.app_monitor_incidents WHERE workspace_id = $1`;
  if (monitorId) {
    values.push(monitorId);
    query += ` AND monitor_id = $2`;
  }
  query += ` ORDER BY opened_at DESC`;

  const res = await poolOrClient.query(query, values);
  return res.rows.map(mapIncidentRow);
}
