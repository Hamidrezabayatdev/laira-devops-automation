import crypto from 'node:crypto';
import type pg from 'pg';
import {
  createRun,
  getRun,
  getRunEvents,
  approveAgentAction,
  addCredentialVersion,
} from '@laira/db';
import { encryptCredential } from '@laira/security';
import { parseGithubUrl } from '@laira/source';
import {
  DeploymentProposalSchema,
  hashDeploymentProposal,
} from '@laira/domain';
import { validateConnectionName } from '../runtime-environment.js';
import { authenticateOperator } from './auth.js';
import { resolveDatabasePool, resolveOperatorWorkspace } from './db.js';
import type {
  TaskArgs,
  TaskResult,
  StatusArgs,
  StatusResult,
  ConnectLiaraArgs,
  ConnectLiaraResult,
  ApproveArgs,
  ApproveResult,
  OperatorCliDependencies,
  SafeEventSummary,
} from './types.js';

/**
 * Handles the `task` command:
 * 1. Validates repository URL and task description.
 * 2. Authenticates and verifies operator identity.
 * 3. Resolves owner workspace.
 * 4. Queues an `agent_task` run in the database via createRun.
 * 5. Prints and returns the generated runId.
 * Never executes paid provider APIs directly.
 */
export async function executeTaskCommand(
  args: TaskArgs,
  deps?: OperatorCliDependencies
): Promise<TaskResult> {
  const taskText = args.task?.trim();
  if (!taskText) {
    throw new Error('Task description is required (--task)');
  }
  if (taskText.length > 4000) {
    throw new Error('Task description exceeds maximum length of 4000 characters');
  }

  const rawRepoUrl = args.repository?.trim();
  if (!rawRepoUrl) {
    throw new Error('Repository URL is required (--repository)');
  }

  if (args.connectionId !== undefined) {
    if (typeof args.connectionId !== 'string' || !args.connectionId.trim()) {
      throw new Error('Connection ID cannot be empty');
    }
  }

  const hasEnvConn = Boolean(args.environmentConnectionId?.trim());
  const hasEnvVer = args.environmentCredentialVersion !== undefined;

  if (hasEnvConn !== hasEnvVer) {
    throw new Error(
      'Both --environment-connection and --environment-version must be provided together'
    );
  }

  if (hasEnvVer) {
    const ver = args.environmentCredentialVersion!;
    if (!Number.isInteger(ver) || ver <= 0) {
      throw new Error('Environment credential version must be a positive integer');
    }
  }

  let coords: { owner: string; repo: string; ref?: string };
  try {
    coords = parseGithubUrl(rawRepoUrl);
  } catch {
    throw new Error(
      'Invalid repository URL. Must be a valid public GitHub URL (https://github.com/owner/repo)'
    );
  }

  const user = await authenticateOperator(deps);
  const managedPool = resolveDatabasePool(deps);

  try {
    const { workspace } = await resolveOperatorWorkspace(managedPool.pool, user);

    let runtimeEnvironment: { connectionId: string; credentialVersion: number } | undefined = undefined;

    const hasConnection = args.connectionId !== undefined;
    if (hasConnection) {
      const connId = args.connectionId!.trim();

      // Owner-scoped DB metadata precheck BEFORE queueing:
      // provider must be 'liara', connection belongs to workspace, status eligible, active_version credential exists
      const connRes = await managedPool.pool.query(
        `SELECT id, workspace_id, provider, status, active_version
         FROM app.connections
         WHERE id = $1 AND workspace_id = $2
         LIMIT 1`,
        [connId, workspace.id]
      );

      if (!connRes.rows || connRes.rows.length === 0) {
        throw new Error('Connection not found in workspace');
      }

      const conn = connRes.rows[0];
      if (conn.provider !== 'liara') {
        throw new Error('Connection provider must be "liara"');
      }

      const ELIGIBLE_STATUSES = new Set(['active', 'configured_unverified']);
      if (!ELIGIBLE_STATUSES.has(conn.status)) {
        throw new Error('Connection is not eligible for resolution');
      }

      const activeVer = Number(conn.active_version);
      if (!Number.isInteger(activeVer) || activeVer <= 0) {
        throw new Error('Connection active version must be a positive integer');
      }

      const credRes = await managedPool.pool.query(
        `SELECT id
         FROM app.connection_credential_versions
         WHERE workspace_id = $1 AND connection_id = $2 AND version = $3
         LIMIT 1`,
        [workspace.id, connId, activeVer]
      );

      if (!credRes.rows || credRes.rows.length === 0) {
        throw new Error('Connection credential version record not found');
      }
    }

    if (hasEnvConn && hasEnvVer) {
      const connId = args.environmentConnectionId!.trim();
      const credVer = args.environmentCredentialVersion!;

      // Owner-scoped DB metadata precheck BEFORE queueing:
      // provider must be 'deployment_env', connection belongs to workspace, status eligible, active_version matches
      const connRes = await managedPool.pool.query(
        `SELECT id, workspace_id, provider, status, active_version
         FROM app.connections
         WHERE id = $1 AND workspace_id = $2
         LIMIT 1`,
        [connId, workspace.id]
      );

      if (!connRes.rows || connRes.rows.length === 0) {
        throw new Error('Environment connection not found in workspace');
      }

      const conn = connRes.rows[0];
      if (conn.provider !== 'deployment_env') {
        throw new Error('Environment connection provider must be "deployment_env"');
      }

      const ELIGIBLE_STATUSES = new Set(['active', 'configured_unverified']);
      if (!ELIGIBLE_STATUSES.has(conn.status)) {
        throw new Error('Environment connection is not eligible for resolution');
      }

      if (Number(conn.active_version) !== credVer) {
        throw new Error('Environment credential version does not match active connection version');
      }

      // Precheck that credential version record exists
      const credRes = await managedPool.pool.query(
        `SELECT id
         FROM app.connection_credential_versions
         WHERE workspace_id = $1 AND connection_id = $2 AND version = $3
         LIMIT 1`,
        [workspace.id, connId, credVer]
      );

      if (!credRes.rows || credRes.rows.length === 0) {
        throw new Error('Environment credential version record not found');
      }

      runtimeEnvironment = {
        connectionId: connId,
        credentialVersion: credVer,
      };
    }

    const run = await createRun(
      managedPool.pool,
      { workspaceId: workspace.id },
      {
        type: 'agent_task',
        input: {
          task: taskText,
          repository: {
            owner: coords.owner,
            repo: coords.repo,
            ...(coords.ref ? { ref: coords.ref } : {}),
          },
          ...(hasConnection ? { connectionId: args.connectionId!.trim() } : {}),
          ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
        },
        initialMessage: 'CLI operator queued agent task',
      }
    );

    const outMessage = run.id;
    if (deps?.stdout) {
      deps.stdout(outMessage);
    } else {
      console.log(outMessage);
    }

    return {
      runId: run.id,
      status: run.status,
      workspaceId: workspace.id,
    };
  } finally {
    if (managedPool.shouldClose) {
      await managedPool.pool.end().catch(() => {});
    }
  }
}

