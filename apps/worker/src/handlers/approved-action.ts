import crypto from 'node:crypto';
import pg from 'pg';
import {
  resolveRunForExecution,
  claimRunForExecution,
  getApprovedAgentAction,
  claimAgentActionDispatch,
  getActiveCredentialVersion,
  getConnection,
  appendRunEvent,
  completeRun,
  failRun,
  updateRunHeartbeat,
  ALLOWED_CONNECTION_STATUSES,
  type Run,
  type Connection,
  type ConnectionCredentialVersion,
  type ApprovedAgentAction,
} from '@laira/db';
import {
  DeploymentProposalSchema,
  hashDeploymentProposal,
  type DeploymentProposal,
  type DeployProposal,
  type RestartProposal,
  type CreateAppProposal,
} from '@laira/domain';
import { parseLiaraDecryptedCredential } from './liara-credential.js';
import {
  decryptCredential,
  type CredentialEnvelope,
  type AadContext,
} from '@laira/security';
import {
  LiaraOperationalAdapter,
  type LiaraOperationAuthority,
  type SafeLiaraReleaseDetail,
  type CreateAppParams,
  type LiaraExecutionOutcome,
} from '@laira/providers/liara/operational';
import { resolveRuntimeEnvironment as defaultResolveRuntimeEnvironment } from '../runtime-environment.js';
import type { SafeLiaraApp, SafeLiaraAppDetail } from '@laira/providers/liara';
import {
  fetchPublicGithubSource,
  type FetchPublicGithubSourceResult,
  type GithubSourceParam,
} from '@laira/source';

export interface SafeLiaraNetwork {
  id: string;
  name: string;
}

export type CompatibleLiaraOperationalAdapter = LiaraOperationalAdapter & {
  listNetworks?: () => Promise<SafeLiaraNetwork[]>;
};

export type CompatibleCreateAppParams = CreateAppParams & {
  networkId?: string;
};

export interface ApprovedExecutionResult {
  run: Run;
  phase: string;
  eventsEmitted: number;
  output?: Record<string, unknown>;
}

export interface ApprovedActionDependencies {
  resolveRun?: typeof resolveRunForExecution;
  claimRun?: typeof claimRunForExecution;
  getApprovedAction?: typeof getApprovedAgentAction;
  claimDispatch?: typeof claimAgentActionDispatch;
  getActiveCredential?: typeof getActiveCredentialVersion;
  getConnection?: typeof getConnection;
  appendEvent?: typeof appendRunEvent;
  completeRun?: typeof completeRun;
  failRun?: typeof failRun;
  heartbeat?: typeof updateRunHeartbeat;
  fetchGithubSource?: (
    param: GithubSourceParam,
    fetchImpl?: typeof fetch
  ) => Promise<FetchPublicGithubSourceResult>;
  createLiaraAdapter?: (config: { apiKey: string; teamId?: string }) => CompatibleLiaraOperationalAdapter;
  httpFetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  encryptionMasterKey?: string;
  heartbeatIntervalMs?: number;
  resolveRuntimeEnvironment?: typeof defaultResolveRuntimeEnvironment;
}

/**
 * Fenced database helper to transition run to non-standard or intermediate statuses
 * (such as 'outcome_unknown' or 'waiting_external') while strictly checking active worker lease.
 */
