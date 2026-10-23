import pg from 'pg';
import {
  type AppMonitor,
  type AppMonitorIncident,
  type HealthPath,
  type CheckRecordOutcome,
  validateMonitorAppSlug,
  claimDueMonitors,
  claimSpecificMonitor,
  isClaimActive,
  recordMonitorCheckResult,
  getOpenIncidentForMonitor,
  getActiveCredentialVersion,
  getConnection,
} from '@laira/db';
import {
  decryptCredential,
  type CredentialEnvelope,
  type AadContext,
} from '@laira/security';
import { LiaraOperationalAdapter } from '@laira/providers/liara/operational';
import { parseLiaraDecryptedCredential } from './handlers/liara-credential.js';

export interface HttpProbeResult {
  ok: boolean;
  httpStatus: number | null;
}

export type StaticProviderState =
  | 'ready'
  | 'failed'
  | 'pending'
  | 'http_ok'
  | 'http_error'
  | 'network_error'
  | 'provider_unreachable'
  | 'unconfirmed'
  | 'unknown';

export interface ProviderVerificationResult {
  confirmedRecovery: boolean;
  providerState: StaticProviderState;
}

export interface MonitorExecutionDependencies {
  fetchFn?: typeof fetch;
  probeTimeoutMs?: number;
  masterKey?: string | Buffer;
  createLiaraAdapter?: (config: { apiKey: string; teamId?: string }) => LiaraOperationalAdapter;
  now?: () => Date;
}

/**
 * Fixed deterministic HTTP health probe.
 * Enforces:
 * - Fixed URL pattern https://${validatedSlug}.liara.run${healthPath}
 * - Manual redirect (3xx or opaqueredirect rejected as unhealthy)
 * - 10s whole-request timeout
 * - Body stream cancellation (never buffering unneeded payload bytes)
 */