/**
 * Handles the `status` command:
 * 1. Validates run ID argument.
 * 2. Authenticates and verifies operator identity.
 * 3. Resolves workspace and retrieves the run strictly scoped to the workspace.
 * 4. Retrieves run events and produces owner-scoped safe metadata (message, phase, proposal, events).
 * Excludes raw source code, error stack traces, and provider secrets.
 */
export async function executeStatusCommand(
  args: StatusArgs,
  deps?: OperatorCliDependencies
): Promise<StatusResult> {
  const runId = args.run?.trim();
  if (!runId) {
    throw new Error('Run ID is required (--run)');
  }

  const user = await authenticateOperator(deps);
  const managedPool = resolveDatabasePool(deps);

  try {
    const { workspace } = await resolveOperatorWorkspace(managedPool.pool, user);

    const run = await getRun(managedPool.pool, { workspaceId: workspace.id }, runId);
    if (!run) {
      throw new Error(`Run "${runId}" not found in operator workspace`);
    }

    const events = await getRunEvents(managedPool.pool, { workspaceId: workspace.id }, runId);

    const rawOutput =
      run.output && typeof run.output === 'object' && !Array.isArray(run.output)
        ? (run.output as Record<string, unknown>)
        : {};

    const safeMessage =
      typeof rawOutput.message === 'string'
        ? rawOutput.message.slice(0, 50000)
        : undefined;

    const rawPhase =
      rawOutput.phase ||
      rawOutput.verificationPhase ||
      rawOutput.step;
    const safePhase =
      typeof rawPhase === 'string' && rawPhase.length <= 100
        ? rawPhase
        : undefined;

    let safeProposal: StatusResult['proposal'] = undefined;
    if (
      rawOutput.proposedAction &&
      typeof rawOutput.proposedAction === 'object' &&
      !Array.isArray(rawOutput.proposedAction)
    ) {
      const parsedProposal = DeploymentProposalSchema.safeParse(rawOutput.proposedAction);
      if (parsedProposal.success) {
        const computedHash = hashDeploymentProposal(parsedProposal.data);
        if (
          typeof rawOutput.proposalHash === 'string' &&
          rawOutput.proposalHash === computedHash
        ) {
          const p = parsedProposal.data;
          switch (p.kind) {
            case 'deploy': {
              safeProposal = {
                kind: 'deploy',
                connectionId: p.connectionId,
                credentialVersion: p.credentialVersion,
                appId: p.appId,
                platform: p.platform,
                port: p.port,
                repository: {
                  owner: p.repository.owner,
                  repo: p.repository.repo,
                  commitSha: p.repository.commitSha,
                },
                bundleDigest: p.bundleDigest,
                ...(p.runtimeEnvironment
                  ? {
                      runtimeEnvironment: {
                        connectionId: p.runtimeEnvironment.connectionId,
                        credentialVersion: p.runtimeEnvironment.credentialVersion,
                      },
                    }
                  : {}),
                proposalHash: computedHash,
              };
              break;
            }
            case 'restart':
              safeProposal = {
                kind: 'restart',
                connectionId: p.connectionId,
                credentialVersion: p.credentialVersion,
                appId: p.appId,
                proposalHash: computedHash,
              };
              break;
            case 'create_app':
              safeProposal = {
                kind: 'create_app',
                connectionId: p.connectionId,
                credentialVersion: p.credentialVersion,
                appId: p.appId,
                platform: p.platform,
                planId: p.planId,
                bundlePlanId: p.bundlePlanId,
                networkId: p.networkId,
                cost: {
                  currency: p.cost.currency,
                  hourly: p.cost.hourly,
                  monthly: p.cost.monthly,
                  sourceUrl: p.cost.sourceUrl,
                  checkedAt: p.cost.checkedAt,
                },
                proposalHash: computedHash,
              };
              break;
          }
        }
      }
    }

    const safeEvents: SafeEventSummary[] = events.map((e) => {
      const payload =
        e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)
          ? (e.payload as Record<string, unknown>)
          : {};

      const step =
        typeof payload.step === 'string' && payload.step.length <= 100
          ? payload.step
          : undefined;

      let msg = '';
      if (typeof payload.message === 'string') {
        msg = payload.message.slice(0, 500);
      } else if (typeof payload.text === 'string') {
        msg = payload.text.slice(0, 500);
      }

      return {
        seq: e.seq,
        type: e.type,
        ...(step ? { step } : {}),
        ...(msg ? { message: msg } : {}),
        createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
      };
    });

    let safeError: StatusResult['error'] = undefined;
    if (run.error) {
      safeError = {
        code: typeof run.error.code === 'string' ? run.error.code : undefined,
        message:
          typeof run.error.message === 'string'
            ? run.error.message.slice(0, 500)
            : 'Execution failed',
      };
    }

    const result: StatusResult = {
      runId: run.id,
      status: run.status,
      type: run.type,
      ...(safePhase ? { phase: safePhase } : {}),
      ...(safeMessage ? { message: safeMessage } : {}),
      ...(safeProposal ? { proposal: safeProposal } : {}),
      events: safeEvents,
      ...(safeError ? { error: safeError } : {}),
    };

    const outJson = JSON.stringify(result, null, 2);
    if (deps?.stdout) {
      deps.stdout(outJson);
    } else {
      console.log(outJson);
    }

    return result;
  } finally {
    if (managedPool.shouldClose) {
      await managedPool.pool.end().catch(() => {});
    }
  }
}

