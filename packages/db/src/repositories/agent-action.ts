import crypto from 'node:crypto';
import pg from 'pg';
import { AppError } from '@laira/security';
import {
  DeploymentProposalSchema,
  hashDeploymentProposal,
  type DeploymentProposal,
} from '@laira/domain';
import { validateSafeEventPayload } from '../schema/events.js';
import type { Run } from './run.js';
import type { WorkspaceScope } from './workspace.js';

export const ALLOWED_CONNECTION_STATUSES = new Set(['active', 'configured_unverified']);
export const DEFAULT_LEASE_TIMEOUT_MS = 30 * 1000; // 30-second worker lease freshness

export interface ApproveAgentActionParams {
  sourceRunId: string;
  proposalHash: string;
  ownerId: string;
  now?: Date;
}

export interface ApprovedAgentAction {
  approvalId: string;
  workspaceId: string;
  sourceRunId: string;
  executionRunId: string;
  proposal: DeploymentProposal;
  proposalHash: string;
  ownerId: string;
  approvedAt: Date;
  expiresAt: Date;
  dispatchedAt: Date | null;
  credentialVersion: number;
  connectionId: string;
  sourceRun: {
    id: string;
    type: string;
    status: string;
    finishedAt: Date | null;
  };
}

export interface ClaimDispatchOptions {
  now?: Date;
  leaseTimeoutMs?: number;
}

