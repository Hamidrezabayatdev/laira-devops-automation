import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { runMigrations } from '../src/migrator.js';
import { getOrCreateOwnerWorkspace } from '../src/repositories/workspace.js';
import { createConnection } from '../src/repositories/connection.js';
import {
  approveAgentAction,
  getApprovedAgentAction,
  claimAgentActionDispatch,
} from '../src/repositories/agent-action.js';
import {
  hashDeploymentProposal,
  type DeployProposal,
  type RestartProposal,
} from '@laira/domain';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Agent Action Approvals and Durable Execution', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  async function createTrackedWorkspace(name: string, suffix: string) {
    const { user, workspace } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name },
      githubUserId: `gh_action_${Date.now()}_${suffix}_${Math.floor(Math.random() * 100000)}`,
      workspaceName: `Workspace ${suffix}`,
    });
    trackedWorkspaceIds.add(workspace.id);
    return { user, workspace };
  }

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping DB tests: TEST_DATABASE_URL is not set.');
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

  it.skipIf(!testDbUrl)('verifies migration 0003 schema, constraints, and owner inspection', async () => {
    // 1. Table existence
    const tableRes = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'app' AND table_name = 'agent_action_approvals'
    `);
    expect(tableRes.rows.length).toBe(1);

    // 2. Foreign keys and unique constraints
    const constraintsRes = await pool.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'app.agent_action_approvals'::regclass
    `);
    const conNames = constraintsRes.rows.map((r) => r.conname);
    expect(conNames).toContain('agent_action_approvals_source_run_id_key');
    expect(conNames).toContain('agent_action_approvals_execution_run_id_key');
    expect(conNames).toContain('agent_action_approvals_ws_id_unique');
    expect(conNames).toContain('agent_action_approvals_ws_source_run_unique');
    expect(conNames).toContain('agent_action_approvals_ws_exec_run_unique');
    expect(conNames).toContain('agent_action_approvals_source_run_fkey');
    expect(conNames).toContain('agent_action_approvals_execution_run_fkey');

    // 3. Exact column inspection on workspaces.owner_user_id
    const colRes = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'workspaces' AND column_name = 'owner_user_id'
    `);
    expect(colRes.rows.length).toBe(1);
  });

  it.skipIf(!testDbUrl)('approves valid action atomically with execution run, event, and outbox', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'atomic_approve');

    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: DeployProposal = {
      kind: 'deploy',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
      platform: 'node',
      port: 3000,
      repository: {
        owner: 'acme-corp',
        repo: 'payment-svc',
        commitSha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      },
      bundleDigest: 'sha256:' + 'a'.repeat(64),
    };

    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    // Insert source succeeded agent_task run
    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at, created_at, updated_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW(), NOW(), NOW())`,
      [
        sourceRunId,
        workspace.id,
        JSON.stringify({
          message: 'Deployment planned successfully',
          proposedAction: proposal,
          proposalHash,
        }),
      ]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    expect(execRun).toBeDefined();
    expect(execRun.type).toBe('agent_action');
    expect(execRun.status).toBe('queued');
    expect(execRun.workspaceId).toBe(workspace.id);
    expect(execRun.input).toEqual({ approvalId: expect.stringMatching(/^appr_/) });

    const approvalId = (execRun.input as { approvalId: string }).approvalId;

    // Check approval record
    const apprRes = await pool.query(
      `SELECT * FROM app.agent_action_approvals WHERE id = $1`,
      [approvalId]
    );
    expect(apprRes.rows.length).toBe(1);
    const apprRow = apprRes.rows[0];
    expect(apprRow.source_run_id).toBe(sourceRunId);
    expect(apprRow.execution_run_id).toBe(execRun.id);
    expect(apprRow.proposal_hash).toBe(proposalHash);
    expect(apprRow.frozen_proposal).toEqual(proposal);
    expect(apprRow.owner_id).toBe(user.id);
    expect(apprRow.dispatched_at).toBeNull();

    // Check initial RunEvent
    const eventRes = await pool.query(
      `SELECT * FROM app.run_events WHERE run_id = $1`,
      [execRun.id]
    );
    expect(eventRes.rows.length).toBe(1);
    expect(eventRes.rows[0].seq).toBe(1);
    expect(eventRes.rows[0].type).toBe('run_started');

    // Check outbox item
    const outboxRes = await pool.query(
      `SELECT * FROM app.outbox WHERE workspace_id = $1 AND payload->>'runId' = $2`,
      [workspace.id, execRun.id]
    );
    expect(outboxRes.rows.length).toBe(1);
    expect(outboxRes.rows[0].topic).toBe('run.dispatched');
    expect(outboxRes.rows[0].status).toBe('pending');

    // Test getApprovedAgentAction
    const fetched = await getApprovedAgentAction(pool, { workspaceId: workspace.id }, execRun.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.approvalId).toBe(approvalId);
    expect(fetched!.proposal).toEqual(proposal);
    expect(fetched!.proposalHash).toBe(proposalHash);
    expect(fetched!.credentialVersion).toBe(1);
    expect(fetched!.connectionId).toBe(conn.id);
    expect(fetched!.dispatchedAt).toBeNull();
    expect(fetched!.sourceRun.id).toBe(sourceRunId);
    expect(fetched!.sourceRun.status).toBe('succeeded');
  });

  it.skipIf(!testDbUrl)('denies approval when caller is not the workspace owner', async () => {
    const { workspace } = await createTrackedWorkspace('Owner User', 'auth_scope');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    // Call with random attacker user ID
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: 'usr_attacker_999' }
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it.skipIf(!testDbUrl)('rejects foreign hash or approval drift against proposal', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'drift_hash');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const realHash = hashDeploymentProposal(proposal);
    const forgedHash = 'f'.repeat(64);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash: realHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash: forgedHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'APPROVAL_DRIFT',
      statusCode: 409,
    });
  });

  it.skipIf(!testDbUrl)('rejects source run completed more than 30 minutes ago (expired)', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'expired_source');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    // Finished 31 minutes ago
    const expiredFinishedAt = new Date(Date.now() - 31 * 60 * 1000);

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, $4)`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash }), expiredFinishedAt]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'EXPIRED',
      statusCode: 410,
    });
  });

  it.skipIf(!testDbUrl)('rejects when connection active_version has drifted', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'cred_drift');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    // Update connection active_version in DB to 2
    await pool.query(
      `UPDATE app.connections SET active_version = 2 WHERE id = $1`,
      [conn.id]
    );

    // Proposal was planned against version 1
    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'APPROVAL_DRIFT',
      statusCode: 409,
    });
  });

  it.skipIf(!testDbUrl)('idempotent repeated approvals and concurrent race single outbox guarantee', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'concurrent_race');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    // Launch two concurrent approval requests simultaneously
    const [run1, run2] = await Promise.all([
      approveAgentAction(pool, { workspaceId: workspace.id }, { sourceRunId, proposalHash, ownerId: user.id }),
      approveAgentAction(pool, { workspaceId: workspace.id }, { sourceRunId, proposalHash, ownerId: user.id }),
    ]);

    // Both should return the EXACT same execution run
    expect(run1.id).toBe(run2.id);

    // Exactly one approval record exists
    const apprRes = await pool.query(
      `SELECT * FROM app.agent_action_approvals WHERE source_run_id = $1`,
      [sourceRunId]
    );
    expect(apprRes.rows.length).toBe(1);

    // Exactly one outbox message exists
    const outboxRes = await pool.query(
      `SELECT * FROM app.outbox WHERE workspace_id = $1 AND payload->>'runId' = $2`,
      [workspace.id, run1.id]
    );
    expect(outboxRes.rows.length).toBe(1);

    // Repeated sequential call also returns identical run without writing anything new
    const run3 = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );
    expect(run3.id).toBe(run1.id);
  });

  it.skipIf(!testDbUrl)('enforces write-ahead single-dispatch claiming and rejects re-dispatch', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'dispatch_claim');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    const workerId = 'worker_test_1';

    // 1. Claim while still 'queued' -> fails (must be 'running' with worker claimed)
    const claimBeforeRunning = await claimAgentActionDispatch(pool, workerId, execRun.id);
    expect(claimBeforeRunning).toBe(false);

    // 2. Worker claims run and marks status 'running' with fresh heartbeat
    await pool.query(
      `UPDATE app.runs
       SET status = 'running', claimed_by = $1, claimed_at = NOW(), heartbeat_at = NOW()
       WHERE id = $2`,
      [workerId, execRun.id]
    );

    // 3. First claim succeeds atomically (write-ahead)
    const firstClaim = await claimAgentActionDispatch(pool, workerId, execRun.id);
    expect(firstClaim).toBe(true);

    // DB inspection confirms dispatched_at is set
    const apprAfterClaim = await getApprovedAgentAction(pool, { workspaceId: workspace.id }, execRun.id);
    expect(apprAfterClaim!.dispatchedAt).not.toBeNull();

    // 4. Repeated claim attempt fails (write-ahead only once, prevents redelivery / duplicate mutation)
    const secondClaim = await claimAgentActionDispatch(pool, workerId, execRun.id);
    expect(secondClaim).toBe(false);

    // 5. Another worker cannot claim either
    const otherWorkerClaim = await claimAgentActionDispatch(pool, 'worker_test_2', execRun.id);
    expect(otherWorkerClaim).toBe(false);
  });

  it.skipIf(!testDbUrl)('enforces cross-workspace isolation across runs, connections, and approvals', async () => {
    const { user: userA, workspace: wsA } = await createTrackedWorkspace('User A', 'cross_ws_a');
    const { user: userB, workspace: wsB } = await createTrackedWorkspace('User B', 'cross_ws_b');

    const connA = await createConnection(pool, { workspaceId: wsA.id }, {
      name: 'Conn A',
      provider: 'liara',
    });
    const connB = await createConnection(pool, { workspaceId: wsB.id }, {
      name: 'Conn B',
      provider: 'liara',
    });

    const proposalB: RestartProposal = {
      kind: 'restart',
      connectionId: connB.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHashB = hashDeploymentProposal(proposalB);
    const runIdB = `run_b_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [runIdB, wsB.id, JSON.stringify({ proposedAction: proposalB, proposalHash: proposalHashB })]
    );

    // 1. wsA cannot approve run from wsB
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: wsA.id },
        { sourceRunId: runIdB, proposalHash: proposalHashB, ownerId: userA.id }
      )
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    // 2. wsA cannot approve proposal referencing connB from wsB
    const crossConnProposal: RestartProposal = {
      kind: 'restart',
      connectionId: connB.id, // Connection belongs to wsB, not wsA!
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const crossConnHash = hashDeploymentProposal(crossConnProposal);
    const runIdA = `run_a_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [runIdA, wsA.id, JSON.stringify({ proposedAction: crossConnProposal, proposalHash: crossConnHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: wsA.id },
        { sourceRunId: runIdA, proposalHash: crossConnHash, ownerId: userA.id }
      )
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    // 3. getApprovedAgentAction cannot cross workspaces
    const validProposalB: RestartProposal = {
      kind: 'restart',
      connectionId: connB.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const execRunB = await approveAgentAction(
      pool,
      { workspaceId: wsB.id },
      { sourceRunId: runIdB, proposalHash: proposalHashB, ownerId: userB.id }
    );

    const crossGet = await getApprovedAgentAction(pool, { workspaceId: wsA.id }, execRunB.id);
    expect(crossGet).toBeNull();
  });

  it.skipIf(!testDbUrl)('rejects non-succeeded source runs or invalid run types', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'source_states');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);

    // Failed source run
    const failedRunId = `run_failed_${crypto.randomUUID().replace(/-/g, '')}`;
    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'failed', $3::jsonb, NOW())`,
      [failedRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId: failedRunId, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      statusCode: 412,
    });

    // Wrong run type (e.g. 'workflow')
    const wrongTypeRunId = `run_wrong_${crypto.randomUUID().replace(/-/g, '')}`;
    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'workflow', 'succeeded', $3::jsonb, NOW())`,
      [wrongTypeRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId: wrongTypeRunId, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      statusCode: 412,
    });
  });

  it.skipIf(!testDbUrl)('handles repeated approval expiration: rejects queued but allows non-queued', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'repeat_expired');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    // Simulate 35 minutes in the future (approval expired)
    const futureDate = new Date(Date.now() + 35 * 60 * 1000);

    // Case 1: Run is still 'queued' -> expired re-approval is rejected
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id, now: futureDate }
      )
    ).rejects.toMatchObject({
      code: 'EXPIRED',
      statusCode: 410,
    });

    // Case 2: Run has started executing (status = 'running' / non-queued) -> returns existing execution run
    await pool.query(`UPDATE app.runs SET status = 'running' WHERE id = $1`, [execRun.id]);

    const reApproved = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id, now: futureDate }
    );
    expect(reApproved.id).toBe(execRun.id);
  });

  it.skipIf(!testDbUrl)('claimAgentActionDispatch rejects expired approvals and credential drift', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'dispatch_edge_cases');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    const workerId = 'worker_edge_case';
    await pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = $1, claimed_at = NOW(), heartbeat_at = NOW() WHERE id = $2`,
      [workerId, execRun.id]
    );

    // 1. Expired approval: now > expires_at
    const futureDate = new Date(Date.now() + 35 * 60 * 1000);
    const expiredClaim = await claimAgentActionDispatch(pool, workerId, execRun.id, futureDate);
    expect(expiredClaim).toBe(false);

    // 2. Credential drift: connection active_version changes before dispatch
    await pool.query(`UPDATE app.connections SET active_version = 2 WHERE id = $1`, [conn.id]);
    const driftedClaim = await claimAgentActionDispatch(pool, workerId, execRun.id);
    expect(driftedClaim).toBe(false);
  });

  it.skipIf(!testDbUrl)('allows connection status active and configured_unverified, but rejects revoked/disabled/error', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'conn_statuses');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Unverified',
      provider: 'liara',
    });

    // 1. Connection with status 'configured_unverified' is allowed
    await pool.query(
      `UPDATE app.connections SET status = 'configured_unverified' WHERE id = $1`,
      [conn.id]
    );

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );
    expect(execRun).toBeDefined();

    // Verify claimAgentActionDispatch also permits configured_unverified
    const workerId = 'worker_unverified_test';
    await pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = $1, claimed_at = NOW(), heartbeat_at = NOW() WHERE id = $2`,
      [workerId, execRun.id]
    );
    const claimRes = await claimAgentActionDispatch(pool, workerId, execRun.id);
    expect(claimRes).toBe(true);

    // 2. Disallowed connection statuses: revoked, disabled, error
    for (const invalidStatus of ['revoked', 'disabled', 'error']) {
      await pool.query(
        `UPDATE app.connections SET status = $1 WHERE id = $2`,
        [invalidStatus, conn.id]
      );

      const invalidRunId = `run_src_${invalidStatus}_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
         VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
        [invalidRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
      );

      await expect(
        approveAgentAction(
          pool,
          { workspaceId: workspace.id },
          { sourceRunId: invalidRunId, proposalHash, ownerId: user.id }
        )
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        statusCode: 412,
      });
    }
  });

  it.skipIf(!testDbUrl)('strictly requires connection provider to be liara (rejects boxapi)', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'provider_liara');
    const boxapiConn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'BoxAPI Conn',
      provider: 'boxapi',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: boxapiConn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    // Rejection on approveAgentAction
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      statusCode: 412,
    });
  });

  it.skipIf(!testDbUrl)('enforces heartbeat lease freshness on claimAgentActionDispatch', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'heartbeat_lease');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    const workerId = 'worker_lease_test';

    // 1. Missing heartbeat_at -> fails
    await pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = $1, claimed_at = NOW(), heartbeat_at = NULL WHERE id = $2`,
      [workerId, execRun.id]
    );
    expect(await claimAgentActionDispatch(pool, workerId, execRun.id)).toBe(false);

    // 2. Stale heartbeat_at (> 30 seconds ago) -> fails
    const staleHeartbeat = new Date(Date.now() - 35 * 1000);
    await pool.query(
      `UPDATE app.runs SET heartbeat_at = $1 WHERE id = $2`,
      [staleHeartbeat, execRun.id]
    );
    expect(await claimAgentActionDispatch(pool, workerId, execRun.id)).toBe(false);

    // 3. Fresh heartbeat_at (e.g. 5 seconds ago) -> succeeds!
    const freshHeartbeat = new Date(Date.now() - 5 * 1000);
    await pool.query(
      `UPDATE app.runs SET heartbeat_at = $1 WHERE id = $2`,
      [freshHeartbeat, execRun.id]
    );
    expect(await claimAgentActionDispatch(pool, workerId, execRun.id)).toBe(true);
  });

  it.skipIf(!testDbUrl)('validates finite Date on now parameter and enforces exact 30m boundary', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'finite_now');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    const baseTime = new Date();
    // Exactly 30 minutes ago
    const exact30m = new Date(baseTime.getTime() - 30 * 60 * 1000);

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, $4)`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash }), exact30m]
    );

    // Invalid Date (NaN) rejected upfront
    const invalidDate = new Date('invalid date string');
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id, now: invalidDate }
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });

    // Exact 30m boundary is rejected (>= 30m)
    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId, proposalHash, ownerId: user.id, now: baseTime }
      )
    ).rejects.toMatchObject({
      code: 'EXPIRED',
      statusCode: 410,
    });
  });

  it.skipIf(!testDbUrl)('strictly requires output.proposedAction and output.proposalHash', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'output_shapes');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);

    // 1. Missing output.proposedAction (only raw output or missing property)
    const runMissingAction = `run_no_action_${crypto.randomUUID().replace(/-/g, '')}`;
    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [runMissingAction, workspace.id, JSON.stringify({ message: 'done', proposalHash })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId: runMissingAction, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      statusCode: 412,
    });

    // 2. Missing output.proposalHash
    const runMissingHash = `run_no_hash_${crypto.randomUUID().replace(/-/g, '')}`;
    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [runMissingHash, workspace.id, JSON.stringify({ proposedAction: proposal })]
    );

    await expect(
      approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        { sourceRunId: runMissingHash, proposalHash, ownerId: user.id }
      )
    ).rejects.toMatchObject({
      code: 'APPROVAL_DRIFT',
      statusCode: 409,
    });
  });

  it.skipIf(!testDbUrl)('getApprovedAgentAction verifies frozen proposal hash integrity', async () => {
    const { user, workspace } = await createTrackedWorkspace('Owner User', 'frozen_integrity');
    const conn = await createConnection(pool, { workspaceId: workspace.id }, {
      name: 'Liara Prod',
      provider: 'liara',
    });

    const proposal: RestartProposal = {
      kind: 'restart',
      connectionId: conn.id,
      credentialVersion: 1,
      appId: 'payment-svc',
    };
    const proposalHash = hashDeploymentProposal(proposal);
    const sourceRunId = `run_src_${crypto.randomUUID().replace(/-/g, '')}`;

    await pool.query(
      `INSERT INTO app.runs (id, workspace_id, type, status, output, finished_at)
       VALUES ($1, $2, 'agent_task', 'succeeded', $3::jsonb, NOW())`,
      [sourceRunId, workspace.id, JSON.stringify({ proposedAction: proposal, proposalHash })]
    );

    const execRun = await approveAgentAction(
      pool,
      { workspaceId: workspace.id },
      { sourceRunId, proposalHash, ownerId: user.id }
    );

    // Tamper with the frozen_proposal in the database directly
    const tamperedProposal = { ...proposal, appId: 'tampered-app' };
    await pool.query(
      `UPDATE app.agent_action_approvals SET frozen_proposal = $1::jsonb WHERE execution_run_id = $2`,
      [JSON.stringify(tamperedProposal), execRun.id]
    );

    // getApprovedAgentAction detects hash divergence and fails closed returning null
    const result = await getApprovedAgentAction(pool, { workspaceId: workspace.id }, execRun.id);
    expect(result).toBeNull();
  });
});