/**
 * Handles the `connect-liara` command:
 * 1. Reads bare LIARA_API_TOKEN and ENCRYPTION_MASTER_KEY from env.
 * 2. Reads optional LIARA_TEAM_ID from arguments or env.
 * 3. Authenticates operator and verifies identity.
 * 4. Resolves workspace.
 * 5. Refuses to overwrite existing customer Liara connections.
 * 6. Encrypts JSON credential {apiKey, teamId?} using master key with AAD binding context.
 * 7. Atomically creates connection labeled 'Operator Import' with status 'configured_unverified'.
 * Token and secrets are NEVER printed or serialized to console.
 */
export async function executeConnectLiaraCommand(
  args?: ConnectLiaraArgs,
  deps?: OperatorCliDependencies
): Promise<ConnectLiaraResult> {
  const env = deps?.env ?? process.env;

  const liaraToken = env.LIARA_API_TOKEN?.trim();
  if (!liaraToken) {
    throw new Error('LIARA_API_TOKEN environment variable is required');
  }

  const masterKey = env.ENCRYPTION_MASTER_KEY?.trim();
  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY environment variable is required');
  }

  const teamId = args?.teamId?.trim() || env.LIARA_TEAM_ID?.trim() || undefined;
  const hasExplicitName = args?.name !== undefined && args.name !== null;
  const connectionName = hasExplicitName
    ? validateConnectionName(args.name)
    : 'Operator Import';

  const user = await authenticateOperator(deps);
  const managedPool = resolveDatabasePool(deps);

  let client: pg.PoolClient | null = null;
  try {
    const { workspace } = await resolveOperatorWorkspace(managedPool.pool, user);

    client = await managedPool.pool.connect();
    await client.query('BEGIN');

    // Concurrency protection: transaction advisory lock per workspace/name prevents races
    const lockKey = crypto
      .createHash('sha256')
      .update(`liara_conn:${workspace.id}:${connectionName}`)
      .digest()
      .readBigInt64BE(0)
      .toString();
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);

    if (hasExplicitName) {
      // Explicit name: allow new connection if workspace name is unused; never overwrite
      const existingRes = await client.query(
        `SELECT id FROM app.connections
         WHERE workspace_id = $1 AND name = $2
         LIMIT 1`,
        [workspace.id, connectionName]
      );

      if (existingRes.rows.length > 0) {
        throw new Error(
          `Existing Liara connection already configured with name "${connectionName}". Refusing to overwrite connection.`
        );
      }
    } else {
      // Default: preserve refusal when any existing Liara connection exists for this workspace
      const existingRes = await client.query(
        `SELECT id FROM app.connections
         WHERE workspace_id = $1 AND provider = 'liara'
         LIMIT 1`,
        [workspace.id]
      );

      if (existingRes.rows.length > 0) {
        throw new Error(
          'Existing Liara connection already configured for this workspace. Refusing to overwrite customer connection.'
        );
      }
    }

    const connectionId = `conn_${crypto.randomUUID().replace(/-/g, '')}`;

    // Contract: Encrypt JSON credential {apiKey, teamId} when team is configured, else {apiKey}
    const credentialPlaintext = teamId
      ? JSON.stringify({ apiKey: liaraToken, teamId })
      : JSON.stringify({ apiKey: liaraToken });

    const envelope = encryptCredential(
      credentialPlaintext,
      masterKey,
      {
        workspaceId: workspace.id,
        connectionId,
        version: 1,
      },
      1
    );

    // Create connection record with status 'configured_unverified'
    await client.query(
      `INSERT INTO app.connections (id, workspace_id, name, provider, status, active_version, created_at, updated_at)
       VALUES ($1, $2, $3, 'liara', 'configured_unverified', 1, NOW(), NOW())`,
      [connectionId, workspace.id, connectionName]
    );

    // Store encrypted credential version
    await addCredentialVersion(
      client,
      { workspaceId: workspace.id },
      connectionId,
      envelope
    );

    // Ensure status remains strictly configured_unverified
    await client.query(
      `UPDATE app.connections
       SET status = 'configured_unverified', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [connectionId, workspace.id]
    );

    await client.query('COMMIT');

    const outMessage = `Liara connection configured (unverified): ${connectionId}`;
    if (deps?.stdout) {
      deps.stdout(outMessage);
    } else {
      console.log(outMessage);
    }

    return {
      connectionId,
      status: 'configured_unverified',
      workspaceId: workspace.id,
      hasTeamId: Boolean(teamId),
    };
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
    if (managedPool.shouldClose) {
      await managedPool.pool.end().catch(() => {});
    }
  }
}

/**
 * Handles explicit `approve` command:
 * 1. Validates run ID and proposal hash format.
 * 2. Authenticates operator and verifies identity.
 * 3. Resolves workspace.
 * 4. Calls approveAgentAction to record user approval and queue execution run.
 * Does NOT execute provider APIs directly; only transitions DB state.
 */
export async function executeApproveCommand(
  args: ApproveArgs,
  deps?: OperatorCliDependencies
): Promise<ApproveResult> {
  const runId = args.run?.trim();
  if (!runId) {
    throw new Error('Run ID is required (--run)');
  }

  const hash = args.hash?.trim().toLowerCase();
  if (!hash) {
    throw new Error('Proposal hash is required (--hash)');
  }

  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(
      'Invalid proposal hash format. Must be a 64-character SHA-256 hexadecimal string'
    );
  }

  const user = await authenticateOperator(deps);
  const managedPool = resolveDatabasePool(deps);

  try {
    const { workspace } = await resolveOperatorWorkspace(
      managedPool.pool,
      user
    );

    const executionRun = await approveAgentAction(
      managedPool.pool,
      { workspaceId: workspace.id },
      {
        sourceRunId: runId,
        proposalHash: hash,
        ownerId: workspace.ownerUserId,
        now: deps?.now ? deps.now() : new Date(),
      }
    );

    const outMessage = `Action approved. Execution run queued: ${executionRun.id}`;
    if (deps?.stdout) {
      deps.stdout(outMessage);
    } else {
      console.log(outMessage);
    }

    return {
      executionRunId: executionRun.id,
      status: executionRun.status,
      sourceRunId: runId,
      proposalHash: hash,
    };
  } finally {
    if (managedPool.shouldClose) {
      await managedPool.pool.end().catch(() => {});
    }
  }
}