function mapRunRow(row: any): Run {
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
 * Durably approves an agent proposal and creates an execution run in a single transaction.
 *
 * Rules:
 * - Validates finite 'now' timestamp.
 * - Scoped strictly to workspaceId.
 * - Verifies ownerId matches app.workspaces.owner_user_id.
 * - Locks source run FOR UPDATE to serialize concurrent approval attempts.
 * - Source run must be type='agent_task' and status='succeeded'.
 * - Source run finished_at must be strictly within 30 minutes of now (>= 30m is rejected).
 * - Strictly requires source output to contain output.proposedAction and output.proposalHash.
 * - Computes and verifies canonical SHA-256 hash using @laira/domain.
 * - Connection must belong to workspace, have provider='liara', status in ('active', 'configured_unverified'),
 *   and active_version must match proposal.credentialVersion.
 * - Locks connection FOR UPDATE to prevent concurrent credential rotation during approval.
 * - Dedicated table app.agent_action_approvals binds source_run_id UNIQUE.
 * - Inserts approval + run(type='agent_action', input={ approvalId }) + initial event + outbox atomically.
 * - Idempotent replay: if already approved with same hash, returns existing execution run.
 *   If expired and still queued, rejects with EXPIRED.
 */
export async function approveAgentAction(
  pool: pg.Pool,
  scope: WorkspaceScope,
  params: ApproveAgentActionParams
): Promise<Run> {
  const now = params.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Invalid now timestamp: Date must be valid and finite',
      statusCode: 400,
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verify workspace existence and validate owner_user_id
    const wsRes = await client.query(
      `SELECT id, owner_user_id FROM app.workspaces WHERE id = $1 LIMIT 1`,
      [scope.workspaceId]
    );

    if (wsRes.rows.length === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Workspace not found',
        statusCode: 404,
      });
    }

    if (wsRes.rows[0].owner_user_id !== params.ownerId) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only workspace owner can approve agent actions',
        statusCode: 403,
      });
    }

    // 2. Lock source run FOR UPDATE to prevent race conditions
    const sourceRes = await client.query(
      `SELECT * FROM app.runs
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [params.sourceRunId, scope.workspaceId]
    );

    if (sourceRes.rows.length === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Source run not found in workspace',
        statusCode: 404,
      });
    }

    const sourceRow = sourceRes.rows[0];

    // 3. Check if approval already exists for this source_run_id (repeated approval)
    const existingApprRes = await client.query(
      `SELECT * FROM app.agent_action_approvals
       WHERE source_run_id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [params.sourceRunId, scope.workspaceId]
    );

    if (existingApprRes.rows.length > 0) {
      const existing = existingApprRes.rows[0];

      // Proposal hash must strictly match
      if (existing.proposal_hash !== params.proposalHash) {
        throw new AppError({
          code: 'APPROVAL_DRIFT',
          message: 'Supplied proposalHash does not match existing approval proposal hash',
          statusCode: 409,
        });
      }

      // Fetch existing execution run
      const execRes = await client.query(
        `SELECT * FROM app.runs
         WHERE id = $1 AND workspace_id = $2
         LIMIT 1`,
        [existing.execution_run_id, scope.workspaceId]
      );

      if (execRes.rows.length === 0) {
        throw new AppError({
          code: 'NOT_FOUND',
          message: 'Execution run for existing approval not found',
          statusCode: 404,
        });
      }

      const execRow = execRes.rows[0];

      // Expiration check: if expired and still queued, deny with EXPIRED.
      // If non-queued (running, succeeded, etc.), return existing execution run.
      if (now.getTime() >= new Date(existing.expires_at).getTime()) {
        if (execRow.status === 'queued') {
          throw new AppError({
            code: 'EXPIRED',
            message: 'Approval has expired',
            statusCode: 410,
          });
        }
      }

      await client.query('COMMIT');
      return mapRunRow(execRow);
    }

    // 4. Validate source run prerequisites
    if (sourceRow.type !== 'agent_task') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: `Invalid source run type: expected "agent_task", got "${sourceRow.type}"`,
        statusCode: 412,
      });
    }

    if (sourceRow.status !== 'succeeded') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: `Source run status must be "succeeded", got "${sourceRow.status}"`,
        statusCode: 412,
      });
    }

    if (!sourceRow.finished_at) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Source run has no finished_at timestamp',
        statusCode: 412,
      });
    }

    const finishedAt = new Date(sourceRow.finished_at);
    // Exact deadline: >= 30 minutes is rejected
    if (now.getTime() - finishedAt.getTime() >= 30 * 60 * 1000 || now.getTime() < finishedAt.getTime()) {
      throw new AppError({
        code: 'EXPIRED',
        message: 'Source run finished more than 30 minutes ago',
        statusCode: 410,
      });
    }

    // 5. Strictly require output.proposedAction and output.proposalHash
    const output = sourceRow.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Source run output is missing or invalid',
        statusCode: 412,
      });
    }

    const rawOutput = output as Record<string, unknown>;
    if (!rawOutput.proposedAction || typeof rawOutput.proposedAction !== 'object') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Source run output must contain a valid proposedAction object',
        statusCode: 412,
      });
    }

    if (typeof rawOutput.proposalHash !== 'string' || rawOutput.proposalHash !== params.proposalHash) {
      throw new AppError({
        code: 'APPROVAL_DRIFT',
        message: 'Source output proposalHash is missing or does not match supplied proposalHash',
        statusCode: 409,
      });
    }

    let parsedProposal: DeploymentProposal;
    try {
      parsedProposal = DeploymentProposalSchema.parse(rawOutput.proposedAction);
    } catch (parseErr) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Source run proposedAction is invalid against schema',
        statusCode: 400,
        cause: parseErr,
      });
    }

    const computedHash = hashDeploymentProposal(parsedProposal);
    if (computedHash !== params.proposalHash) {
      throw new AppError({
        code: 'APPROVAL_DRIFT',
        message: 'Supplied proposalHash does not match computed proposal hash',
        statusCode: 409,
      });
    }

    // 6. Validate and lock connection FOR UPDATE
    const connRes = await client.query(
      `SELECT id, workspace_id, provider, status, active_version
       FROM app.connections
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [parsedProposal.connectionId, scope.workspaceId]
    );

    if (connRes.rows.length === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Connection not found in workspace',
        statusCode: 404,
      });
    }

    const connRow = connRes.rows[0];

    // Connection provider must be 'liara'
    if (connRow.provider !== 'liara') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: `Connection provider must be "liara", got "${connRow.provider}"`,
        statusCode: 412,
      });
    }

    if (!ALLOWED_CONNECTION_STATUSES.has(connRow.status)) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: `Connection status "${connRow.status}" is not eligible for execution. Expected "active" or "configured_unverified".`,
        statusCode: 412,
      });
    }

    if (connRow.active_version !== parsedProposal.credentialVersion) {
      throw new AppError({
        code: 'APPROVAL_DRIFT',
        message: `Connection active credential version (${connRow.active_version}) does not match proposal credential version (${parsedProposal.credentialVersion})`,
        statusCode: 409,
      });
    }

    // 7. Atomic creation in same transaction
    const approvalId = `appr_${crypto.randomUUID().replace(/-/g, '')}`;
    const executionRunId = `run_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    // 7a. Insert execution run (input ONLY approvalId)
    const runRes = await client.query(
      `INSERT INTO app.runs (id, workspace_id, project_id, type, status, input, created_at, updated_at)
       VALUES ($1, $2, $3, 'agent_action', 'queued', $4::jsonb, NOW(), NOW())
       RETURNING *`,
      [
        executionRunId,
        scope.workspaceId,
        sourceRow.project_id ?? null,
        JSON.stringify({ approvalId }),
      ]
    );
    const runRow = runRes.rows[0];

    // 7b. Insert initial RunEvent (seq = 1)
    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const initialPayload = validateSafeEventPayload('run_started', {
      step: 'init',
      message: 'Agent action queued for execution',
    });

    await client.query(
      `INSERT INTO app.run_events (id, workspace_id, run_id, seq, type, payload, created_at)
       VALUES ($1, $2, $3, 1, 'run_started', $4::jsonb, NOW())`,
      [eventId, scope.workspaceId, executionRunId, JSON.stringify(initialPayload)]
    );

    // 7c. Insert outbox item
    const outboxId = `out_${crypto.randomUUID().replace(/-/g, '')}`;
    await client.query(
      `INSERT INTO app.outbox (id, workspace_id, topic, payload, status, created_at, updated_at)
       VALUES ($1, $2, 'run.dispatched', $3::jsonb, 'pending', NOW(), NOW())`,
      [outboxId, scope.workspaceId, JSON.stringify({ runId: executionRunId })]
    );

    // 7d. Insert approval record with frozen proposal copy
    await client.query(
      `INSERT INTO app.agent_action_approvals (
         id, workspace_id, source_run_id, execution_run_id,
         proposal_hash, frozen_proposal, owner_id,
         approved_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        approvalId,
        scope.workspaceId,
        params.sourceRunId,
        executionRunId,
        params.proposalHash,
        JSON.stringify(parsedProposal),
        params.ownerId,
        now,
        expiresAt,
      ]
    );

    await client.query('COMMIT');
    return mapRunRow(runRow);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves an approved agent action joined with the source run.
 * Uses the frozen proposal copy stored in the approval record and verifies hash integrity
 * to guarantee immunity from later drift or DB tampering.
 */
export async function getApprovedAgentAction(
  poolOrClient: pg.Pool | pg.PoolClient,
  scope: WorkspaceScope,
  executionRunId: string
): Promise<ApprovedAgentAction | null> {
  const res = await poolOrClient.query(
    `SELECT
       a.id AS approval_id,
       a.workspace_id,
       a.source_run_id,
       a.execution_run_id,
       a.proposal_hash,
       a.frozen_proposal,
       a.owner_id,
       a.approved_at,
       a.expires_at,
       a.dispatched_at,
       sr.id AS src_id,
       sr.type AS src_type,
       sr.status AS src_status,
       sr.finished_at AS src_finished_at
     FROM app.agent_action_approvals a
     JOIN app.runs sr ON sr.id = a.source_run_id AND sr.workspace_id = a.workspace_id
     WHERE a.execution_run_id = $1 AND a.workspace_id = $2
     LIMIT 1`,
    [executionRunId, scope.workspaceId]
  );

  if (res.rows.length === 0) {
    return null;
  }

  const row = res.rows[0];

  let proposal: DeploymentProposal;
  try {
    proposal = DeploymentProposalSchema.parse(row.frozen_proposal);
  } catch {
    return null;
  }

  // Verify hash snapshot integrity against frozen proposal
  const verifiedHash = hashDeploymentProposal(proposal);
  if (verifiedHash !== row.proposal_hash) {
    return null;
  }

  return {
    approvalId: row.approval_id,
    workspaceId: row.workspace_id,
    sourceRunId: row.source_run_id,
    executionRunId: row.execution_run_id,
    proposal,
    proposalHash: row.proposal_hash,
    ownerId: row.owner_id,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    dispatchedAt: row.dispatched_at,
    credentialVersion: proposal.credentialVersion,
    connectionId: proposal.connectionId,
    sourceRun: {
      id: row.src_id,
      type: row.src_type,
      status: row.src_status,
      finishedAt: row.src_finished_at,
    },
  };
}

/**
 * Atomically claims an approved agent action for dispatch before performing any infrastructure mutation (write-ahead).
 *
 * Enforces:
 * - Finite timestamp validation on now.
 * - Run must be status='running' and claimed_by=workerId.
 * - Worker heartbeat must be fresh (heartbeat_at within leaseTimeoutMs, default 30s).
 * - Approval dispatched_at must be NULL (single dispatch only).
 * - Approval must not be expired (now < expires_at).
 * - Connection must belong to workspace, have provider='liara', status in ('active', 'configured_unverified'),
 *   and active_version must match proposal.credentialVersion.
 * - Atomically locks approval, run, AND connection row with FOR UPDATE OF a, r, c (serializing concurrent rotation).
 * - Updates dispatched_at to NOW in the same transaction.
 *
 * Returns true if successfully claimed, false otherwise.
 */
export async function claimAgentActionDispatch(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  optionsOrNow: ClaimDispatchOptions | Date = new Date()
): Promise<boolean> {
  const now = optionsOrNow instanceof Date ? optionsOrNow : (optionsOrNow.now ?? new Date());
  const leaseTimeoutMs =
    optionsOrNow instanceof Date
      ? DEFAULT_LEASE_TIMEOUT_MS
      : (optionsOrNow.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS);

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return false;
  }

  const isPool = 'connect' in poolOrClient;
  const client = isPool ? await (poolOrClient as pg.Pool).connect() : (poolOrClient as pg.PoolClient);

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    // INNER JOIN connections to allow locking FOR UPDATE OF a, r, c
    const res = await client.query(
      `SELECT
         a.id AS approval_id,
         a.workspace_id,
         a.expires_at,
         a.dispatched_at,
         a.frozen_proposal,
         r.status AS run_status,
         r.claimed_by AS run_claimed_by,
         r.heartbeat_at AS run_heartbeat_at,
         c.id AS conn_id,
         c.provider AS conn_provider,
         c.active_version AS conn_active_version,
         c.status AS conn_status
       FROM app.agent_action_approvals a
       JOIN app.runs r ON r.id = a.execution_run_id AND r.workspace_id = a.workspace_id
       INNER JOIN app.connections c ON c.id = (a.frozen_proposal->>'connectionId') AND c.workspace_id = a.workspace_id
       WHERE a.execution_run_id = $1
       FOR UPDATE OF a, r, c`,
      [runId]
    );

    if (res.rows.length === 0) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    const row = res.rows[0];

    // 1. Only once: dispatched_at must be null
    if (row.dispatched_at !== null) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 2. Expiry check (must not be expired)
    if (now.getTime() >= new Date(row.expires_at).getTime()) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 3. Worker check
    if (row.run_claimed_by !== workerId) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 4. Status check: run must be 'running'
    if (row.run_status !== 'running') {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 5. Worker lease freshness check: heartbeat_at must be within leaseTimeoutMs
    if (!row.run_heartbeat_at) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    const heartbeatAt = new Date(row.run_heartbeat_at);
    if (now.getTime() - heartbeatAt.getTime() > leaseTimeoutMs || now.getTime() < heartbeatAt.getTime()) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 6. Connection provider check: must be 'liara'
    if (row.conn_provider !== 'liara') {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 7. Connection status check
    if (!row.conn_status || !ALLOWED_CONNECTION_STATUSES.has(row.conn_status)) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // 8. Active version check against frozen proposal
    const proposal = row.frozen_proposal;
    const requiredCredVer = Number(proposal?.credentialVersion);
    if (row.conn_active_version !== requiredCredVer) {
      if (isPool) await client.query('ROLLBACK');
      return false;
    }

    // Atomically claim dispatch
    await client.query(
      `UPDATE app.agent_action_approvals
       SET dispatched_at = $1
       WHERE id = $2 AND dispatched_at IS NULL`,
      [now, row.approval_id]
    );

    if (isPool) {
      await client.query('COMMIT');
    }

    return true;
  } catch (err) {
    if (isPool) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}