export async function performHttpHealthProbe(
  appSlug: string,
  healthPath: HealthPath,
  deps?: { fetchFn?: typeof fetch; timeoutMs?: number }
): Promise<HttpProbeResult> {
  const validatedSlug = validateMonitorAppSlug(appSlug);
  const safePath = healthPath === '/api/health' ? '/api/health' : '/';
  const targetUrl = `https://${validatedSlug}.liara.run${safePath}`;
  const fetchImpl = deps?.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps?.timeoutMs ?? 10_000;

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined = undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
      reject(new Error('HTTP health probe timed out'));
    }, timeoutMs);
  });

  const fetchPromise = (async (): Promise<HttpProbeResult> => {
    let response: Response;
    try {
      response = await fetchImpl(targetUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return { ok: false, httpStatus: null };
    }

    // Cancel / drain response body immediately to prevent resource leakage
    try {
      if (response.body) {
        await response.body.cancel();
      }
    } catch {}

    // Reject redirects: 3xx or opaqueredirect is not a verified healthy endpoint
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      return { ok: false, httpStatus: response.status };
    }

    const ok = response.status >= 200 && response.status < 300;
    return { ok, httpStatus: response.status };
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch {
    return { ok: false, httpStatus: null };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    try {
      controller.abort();
    } catch {}
  }
}

/**
 * Validates provider app state and exact current release status.
 * Enforces:
 * - Checks connection provider is strictly 'liara'.
 * - Validates credential row algorithm ('aes-256-gcm') and keyVersion (1) before decrypt.
 * - Decrypts credentials strictly via existing master key & parseLiaraDecryptedCredential.
 * - Confirms app same ID (appSlug matches project detail ID).
 * - Resolves exact current release: uses appDetail release ID if present, else deterministically
 *   sorts valid createdAt releases newest and fetches exact release detail.
 * - If releases are missing, unordered/unknown createdAt, or release detail not READY: confirmedRecovery is false.
 *   No app_running fallback.
 * - providerState is strictly a STATIC enum (never interpolating provider IDs, canary tokens, or raw statuses).
 */
export async function verifyProviderAppState(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspaceId: string,
  connectionId: string,
  appSlug: string,
  deps?: MonitorExecutionDependencies
): Promise<ProviderVerificationResult> {
  const cleanSlug = validateMonitorAppSlug(appSlug);
  const masterKey = deps?.masterKey ?? process.env.ENCRYPTION_MASTER_KEY;

  if (!masterKey) {
    return { confirmedRecovery: false, providerState: 'unknown' };
  }

  try {
    // 1. Connection must exist in workspace, be active, and provider must be liara
    const conn = await getConnection(poolOrClient, { workspaceId }, connectionId);
    if (!conn || conn.provider !== 'liara' || (conn.status !== 'active' && conn.status !== 'configured_unverified')) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    // 2. Fetch active credential version and validate algorithm and keyVersion
    const credRow = await getActiveCredentialVersion(poolOrClient, { workspaceId }, connectionId);
    if (!credRow) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    if (credRow.algorithm !== 'aes-256-gcm' || credRow.keyVersion !== 1) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    // 3. Decrypt credential envelope with strict AAD binding
    const envelope: CredentialEnvelope = {
      algorithm: 'aes-256-gcm',
      ciphertext: credRow.ciphertext,
      iv: credRow.iv,
      tag: credRow.tag,
      keyVersion: credRow.keyVersion,
      workspaceId,
      connectionId,
      version: String(credRow.version),
    };
    const aadContext: AadContext = {
      workspaceId,
      connectionId,
      version: String(credRow.version),
      keyVersion: credRow.keyVersion,
    };

    const decryptedBuffer = decryptCredential(envelope, masterKey, aadContext);
    const parsedCred = parseLiaraDecryptedCredential(decryptedBuffer.toString('utf8'));

    // 4. Instantiate Liara adapter
    const adapter = deps?.createLiaraAdapter
      ? deps.createLiaraAdapter({ apiKey: parsedCred.apiKey, teamId: parsedCred.teamId })
      : new LiaraOperationalAdapter({
          apiKey: parsedCred.apiKey,
          teamId: parsedCred.teamId,
          fetchFn: deps?.fetchFn,
        });

    // 5. Query app detail and confirm app same ID
    const appDetail = await adapter.getAppDetail(cleanSlug);
    if (!appDetail || !appDetail.projectId || appDetail.projectId.toLowerCase() !== cleanSlug.toLowerCase()) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    // 6. Determine exact current release ID.
    // Provider DTO createdAt may lack precision across endpoints, making timestamp sorting unsafe
    // against picking old READY over newest FAILED.
    // Safest approach: NO timestamp fallback if actual current release identity is not preserved.
    // Only use explicit current release ID from appDetail; otherwise unconfirmed.
    let targetReleaseId: string | undefined = undefined;
    const directCandidate = (appDetail as any).currentReleaseId ?? (appDetail as any).releaseId ?? (appDetail as any).current_release_id;

    if (typeof directCandidate === 'string' && directCandidate.trim()) {
      targetReleaseId = directCandidate.trim();
    } else {
      // Without explicit current release identity preserved, refuse unconfirmed recovery
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    if (!targetReleaseId) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    // 7. Fetch exact release detail to verify READY status
    const releaseDetail = await adapter.getReleaseDetail(cleanSlug, targetReleaseId);
    if (!releaseDetail) {
      return { confirmedRecovery: false, providerState: 'unconfirmed' };
    }

    const stateUpper = releaseDetail.state?.toUpperCase();
    if (stateUpper === 'READY') {
      return {
        confirmedRecovery: true,
        providerState: 'ready',
      };
    }

    if (stateUpper === 'FAILED' || stateUpper === 'CRASHED') {
      return {
        confirmedRecovery: false,
        providerState: 'failed',
      };
    }

    if (stateUpper === 'PENDING' || stateUpper === 'BUILDING' || stateUpper === 'DEPLOYING') {
      return {
        confirmedRecovery: false,
        providerState: 'pending',
      };
    }

    return {
      confirmedRecovery: false,
      providerState: 'unconfirmed',
    };
  } catch {
    // Fail safe: static error state, never leak raw provider payloads or errors
    return {
      confirmedRecovery: false,
      providerState: 'provider_unreachable',
    };
  }
}

export interface DeterministicCheckResult {
  monitor: AppMonitor;
  incident: AppMonitorIncident | null;
  incidentAction: 'none' | 'opened' | 'updated' | 'resolved';
  probeResult: HttpProbeResult;
}

/**
 * Executes ONE deterministic health check for a monitor.
 * Safe for CLI manual invocation and worker queue loop.
 * Enforces:
 * - Atomic exclusive lease acquisition BEFORE any network call (never overwrites active lease).
 * - Pre-dispatch revalidation: revalidates active claim in DB immediately before HTTP request;
 *   if paused while in flight, claim is cleared and ZERO HTTP requests are dispatched.
 * - Leased write fencing when persisting outcome.
 * - Static evidence ONLY: { httpStatus, probeKind: 'http', providerState, checkedAt }.
 */
export async function executeDeterministicMonitorCheck(
  pool: pg.Pool,
  monitor: AppMonitor,
  deps?: MonitorExecutionDependencies,
  internalClaimToken?: string
): Promise<DeterministicCheckResult> {
  // If paused, skip HTTP requests entirely
  if (!monitor.isActive) {
    return {
      monitor,
      incident: null,
      incidentAction: 'none',
      probeResult: { ok: false, httpStatus: null },
    };
  }

  let claimToken = internalClaimToken;

  // 1. If not pre-claimed by service loop, atomically acquire exclusive lease in DB BEFORE network
  if (!claimToken) {
    const claimRes = await claimSpecificMonitor(pool, monitor.id, {
      leaseTimeoutSeconds: 120,
    });
    if (!claimRes.claimed || !claimRes.claimToken) {
      // Could not acquire lease: another worker or CLI holds active lease, or monitor is paused.
      // Never overwrite active lease; do not dispatch HTTP!
      return {
        monitor,
        incident: null,
        incidentAction: 'none',
        probeResult: { ok: false, httpStatus: null },
      };
    }
    claimToken = claimRes.claimToken;
  }

  // 2. Pre-dispatch revalidation immediately before network (Finding 5)
  const isStillActive = await isClaimActive(pool, monitor.id, claimToken);
  if (!isStillActive) {
    // Monitor was paused or lease expired before network call -> ZERO HTTP requests!
    return {
      monitor,
      incident: null,
      incidentAction: 'none',
      probeResult: { ok: false, httpStatus: null },
    };
  }

  const now = deps?.now ? deps.now() : new Date();

  // 3. Fixed URL health probe (exclusive lease held and verified)
  const probeResult = await performHttpHealthProbe(
    monitor.appSlug,
    monitor.healthPath,
    {
      fetchFn: deps?.fetchFn,
      timeoutMs: deps?.probeTimeoutMs,
    }
  );

  let providerState: StaticProviderState = 'unknown';
  let providerConfirmedRecovery = false;

  if (probeResult.ok) {
    // Check if recovery confirmation is needed (open incident + reaching 3 consecutive successes)
    const openIncident = await getOpenIncidentForMonitor(pool, monitor.id);
    if (openIncident && monitor.consecutiveSuccesses + 1 >= 3) {
      const providerCheck = await verifyProviderAppState(
        pool,
        monitor.workspaceId,
        monitor.connectionId,
        monitor.appSlug,
        deps
      );
      providerConfirmedRecovery = providerCheck.confirmedRecovery;
      providerState = providerCheck.providerState;
    } else {
      providerState = 'http_ok';
    }
  } else {
    // Probe failed
    providerState = probeResult.httpStatus !== null ? 'http_error' : 'network_error';
  }

  // 4. Persist outcome with lease write fencing (always DB NOW() in production)
  const outcome: CheckRecordOutcome = await recordMonitorCheckResult(pool, {
    monitorId: monitor.id,
    claimToken,
    checkedAt: now,
    httpStatus: probeResult.httpStatus,
    probeOk: probeResult.ok,
    providerState,
    providerConfirmedRecovery,
  });

  return {
    monitor: outcome.monitor || monitor,
    incident: outcome.incident,
    incidentAction: outcome.incidentAction,
    probeResult,
  };
}

/**
 * Persistent deterministic background monitoring service for AppWorker.
 * Ticks periodically, claims due monitors with SKIP LOCKED, executes checks.
 * Pause survives worker restarts.
 */
export class AppMonitorService {
  private pool: pg.Pool;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private activeChecksCount = 0;
  private deps: MonitorExecutionDependencies;

  constructor(pool: pg.Pool, deps?: MonitorExecutionDependencies) {
    this.pool = pool;
    this.deps = deps || {};
  }

  public start(pollIntervalMs = 5000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const tick = async () => {
      if (!this.isRunning) return;

      try {
        const dueMonitors = await claimDueMonitors(this.pool, {
          now: new Date(),
          leaseTimeoutSeconds: 120,
          limit: 10,
        });

        for (const monitor of dueMonitors) {
          if (!this.isRunning) break;
          this.activeChecksCount++;
          executeDeterministicMonitorCheck(this.pool, monitor, this.deps, monitor.claimToken || undefined)
            .catch((err) => {
              // Log safely without leaking secrets
              console.error(`[AppMonitorService] Check failed for monitor ${monitor.id}: ${(err as Error).message}`);
            })
            .finally(() => {
              this.activeChecksCount--;
            });
        }
      } catch (err) {
        console.error(`[AppMonitorService] Error claiming due monitors: ${(err as Error).message}`);
      }

      if (this.isRunning) {
        this.timer = setTimeout(tick, pollIntervalMs);
      }
    };

    this.timer = setTimeout(tick, 1000);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait for in-flight checks to complete (bounded to 10s)
    const deadline = Date.now() + 10_000;
    while (this.activeChecksCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  public get running(): boolean {
    return this.isRunning;
  }
}