export async function setFencedRunStatus(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  newStatus: 'outcome_unknown' | 'waiting_external',
  output?: Record<string, unknown>,
  error?: Record<string, unknown>
): Promise<Run | null> {
  const isTerminal = newStatus === 'outcome_unknown';
  const res = await poolOrClient.query(
    `UPDATE app.runs
     SET status = $1,
         output = COALESCE($2::jsonb, output),
         error = COALESCE($3::jsonb, error),
         finished_at = CASE WHEN $4::boolean THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $5 AND claimed_by = $6 AND status = 'running'
     RETURNING *`,
    [
      newStatus,
      output ? JSON.stringify(output) : null,
      error ? JSON.stringify(error) : null,
      isTerminal,
      runId,
      workerId,
    ]
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

/**
 * Persist provider releaseId immediately in run.output via fenced SQL JSON patch
 * for later reconciliation, without resending at any point.
 */
export async function persistReleaseIdInOutput(
  poolOrClient: pg.Pool | pg.PoolClient,
  workerId: string,
  runId: string,
  releaseId: string
): Promise<void> {
  await poolOrClient.query(
    `UPDATE app.runs
     SET output = jsonb_set(COALESCE(output, '{}'::jsonb), '{releaseId}', to_jsonb($1::text)),
         updated_at = NOW()
     WHERE id = $2 AND claimed_by = $3 AND status = 'running'`,
    [releaseId, runId, workerId]
  );
}

export interface HttpProbeResult {
  ok: boolean;
  status: number;
  kind: 'healthy_2xx' | 'not_found_404' | 'redirect_rejected' | 'server_error_5xx' | 'network_error';
  safeMessage: string;
}

/**
 * HTTP health verification against fixed-origin https://${validatedAppSlug}.liara.run/
 * Guarantees:
 * 1. Fixed origin only (root path /). No arbitrary URLs or external paths.
 * 2. Redirects set to manual; 3xx redirects are strictly rejected (not treated as healthy).
 * 3. Body stream is bounded/cancelled without echoing contents.
 */
export async function probeLiaraAppHttp(
  appSlug: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<HttpProbeResult> {
  const targetUrl = `https://${encodeURIComponent(appSlug)}.liara.run/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetchFn(targetUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });

    try {
      await res.body?.cancel().catch(() => {});
    } catch {
      // ignore body cancellation error
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        status: res.status,
        kind: 'healthy_2xx',
        safeMessage: `HTTP verification succeeded with status ${res.status}`,
      };
    }

    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        kind: 'redirect_rejected',
        safeMessage: 'HTTP probe received unexpected redirect; manual redirects are rejected',
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        kind: 'not_found_404',
        safeMessage: 'HTTP probe returned 404 Not Found',
      };
    }

    return {
      ok: false,
      status: res.status,
      kind: 'server_error_5xx',
      safeMessage: `HTTP probe returned status ${res.status}`,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      kind: 'network_error',
      safeMessage: 'HTTP probe network connection failed',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export class FencingError extends Error {
  constructor(message: string) {
    super(`FencingError: ${message}`);
    this.name = 'FencingError';
  }
}

export const activeRunsInProcess = new Set<string>();

/**
 * Executes an approved agent action (deploy or restart) with write-ahead fencing and bounded polling.
 */
export async function executeApprovedAgentActionRun(
  pool: pg.Pool,
  workerId: string,
  runId: string,
  leaseTimeoutSeconds = 30,
  deps: ApprovedActionDependencies = {}
): Promise<ApprovedExecutionResult> {
  if (activeRunsInProcess.has(runId)) {
    throw new FencingError(
      `Worker process is already executing run ${runId}: concurrent duplicate execution blocked`
    );
  }
  activeRunsInProcess.add(runId);
  const resolveRun = deps.resolveRun ?? resolveRunForExecution;
  const claimRun = deps.claimRun ?? claimRunForExecution;
  const getApprovedAction = deps.getApprovedAction ?? getApprovedAgentAction;
  const claimDispatch = deps.claimDispatch ?? claimAgentActionDispatch;
  const getActiveCredential = deps.getActiveCredential ?? getActiveCredentialVersion;
  const doGetConnection = deps.getConnection ?? getConnection;
  const appendEvent = deps.appendEvent ?? appendRunEvent;
  const doCompleteRun = deps.completeRun ?? completeRun;
  const doFailRun = deps.failRun ?? failRun;
  const doHeartbeat = deps.heartbeat ?? updateRunHeartbeat;
  const fetchGithub = deps.fetchGithubSource ?? fetchPublicGithubSource;
  const createAdapter =
    deps.createLiaraAdapter ?? ((cfg) => new LiaraOperationalAdapter(cfg) as CompatibleLiaraOperationalAdapter);
  const httpFetch = deps.httpFetch ?? globalThis.fetch;
  const getNow = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const masterKey = deps.encryptionMasterKey ?? process.env.ENCRYPTION_MASTER_KEY;
  const doResolveRuntimeEnvironment =
    deps.resolveRuntimeEnvironment ?? defaultResolveRuntimeEnvironment;

  let eventsEmitted = 0;
  let isDispatched = false;

  const heartbeatState: {
    failed: boolean;
    timer: NodeJS.Timeout | null;
    pending: Promise<void> | null;
  } = {
    failed: false,
    timer: null,
    pending: null,
  };

  // Stop heartbeat helper
  const stopHeartbeat = async () => {
    if (heartbeatState.timer) {
      clearInterval(heartbeatState.timer);
      heartbeatState.timer = null;
    }
    if (heartbeatState.pending) {
      await heartbeatState.pending.catch(() => {});
      heartbeatState.pending = null;
    }
  };

  // Single trigger/dispatch heartbeat helper used by both manual calls and interval timer
  const triggerHeartbeat = async (): Promise<void> => {
    if (heartbeatState.failed) {
      throw new FencingError(`Heartbeat failed previously: worker ${workerId} lease expired or fenced out`);
    }
    if (heartbeatState.pending) {
      await heartbeatState.pending;
      if (heartbeatState.failed) {
        throw new FencingError(`Heartbeat failed previously: worker ${workerId} lease expired or fenced out`);
      }
      return;
    }
    const pending: Promise<void> = doHeartbeat(pool, workerId, runId)
      .catch((hbErr) => {
        heartbeatState.failed = true;
        throw hbErr;
      })
      .finally(() => {
        if (heartbeatState.pending === pending) {
          heartbeatState.pending = null;
        }
      });
    heartbeatState.pending = pending;
    await pending;
  };

  // Safe heartbeat invoker: fails execution if lease is lost or run is fenced
  const performFencedHeartbeat = async () => {
    await triggerHeartbeat();
  };

  try {
    // 1. Resolve workspace from DB run row, never from job payload
    const resolved = await resolveRun(pool, runId);
    if (!resolved) {
      throw new Error(`Run ${runId} cannot be resolved from database`);
    }

    const { run, workspaceId } = resolved;

    // 2. Check for terminal / non-queued status (idempotent no-op)
    if (['cancelled', 'succeeded', 'failed', 'outcome_unknown', 'waiting_external'].includes(run.status)) {
      return { run, phase: 'terminal_noop', eventsEmitted: 0, output: run.output ?? undefined };
    }

    // Check if run is currently actively running with a fresh lease
    if (run.status === 'running') {
      const nowMs = getNow().getTime();
      const lastHeartbeatMs = run.heartbeatAt
        ? new Date(run.heartbeatAt).getTime()
        : (run.claimedAt ? new Date(run.claimedAt).getTime() : 0);
      const isLeaseFresh = nowMs - lastHeartbeatMs < leaseTimeoutSeconds * 1000;
      if (isLeaseFresh) {
        throw new FencingError(
          `Run ${runId} is currently running with an active lease (claimed by ${run.claimedBy ?? 'worker'}); cannot reclaim until lease expires`
        );
      }
    }

    // 3. Atomically claim run lease
    const claimedRun = await claimRun(pool, workerId, runId, leaseTimeoutSeconds);
    if (!claimedRun) {
      const current = await resolveRun(pool, runId);
      if (current && ['cancelled', 'succeeded', 'failed', 'outcome_unknown', 'waiting_external'].includes(current.run.status)) {
        return { run: current.run, phase: 'terminal_noop', eventsEmitted: 0, output: current.run.output ?? undefined };
      }
      throw new FencingError(
        `Worker ${workerId} could not claim run ${runId}: active lease held by another worker`
      );
    }

    // Start background heartbeat interval: interval <= leaseTimeoutSeconds / 3
    const intervalMs =
      deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor((leaseTimeoutSeconds * 1000) / 3));

    heartbeatState.timer = setInterval(() => {
      if (heartbeatState.failed || heartbeatState.pending) return;
      triggerHeartbeat().catch(() => {});
    }, intervalMs);

    // 4. Retrieve approved agent action from database
    let approvedAction: ApprovedAgentAction | null = null;
    try {
      approvedAction = await getApprovedAction(pool, { workspaceId }, runId);
    } catch {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'APPROVAL_FETCH_ERROR',
        message: 'Failed to query approved action from database',
      });
      return { run: failed, phase: 'rejected_approval_fetch_error', eventsEmitted };
    }

    if (!approvedAction) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'APPROVAL_NOT_FOUND',
        message: 'No durable approval found for execution run in workspace',
      });
      await appendEvent(pool, workerId, runId, {
        type: 'run_failed',
        payload: {
          errorCode: 'APPROVAL_NOT_FOUND',
          errorMessage: 'No durable approval found for execution run in workspace',
        },
      }).catch(() => {});
      return { run: failed, phase: 'rejected_approval_missing', eventsEmitted };
    }

    const now = getNow();

    // 5. Check if already dispatched (Redelivery Protection)
    if (approvedAction.dispatchedAt !== null) {
      const safeOutput = {
        message: 'Execution run was already dispatched; auto-resend forbidden to prevent duplicate mutations',
        phase: 'dispatched_redelivery_blocked',
        dispatchedAt: approvedAction.dispatchedAt.toISOString(),
      };
      const updated = await setFencedRunStatus(
        pool,
        workerId,
        runId,
        'outcome_unknown',
        safeOutput
      );
      return {
        run: updated ?? claimedRun,
        phase: 'dispatched_redelivery_blocked',
        eventsEmitted,
        output: safeOutput,
      };
    }

    // 6. Check approval expiration
    if (now.getTime() >= new Date(approvedAction.expiresAt).getTime()) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'EXPIRED',
        message: 'Approval dispatch window has expired',
      });
      await appendEvent(pool, workerId, runId, {
        type: 'run_failed',
        payload: {
          errorCode: 'EXPIRED',
          errorMessage: 'Approval dispatch window has expired',
        },
      }).catch(() => {});
      return { run: failed, phase: 'rejected_expired', eventsEmitted };
    }

    // 7. Validate proposal against schema and hash integrity
    let proposal: DeploymentProposal;
    try {
      proposal = DeploymentProposalSchema.parse(approvedAction.proposal);
    } catch {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'INVALID_PROPOSAL_SCHEMA',
        message: 'Frozen proposal schema validation failed',
      });
      return { run: failed, phase: 'rejected_invalid_schema', eventsEmitted };
    }

    const computedHash = hashDeploymentProposal(proposal);
    if (computedHash !== approvedAction.proposalHash) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'APPROVAL_DRIFT',
        message: 'Supplied proposal hash does not match computed canonical hash',
      });
      return { run: failed, phase: 'rejected_hash_mismatch', eventsEmitted };
    }

    // Step event: Proposal validated
    await appendEvent(pool, workerId, runId, {
      type: 'step_progress',
      payload: {
        step: 'proposal_validation',
        progress: 15,
        message: 'Proposal integrity and workspace scoping verified',
      },
    });
    eventsEmitted++;
    await performFencedHeartbeat();

    // 8. Retrieve active credential version and decrypt
    const connRow = await doGetConnection(pool, { workspaceId }, proposal.connectionId);
    if (!connRow) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CONNECTION_NOT_FOUND',
        message: 'Connection not found in workspace',
      });
      return { run: failed, phase: 'rejected_connection_missing', eventsEmitted };
    }

    if (!ALLOWED_CONNECTION_STATUSES.has(connRow.status)) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CONNECTION_INELIGIBLE',
        message: `Connection status "${connRow.status}" is not eligible for execution. Expected "active" or "configured_unverified".`,
      });
      return { run: failed, phase: 'rejected_connection_ineligible', eventsEmitted };
    }

    if (connRow.activeVersion !== proposal.credentialVersion) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CONNECTION_VERSION_MISMATCH',
        message: 'Connection active version does not match proposal',
      });
      return { run: failed, phase: 'rejected_credential_drift', eventsEmitted };
    }

    const credentialRow = await getActiveCredential(pool, { workspaceId }, proposal.connectionId);
    if (!credentialRow) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CREDENTIAL_NOT_FOUND',
        message: 'Active credential not found for connection in workspace',
      });
      return { run: failed, phase: 'rejected_credential_missing', eventsEmitted };
    }

    if (credentialRow.version !== proposal.credentialVersion) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CREDENTIAL_VERSION_MISMATCH',
        message: 'Connection active credential version does not match proposal',
      });
      return { run: failed, phase: 'rejected_credential_drift', eventsEmitted };
    }

    // Validate algorithm and keyVersion
    if (credentialRow.algorithm !== 'aes-256-gcm') {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'UNSUPPORTED_ALGORITHM',
        message: 'Unsupported credential encryption algorithm',
      });
      return { run: failed, phase: 'rejected_unsupported_algorithm', eventsEmitted };
    }

    if (credentialRow.keyVersion !== 1) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'UNSUPPORTED_KEY_VERSION',
        message: 'Unsupported credential key version',
      });
      return { run: failed, phase: 'rejected_key_version', eventsEmitted };
    }

    if (!masterKey) {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'DECRYPTION_CONFIG_ERROR',
        message: 'Encryption master key not configured on worker',
      });
      return { run: failed, phase: 'rejected_key_missing', eventsEmitted };
    }

    let liaraApiKey: string;
    let liaraTeamId: string | undefined;
    try {
      const envelope: CredentialEnvelope = {
        algorithm: 'aes-256-gcm',
        ciphertext: credentialRow.ciphertext,
        iv: credentialRow.iv,
        tag: credentialRow.tag,
        keyVersion: credentialRow.keyVersion,
        workspaceId,
        connectionId: proposal.connectionId,
        version: String(credentialRow.version),
      };
      const aadContext: AadContext = {
        workspaceId,
        connectionId: proposal.connectionId,
        version: String(credentialRow.version),
        keyVersion: credentialRow.keyVersion,
      };
      const decryptedBuffer = decryptCredential(envelope, masterKey, aadContext);
      const decryptedPlaintext = decryptedBuffer.toString('utf8');
      const parsedCred = parseLiaraDecryptedCredential(decryptedPlaintext);
      liaraApiKey = parsedCred.apiKey;
      liaraTeamId = parsedCred.teamId;
    } catch {
      const failed = await doFailRun(pool, workerId, runId, {
        code: 'CREDENTIAL_DECRYPTION_FAILED',
        message: 'Failed to decrypt connection credential',
      });
      return { run: failed, phase: 'rejected_decryption_failure', eventsEmitted };
    }

    // Instantiate operational adapter with decrypted key and bound teamId
    const adapter = createAdapter({ apiKey: liaraApiKey, teamId: liaraTeamId });

    // 9. Pre-write read verification
    if (proposal.kind === 'create_app') {
      const createAppProp = proposal as CreateAppProposal;

      // Price quote freshness check (max 24h old, not > 5min in future)
      const quoteTime = new Date(createAppProp.cost.checkedAt).getTime();
      const currentTime = getNow().getTime();
      if (quoteTime > currentTime + 5 * 60 * 1000 || currentTime - quoteTime > 24 * 60 * 60 * 1000) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'PROPOSAL_PRICE_EXPIRED',
          message: 'Proposal price quote is expired or invalid (must be within 24 hours of current time)',
        });
        return { run: failed, phase: 'rejected_price_expired', eventsEmitted };
      }

      let existingApps: SafeLiaraApp[];
      try {
        existingApps = await adapter.listApps();
      } catch {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'PREWRITE_READ_FAILED',
          message: 'Pre-write verification failed: unable to list applications on provider',
        });
        return { run: failed, phase: 'rejected_prewrite_read_failed', eventsEmitted };
      }

      if (!Array.isArray(existingApps)) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'PREWRITE_READ_FAILED',
          message: 'Pre-write verification failed: provider returned invalid application list structure',
        });
        return { run: failed, phase: 'rejected_prewrite_read_failed', eventsEmitted };
      }

      const targetSlug = createAppProp.appId.toLowerCase();
      const slugExists = existingApps.some(
        (app) => app.projectId && app.projectId.toLowerCase() === targetSlug
      );

      if (slugExists) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'APP_ALREADY_EXISTS',
          message: `Target application "${createAppProp.appId}" already exists on provider; adoption is prohibited`,
        });
        return { run: failed, phase: 'rejected_app_already_exists', eventsEmitted };
      }

      // Pre-write network verification: verify proposal network exists in current account
      let existingNetworks: SafeLiaraNetwork[];
      try {
        if (typeof adapter.listNetworks !== 'function') {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'PREWRITE_READ_FAILED',
            message: 'Pre-write verification failed: listNetworks is not available on provider adapter',
          });
          return { run: failed, phase: 'rejected_prewrite_read_failed', eventsEmitted };
        }
        existingNetworks = await adapter.listNetworks();
      } catch {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'PREWRITE_READ_FAILED',
          message: 'Pre-write verification failed: unable to list networks on provider',
        });
        return { run: failed, phase: 'rejected_prewrite_read_failed', eventsEmitted };
      }

      if (!Array.isArray(existingNetworks)) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'PREWRITE_READ_FAILED',
          message: 'Pre-write verification failed: provider returned invalid network list structure',
        });
        return { run: failed, phase: 'rejected_prewrite_read_failed', eventsEmitted };
      }

      const targetNetworkId = createAppProp.networkId.toLowerCase();
      const networkExists = existingNetworks.some(
        (net) => net && typeof net.id === 'string' && net.id.toLowerCase() === targetNetworkId
      );

      if (!networkExists) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'NETWORK_NOT_FOUND',
          message: `Target network "${createAppProp.networkId}" not found on provider; creation is prohibited`,
        });
        return { run: failed, phase: 'rejected_network_not_found', eventsEmitted };
      }
    } else {
      // Pre-write read verification for deploy/restart: verify target app exists on Liara and matches exact slug
      let appDetail: SafeLiaraAppDetail;
      try {
        appDetail = await adapter.getAppDetail(proposal.appId);
      } catch {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'APP_NOT_FOUND',
          message: 'Target application not found on provider',
        });
        return { run: failed, phase: 'rejected_app_not_found', eventsEmitted };
      }

      if (!appDetail || (appDetail.projectId && appDetail.projectId.toLowerCase() !== proposal.appId.toLowerCase())) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'APP_SLUG_MISMATCH',
          message: 'Target application slug does not match requested proposal appId',
        });
        return { run: failed, phase: 'rejected_slug_mismatch', eventsEmitted };
      }

      // Pre-write check: platform compatibility for deploy
      if (proposal.kind === 'deploy') {
        const deployProp = proposal as DeployProposal;
        const currentType = (appDetail.type || '').toLowerCase();
        const targetPlatform = deployProp.platform.toLowerCase();
        const prevPlatform = deployProp.previousPlatform ? deployProp.previousPlatform.toLowerCase() : undefined;

        // If previousPlatform is present, it must EXACTLY match the old appDetail.type (avoid drift)
        if (prevPlatform && prevPlatform !== currentType) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'PLATFORM_DRIFT',
            message: 'Target application platform on provider has drifted from approved previous platform',
          });
          return { run: failed, phase: 'rejected_platform_drift', eventsEmitted };
        }

        // Different target only allowed if previousPlatform matches current
        if (targetPlatform !== currentType) {
          if (!prevPlatform || prevPlatform !== currentType) {
            const failed = await doFailRun(pool, workerId, runId, {
              code: 'PLATFORM_MISMATCH',
              message: 'Target application platform on provider does not match proposal platform',
            });
            return { run: failed, phase: 'rejected_platform_mismatch', eventsEmitted };
          }
        }
      }
    }

    // 10. For deploy: Pre-write fetch public GitHub commit and deterministic bundle verification
    let deployBundleBytes: Uint8Array | null = null;
    if (proposal.kind === 'deploy') {
      const deployProp = proposal as DeployProposal;
      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'source_fetch',
          progress: 30,
          message: 'Fetching public GitHub repository source archive',
        },
      });
      eventsEmitted++;
      await performFencedHeartbeat();

      let githubResult: FetchPublicGithubSourceResult;
      try {
        githubResult = await fetchGithub(
          {
            owner: deployProp.repository.owner,
            repo: deployProp.repository.repo,
            ref: deployProp.repository.commitSha,
            timeoutMs: 300000,
          },
          httpFetch
        );
      } catch {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'SOURCE_FETCH_FAILED',
          message: 'Failed to fetch public source archive from GitHub',
        });
        return { run: failed, phase: 'rejected_source_fetch', eventsEmitted };
      }

      // Verify resolved commit matches exact proposal commitSha
      if (githubResult.commit.toLowerCase() !== deployProp.repository.commitSha.toLowerCase()) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'COMMIT_SHA_MISMATCH',
          message: 'Resolved GitHub commit does not match proposal commitSha',
        });
        return { run: failed, phase: 'rejected_commit_mismatch', eventsEmitted };
      }

      // Strictly recompute SHA-256 of actual downloaded bundle bytes
      const actualBundleDigest = `sha256:${crypto.createHash('sha256').update(githubResult.bundle.bytes).digest('hex')}`;
      if (actualBundleDigest !== deployProp.bundleDigest) {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'BUNDLE_DIGEST_MISMATCH',
          message: 'Recomputed deploy bundle digest does not match proposal bundleDigest',
        });
        return { run: failed, phase: 'rejected_bundle_mismatch', eventsEmitted };
      }

      deployBundleBytes = githubResult.bundle.bytes;
    }

    // Explicitly check heartbeat immediately before claiming dispatch
    await performFencedHeartbeat();

    // 11. Claim dispatch write-ahead ONCE immediately before initiating provider upload/mutation
    const claimDispatchTime = getNow();
    const dispatchClaimed = await claimDispatch(pool, workerId, runId, claimDispatchTime);
    if (!dispatchClaimed) {
      // Check if redelivered / already dispatched or expired
      const latestAction = await getApprovedAction(pool, { workspaceId }, runId);
      if (Boolean(latestAction?.dispatchedAt)) {
        const safeOutput = {
          message: 'Execution run was already dispatched; auto-resend forbidden',
          phase: 'dispatched_redelivery_blocked',
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return {
          run: updated ?? claimedRun,
          phase: 'dispatched_redelivery_blocked',
          eventsEmitted,
          output: safeOutput,
        };
      }

      const failed = await doFailRun(pool, workerId, runId, {
        code: 'DISPATCH_CLAIM_FAILED',
        message: 'Failed to acquire write-ahead dispatch claim',
      });
      return { run: failed, phase: 'rejected_claim_dispatch', eventsEmitted };
    }

    isDispatched = true;

    await appendEvent(pool, workerId, runId, {
      type: 'step_progress',
      payload: {
        step: 'dispatch_claimed',
        progress: 45,
        message: 'Write-ahead dispatch claim acquired; commencing provider operations',
      },
    });
    eventsEmitted++;
    await performFencedHeartbeat();

    const authority: LiaraOperationAuthority = {
      approved: true,
      token: approvedAction.approvalId,
    };

    // ---------------------------------------------------------------------------
    // BRANCH A: DEPLOY OPERATION
    // ---------------------------------------------------------------------------
    if (proposal.kind === 'deploy') {
      const deployProp = proposal as DeployProposal;

      // Pre-write verification of runtime environment (if specified in proposal)
      let resolvedRuntimeEnvs: Array<{ readonly key: string; readonly value: string }> | undefined = undefined;
      if (deployProp.runtimeEnvironment) {
        const envRef = deployProp.runtimeEnvironment;
        const envConn = await doGetConnection(pool, { workspaceId }, envRef.connectionId);
        if (!envConn) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_NOT_FOUND',
            message: 'Runtime environment connection not found in workspace',
          });
          return { run: failed, phase: 'rejected_runtime_env_missing', eventsEmitted };
        }

        if (envConn.provider !== 'deployment_env') {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_INVALID_PROVIDER',
            message: 'Runtime environment connection provider must be "deployment_env"',
          });
          return { run: failed, phase: 'rejected_runtime_env_provider', eventsEmitted };
        }

        if (!ALLOWED_CONNECTION_STATUSES.has(envConn.status)) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_INELIGIBLE',
            message: `Runtime environment connection status "${envConn.status}" is not eligible for execution`,
          });
          return { run: failed, phase: 'rejected_runtime_env_ineligible', eventsEmitted };
        }

        if (envConn.activeVersion !== envRef.credentialVersion) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_VERSION_MISMATCH',
            message: 'Runtime environment connection active version drifted from proposal',
          });
          return { run: failed, phase: 'rejected_runtime_env_version_mismatch', eventsEmitted };
        }

        const envCred = await getActiveCredential(pool, { workspaceId }, envRef.connectionId);
        if (!envCred || envCred.version !== envRef.credentialVersion) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_CREDENTIAL_MISMATCH',
            message: 'Runtime environment active credential version drifted from proposal',
          });
          return { run: failed, phase: 'rejected_runtime_env_credential_mismatch', eventsEmitted };
        }

        try {
          resolvedRuntimeEnvs = await doResolveRuntimeEnvironment(pool, workspaceId, masterKey!, envRef);
        } catch {
          const failed = await doFailRun(pool, workerId, runId, {
            code: 'RUNTIME_ENVIRONMENT_RESOLUTION_FAILED',
            message: 'Failed to resolve runtime environment secrets',
          });
          return { run: failed, phase: 'rejected_runtime_env_resolution', eventsEmitted };
        }
      }

      // Heartbeat check immediately before upload mutation
      await performFencedHeartbeat();

      // Step A1: Upload source archive
      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'upload_source',
          progress: 55,
          message: 'Uploading source archive to Liara',
        },
      });
      eventsEmitted++;

      const uploadOutcome = await adapter.uploadSource(
        {
          appSlug: deployProp.appId,
          sourceArchiveBytes: deployBundleBytes!,
          filename: 'source.tar.gz',
        },
        authority
      );

      if (uploadOutcome.status === 'unknown') {
        const safeOutput = {
          phase: 'upload_uncertain',
          message: uploadOutcome.safeMessage,
          correlationId: uploadOutcome.correlationId,
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'upload_uncertain', eventsEmitted, output: safeOutput };
      }

      if (uploadOutcome.status === 'rejected') {
        const failed = await doFailRun(pool, workerId, runId, {
          code: uploadOutcome.code,
          message: uploadOutcome.safeMessage,
        });
        return { run: failed, phase: 'rejected_upload', eventsEmitted };
      }

      const sourceId = uploadOutcome.data.sourceId;

      // CRITICAL BOUNDARY CHECKS BEFORE SECOND MUTATION (createRelease):
      // 1. Heartbeat check: ensure lease is still active and worker is not fenced
      await performFencedHeartbeat();

      // 2. Recheck approval expiry at boundary after upload completion
      const preReleaseNow = getNow();
      let latestApprovalAfterUpload: ApprovedAgentAction | null = null;
      try {
        latestApprovalAfterUpload = await getApprovedAction(pool, { workspaceId }, runId);
      } catch {
        const safeOutput = {
          phase: 'pre_release_check_failed',
          message: 'Failed to query approval state before release creation; release aborted',
          sourceId,
        };
        const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
        return { run: updated ?? claimedRun, phase: 'pre_release_check_failed', eventsEmitted, output: safeOutput };
      }

      if (
        !latestApprovalAfterUpload ||
        preReleaseNow.getTime() >= new Date(latestApprovalAfterUpload.expiresAt).getTime()
      ) {
        const safeOutput = {
          phase: 'approval_expired_after_upload',
          message: 'Approval dispatch window expired after source upload; release creation aborted',
          sourceId,
        };
        const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
        return { run: updated ?? claimedRun, phase: 'approval_expired_after_upload', eventsEmitted, output: safeOutput };
      }

      // 3. Recheck connection status and active credential version at boundary
      let latestConn: Connection | null = null;
      let latestCred: ConnectionCredentialVersion | null = null;
      try {
        latestConn = await doGetConnection(pool, { workspaceId }, deployProp.connectionId);
        latestCred = await getActiveCredential(pool, { workspaceId }, deployProp.connectionId);
      } catch {
        const safeOutput = {
          phase: 'pre_release_check_failed',
          message: 'Failed to verify connection state before release creation; release aborted',
          sourceId,
        };
        const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
        return { run: updated ?? claimedRun, phase: 'pre_release_check_failed', eventsEmitted, output: safeOutput };
      }

      if (
        !latestConn ||
        !ALLOWED_CONNECTION_STATUSES.has(latestConn.status) ||
        !latestCred ||
        latestCred.version !== deployProp.credentialVersion ||
        latestConn.activeVersion !== deployProp.credentialVersion
      ) {
        const safeOutput = {
          phase: 'credential_changed_after_upload',
          message: 'Connection status or credential version drifted after source upload; release creation aborted',
          sourceId,
        };
        const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
        return { run: updated ?? claimedRun, phase: 'credential_changed_after_upload', eventsEmitted, output: safeOutput };
      }

      // 4. Recheck runtime environment status and active credential version at boundary after upload
      if (deployProp.runtimeEnvironment) {
        const envRef = deployProp.runtimeEnvironment;
        let latestEnvConn: Connection | null = null;
        let latestEnvCred: ConnectionCredentialVersion | null = null;
        try {
          latestEnvConn = await doGetConnection(pool, { workspaceId }, envRef.connectionId);
          latestEnvCred = await getActiveCredential(pool, { workspaceId }, envRef.connectionId);
        } catch {
          const safeOutput = {
            phase: 'runtime_env_drift_after_upload',
            message: 'Failed to query runtime environment connection state before release creation; release aborted',
            sourceId,
          };
          const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
          return { run: updated ?? claimedRun, phase: 'runtime_env_drift_after_upload', eventsEmitted, output: safeOutput };
        }

        if (
          !latestEnvConn ||
          latestEnvConn.provider !== 'deployment_env' ||
          !ALLOWED_CONNECTION_STATUSES.has(latestEnvConn.status) ||
          latestEnvConn.activeVersion !== envRef.credentialVersion ||
          !latestEnvCred ||
          latestEnvCred.version !== envRef.credentialVersion
        ) {
          const safeOutput = {
            phase: 'runtime_env_drift_after_upload',
            message: 'Runtime environment connection status or credential version drifted after source upload; release creation aborted',
            sourceId,
          };
          const updated = await setFencedRunStatus(pool, workerId, runId, 'outcome_unknown', safeOutput);
          return { run: updated ?? claimedRun, phase: 'runtime_env_drift_after_upload', eventsEmitted, output: safeOutput };
        }
      }

      // Step A2: Create Release
      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'create_release',
          progress: 70,
          message: 'Triggering release build on Liara',
        },
      });
      eventsEmitted++;

      const releaseOutcome = await adapter.createRelease(
        {
          appSlug: deployProp.appId,
          sourceId,
          platform: deployProp.platform,
          port: deployProp.port,
          runtimeEnvs: resolvedRuntimeEnvs,
          ...(deployProp.buildLocation ? { build: { location: deployProp.buildLocation } } : {}),
          ...(deployProp.platformConfig ? { platformConfig: deployProp.platformConfig } : {}),
        },
        authority
      );

      if (releaseOutcome.status === 'unknown') {
        const safeOutput = {
          phase: 'create_release_uncertain',
          message: releaseOutcome.safeMessage,
          correlationId: releaseOutcome.correlationId,
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'create_release_uncertain', eventsEmitted, output: safeOutput };
      }

      if (releaseOutcome.status === 'rejected') {
        const failed = await doFailRun(pool, workerId, runId, {
          code: releaseOutcome.code,
          message: releaseOutcome.safeMessage,
        });
        return { run: failed, phase: 'rejected_release_create', eventsEmitted };
      }

      const releaseId = releaseOutcome.data.releaseId;

      // Immediately persist provider releaseId in run.output via fenced SQL JSON patch
      await persistReleaseIdInOutput(pool, workerId, runId, releaseId);

      // Step A3: Poll release status (hard bounded deadline: max 600s, 5s intervals)
      const pollDeadlineMs = 600_000;
      const pollIntervalMs = 5_000;
      const startTime = getNow().getTime();
      let releaseDetail: SafeLiaraReleaseDetail | null = null;
      let pollSuccess = false;

      while (getNow().getTime() - startTime < pollDeadlineMs) {
        await sleep(pollIntervalMs);
        await performFencedHeartbeat();

        await appendEvent(pool, workerId, runId, {
          type: 'step_progress',
          payload: {
            step: 'build_poll',
            progress: 85,
            message: 'Polling release build state from provider',
          },
        });
        eventsEmitted++;

        try {
          releaseDetail = await adapter.getReleaseDetail(deployProp.appId, releaseId);
        } catch {
          continue;
        }

        if (!releaseDetail) {
          continue;
        }

        const stateUpper = (releaseDetail.state || releaseDetail.status || '').toUpperCase();

        if (stateUpper === 'READY') {
          pollSuccess = true;
          break;
        }

        if (
          stateUpper === 'FAILED' ||
          stateUpper === 'UNHEALTHY' ||
          stateUpper === 'CANCELED' ||
          stateUpper === 'TIMEDOUT'
        ) {
          const failed = await doFailRun(pool, workerId, runId, {
            code: `RELEASE_BUILD_${stateUpper}`,
            message: `Liara release build reported ${stateUpper} status`,
          });
          await appendEvent(pool, workerId, runId, {
            type: 'run_failed',
            payload: {
              errorCode: `RELEASE_BUILD_${stateUpper}`,
              errorMessage: `Liara release build reported ${stateUpper} status`,
            },
          }).catch(() => {});
          return { run: failed, phase: 'release_build_failed', eventsEmitted };
        }
      }

      if (!pollSuccess) {
        const safeOutput = {
          message: 'Bounded release build polls expired before reaching READY state',
          phase: 'build_poll_timeout',
          releaseId,
          providerState: releaseDetail?.state ?? 'UNKNOWN',
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'build_poll_timeout', eventsEmitted, output: safeOutput };
      }

      // Step A4: HTTP health verification at fixed-origin https://${validatedAppSlug}.liara.run/
      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'http_verification',
          progress: 95,
          message: 'Executing fixed-origin HTTP health probe',
        },
      });
      eventsEmitted++;

      const probe = await probeLiaraAppHttp(deployProp.appId, httpFetch);

      if (probe.kind === 'healthy_2xx') {
        const finalOutput = {
          message: 'Deployment succeeded; release is READY on provider and root path HTTP 200 observed (limited to provider state and root HTTP health, not cryptographic revision health)',
          verification: {
            releaseId,
            providerState: 'READY',
            httpStatus: probe.status,
          },
          phase: 'verified',
        };

        await appendEvent(pool, workerId, runId, {
          type: 'run_succeeded',
          payload: {
            resultSummary: 'Release READY and root HTTP 200 observed',
            completedAt: getNow().toISOString(),
          },
        });
        eventsEmitted++;

        const completed = await doCompleteRun(pool, workerId, runId, finalOutput);
        return { run: completed, phase: 'verified', eventsEmitted, output: finalOutput };
      }

      if (probe.kind === 'not_found_404') {
        const failed = await doFailRun(pool, workerId, runId, {
          code: 'HTTP_404_NOT_FOUND',
          message: 'HTTP verification probe returned 404 Not Found',
        });
        await appendEvent(pool, workerId, runId, {
          type: 'run_failed',
          payload: {
            errorCode: 'HTTP_404_NOT_FOUND',
            errorMessage: 'HTTP verification probe returned 404 Not Found',
          },
        }).catch(() => {});
        return { run: failed, phase: 'http_404_failure', eventsEmitted };
      }

      // Redirects, 5xx, or network errors after READY release => outcome_unknown
      const safeOutput = {
        message: 'Release is READY on provider but HTTP verification was inconclusive',
        verification: {
          releaseId,
          providerState: 'READY',
          httpStatus: probe.status,
          probeKind: probe.kind,
        },
        phase: 'http_uncertain',
      };
      const updated = await setFencedRunStatus(
        pool,
        workerId,
        runId,
        'outcome_unknown',
        safeOutput
      );
      return { run: updated ?? claimedRun, phase: 'http_uncertain', eventsEmitted, output: safeOutput };
    }

    // ---------------------------------------------------------------------------
    // BRANCH B: CREATE APP OPERATION
    // ---------------------------------------------------------------------------
    if (proposal.kind === 'create_app') {
      const createAppProp = proposal as CreateAppProposal;

      // Heartbeat check immediately before create app mutation
      await performFencedHeartbeat();

      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'create_app',
          progress: 60,
          message: 'Dispatching create application request to Liara',
        },
      });
      eventsEmitted++;

      const createAppPayload: CompatibleCreateAppParams = {
        appSlug: createAppProp.appId,
        platform: createAppProp.platform,
        planId: createAppProp.planId,
        bundlePlanId: createAppProp.bundlePlanId,
        networkId: createAppProp.networkId,
      };

      let createOutcome: LiaraExecutionOutcome<{ appSlug: string; planId: string; bundlePlanId?: string }>;
      try {
        createOutcome = await adapter.createApp(createAppPayload as CreateAppParams, authority);
      } catch {
        const safeOutput = {
          phase: 'create_app_uncertain',
          message: 'Create app dispatch call failed ambiguously; dispatch outcome unknown',
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'create_app_uncertain', eventsEmitted, output: safeOutput };
      }

      if (!createOutcome || createOutcome.status === 'unknown') {
        const safeOutput = {
          phase: 'create_app_uncertain',
          message: createOutcome?.safeMessage || 'Create app dispatch outcome is unknown',
          correlationId: createOutcome?.correlationId,
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'create_app_uncertain', eventsEmitted, output: safeOutput };
      }

      if (createOutcome.status === 'rejected') {
        const failed = await doFailRun(pool, workerId, runId, {
          code: createOutcome.code || 'CREATE_APP_REJECTED',
          message: createOutcome.safeMessage || 'Create app rejected by provider',
        });
        return { run: failed, phase: 'rejected_create_app', eventsEmitted };
      }

      // accepted is NOT success: getAppDetail bounded poll to verify exact projectId slug, platform, plan, and bundlePlan
      const MAX_POLL_ATTEMPTS = 5;
      const POLL_INTERVAL_MS = 1000;
      let verifiedDetail: SafeLiaraAppDetail | null = null;
      let planVerified = false;
      let bundlePlanVerified = false;

      for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await performFencedHeartbeat();
        let attemptPlanVerified = false;
        let attemptBundlePlanVerified = false;
        try {
          const detail = await adapter.getAppDetail(createAppProp.appId);
          if (detail) {
            const returnedSlug = (detail.projectId || '').toLowerCase();
            const returnedPlatform = (detail.type || '').toLowerCase();

            if (returnedSlug === createAppProp.appId.toLowerCase() && returnedPlatform === createAppProp.platform.toLowerCase()) {
              // Inspect plan on DTO
              const rawPlan = detail.planID || detail.planId || detail.plan;
              if (rawPlan && typeof rawPlan === 'string' && rawPlan.trim()) {
                if (rawPlan.trim().toLowerCase() !== createAppProp.planId.toLowerCase()) {
                  const failed = await doFailRun(pool, workerId, runId, {
                    code: 'PLAN_VERIFICATION_MISMATCH',
                    message: 'Provider application plan does not match requested proposal plan; manual verification required',
                  });
                  return { run: failed, phase: 'rejected_plan_mismatch', eventsEmitted };
                }
                attemptPlanVerified = true;
              }

              // Inspect bundlePlanID on DTO
              const rawBundle = detail.bundlePlanID || detail.bundlePlanId;
              if (rawBundle && typeof rawBundle === 'string' && rawBundle.trim()) {
                if (rawBundle.trim().toLowerCase() !== createAppProp.bundlePlanId.toLowerCase()) {
                  const failed = await doFailRun(pool, workerId, runId, {
                    code: 'BUNDLE_PLAN_VERIFICATION_MISMATCH',
                    message: 'Provider application bundle plan does not match requested proposal bundle plan; manual verification required',
                  });
                  return { run: failed, phase: 'rejected_bundle_plan_mismatch', eventsEmitted };
                }
                attemptBundlePlanVerified = true;
              }

              // ONE SAME SNAPSHOT MUST SATISFY BOTH PLAN AND BUNDLE PLAN
              if (attemptPlanVerified && attemptBundlePlanVerified) {
                verifiedDetail = detail;
                planVerified = true;
                bundlePlanVerified = true;
                break;
              }
            }
          }
        } catch {
          // App detail not yet readable; continue bounded poll
        }

        if (attempt < MAX_POLL_ATTEMPTS) {
          await sleep(POLL_INTERVAL_MS);
        }
      }

      if (!verifiedDetail || !planVerified || !bundlePlanVerified) {
        const safeOutput = {
          phase: 'provisioning_unconfirmed',
          message: 'Application was created on provider but plan or bundle configuration could not be fully confirmed; manual check required',
          verification: {
            providerAccepted: true,
            providerState: verifiedDetail?.status ?? 'UNKNOWN',
            platformVerified: Boolean(verifiedDetail),
            planVerified,
            bundlePlanVerified,
          },
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        return { run: updated ?? claimedRun, phase: 'provisioning_unconfirmed', eventsEmitted, output: safeOutput };
      }

      await appendEvent(pool, workerId, runId, {
        type: 'step_progress',
        payload: {
          step: 'verify_app_provisioned',
          progress: 95,
          message: 'Application existence, platform, and plan configuration verified on provider',
        },
      });
      eventsEmitted++;

      const safeOutput: Record<string, unknown> = {
        message: `Application "${createAppProp.appId}" successfully created and verified on Liara`,
        phase: 'provisioned',
        verified: true,
        appId: createAppProp.appId,
        platform: createAppProp.platform,
        verification: {
          providerAccepted: true,
          providerState: verifiedDetail.status || 'CREATED',
          platformVerified: true,
          planVerified: true,
          planId: createAppProp.planId,
          bundlePlanVerified: true,
          bundlePlanId: createAppProp.bundlePlanId,
          approvedConfigurationVerified: true,
        },
      };

      const completed = await doCompleteRun(pool, workerId, runId, safeOutput);
      return { run: completed, phase: 'provisioned', eventsEmitted, output: safeOutput };
    }

    // ---------------------------------------------------------------------------
    // BRANCH C: RESTART OPERATION
    // ---------------------------------------------------------------------------
    const restartProp = proposal as RestartProposal;

    // Heartbeat check immediately before restart mutation
    await performFencedHeartbeat();

    await appendEvent(pool, workerId, runId, {
      type: 'step_progress',
      payload: {
        step: 'restart_app',
        progress: 60,
        message: 'Dispatching restart request to Liara',
      },
    });
    eventsEmitted++;

    const restartOutcome = await adapter.restartApp({ appSlug: restartProp.appId }, authority);

    if (restartOutcome.status === 'unknown') {
      const safeOutput = {
        phase: 'restart_uncertain',
        message: restartOutcome.safeMessage,
        correlationId: restartOutcome.correlationId,
      };
      const updated = await setFencedRunStatus(
        pool,
        workerId,
        runId,
        'outcome_unknown',
        safeOutput
      );
      return { run: updated ?? claimedRun, phase: 'restart_uncertain', eventsEmitted, output: safeOutput };
    }

    if (restartOutcome.status === 'rejected') {
      const failed = await doFailRun(pool, workerId, runId, {
        code: restartOutcome.code,
        message: restartOutcome.safeMessage,
      });
      return { run: failed, phase: 'rejected_restart', eventsEmitted };
    }

    // Probe HTTP health for restart:
    // Provider HTTP healthy does not prove container restart occurred.
    // Outputs phase 'accepted_observed_healthy' with status 'waiting_external'.
    const probe = await probeLiaraAppHttp(restartProp.appId, httpFetch);

    if (probe.kind === 'healthy_2xx') {
      const safeOutput = {
        message: 'Restart requested and acknowledged by provider; HTTP healthy observed but container restart timestamp baseline cannot be proven',
        verification: {
          providerAccepted: true,
          httpStatus: probe.status,
        },
        phase: 'accepted_observed_healthy',
      };
      const updated = await setFencedRunStatus(
        pool,
        workerId,
        runId,
        'waiting_external',
        safeOutput
      );
      return {
        run: updated ?? claimedRun,
        phase: 'accepted_observed_healthy',
        eventsEmitted,
        output: safeOutput,
      };
    }

    const safeOutput = {
      message: 'Restart requested and acknowledged by provider; HTTP probe did not observe 2xx health',
      verification: {
        providerAccepted: true,
        httpStatus: probe.status,
        probeKind: probe.kind,
      },
      phase: 'restart_probe_uncertain',
    };
    const updated = await setFencedRunStatus(
      pool,
      workerId,
      runId,
      'outcome_unknown',
      safeOutput
    );
    return {
      run: updated ?? claimedRun,
      phase: 'restart_probe_uncertain',
      eventsEmitted,
      output: safeOutput,
    };
  } catch (err) {
    // If dispatched, an unexpected error must set outcome_unknown with fenced query (never throw unhandled or mark failed)
    if (isDispatched) {
      try {
        const safeOutput = {
          message: 'Unexpected worker error occurred after dispatch; outcome is uncertain',
          phase: 'post_dispatch_error_uncertain',
        };
        const updated = await setFencedRunStatus(
          pool,
          workerId,
          runId,
          'outcome_unknown',
          safeOutput
        );
        if (updated) {
          return { run: updated, phase: 'post_dispatch_error_uncertain', eventsEmitted, output: safeOutput };
        }
      } catch {
        // Fall through to rethrow if DB update failed
      }
    }
    throw err;
  } finally {
    activeRunsInProcess.delete(runId);
    await stopHeartbeat();
  }
}
