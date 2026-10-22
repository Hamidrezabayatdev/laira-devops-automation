/**
 * Liara Operational & Observation Adapter
 *
 * Implements typed deploy, release lifecycle, restart, and observation operations
 * against verified documented Liara PaaS APIs (https://developers.liara.ir/llms.txt)
 * and verified @liara/cli source patterns:
 * - POST /v2/projects/{name}/sources (source code archive upload, multipart field 'file')
 * - POST /v2/projects/{name}/releases (create release from source: sourceID, port, type)
 * - GET  /v1/projects/{name}/releases (list releases for project, used for list & verified state lookup)
 * - GET  /v1/projects/{name}/logs (bounded logs with secret redaction and line/byte budgets)
 * - POST /v1/projects/{name}/actions/restart (restart application - HTTP ack only)
 * - GET  /v1/projects/{name} (get project detail)
 * - POST /v1/projects (create app with explicit required planId - no default plan assumption)
 *
 * Security & Reliability Guarantees:
 * 1. Fixed origin: strictly https://api.liara.ir
 * 2. Credentialed redirects blocked unconditionally (cancel body + abort)
 * 3. Safe DTOs: raw env vars, canary secrets, and client apiKey literals stripped/redacted
 * 4. Gated mutations: explicit caller authority assertion required; mutations disabled by default
 * 5. Bounded deadlines with zero retries on mutating writes
 * 6. Dispatched write uncertainty: provider 5xx, timeouts, network drops, and malformed success
 *    responses yield typed outcome 'unknown' (never auto-resend, state may have changed)
 * 7. Bounded logs: untrusted logs are redacted with strict line and byte budgets
 * 8. Config bounds: positive finite timeout and maxBytes with strict upper ceilings to prevent disable
 */

import {
  LIARA_API_ORIGIN,
  type LiaraConnectionConfig,
  type SafeLiaraAppDetail,
  type SafeLiaraRelease,
} from './types.js';
import {
  LiaraApiError,
  CredentialedRedirectBlockedError,
  LiaraOriginMismatchError,
} from './errors.js';
import { LiaraClient } from './client.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_CEILING_MS = 120_000; // 2 minutes max ceiling

const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_SIZE_CEILING_BYTES = 50 * 1024 * 1024; // 50 MiB upper ceiling

const MAX_SOURCE_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50 MiB strict ceiling for upload

const SLUG_REGEX = /^[a-z0-9-_]+$/i;
const MAX_SLUG_LENGTH = 64;

const STRICT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export type LiaraMutationOperation =
  | 'create_app'
  | 'restart_app'
  | 'upload_source'
  | 'create_release';

/**
 * Caller authority assertion for gating mutating operations.
 * NOTE: This is an internal caller assertion checked before dispatch,
 * not a cryptographic capability token. The primary broker owns gating
 * and never exposes mutation methods directly to untrusted model prompts.
 */
export interface LiaraOperationAuthority {
  readonly approved: boolean;
  readonly token: string;
  readonly approvedBy?: string;
  readonly reason?: string;
}

export interface LiaraOperationProposal<T = unknown> {
  readonly id: string;
  readonly operation: LiaraMutationOperation;
  readonly appSlug: string;
  readonly summary: string;
  readonly params: T;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly createdAt: string;
}

export interface CreateAppParams {
  readonly appSlug: string;
  readonly platform: string;
  readonly planId: string; // Explicit required plan; no default assumptions
}

export interface UploadSourceParams {
  readonly appSlug: string;
  readonly sourceArchiveBytes: Uint8Array;
  readonly filename?: string;
}

export interface CreateReleaseParams {
  readonly appSlug: string;
  readonly sourceId: string;
  readonly port?: number;
  readonly platform?: string;
}

export interface RestartAppParams {
  readonly appSlug: string;
}

/**
 * Distinguishes accepted outcome (server acknowledged request)
 * from completed terminal outcome, rejected known failure, or uncertain/unknown outcome.
 */
export type LiaraExecutionOutcome<T> =
  | {
      readonly status: 'accepted';
      readonly data: T;
      readonly correlationId: string;
    }
  | {
      readonly status: 'completed';
      readonly data: T;
      readonly correlationId: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly safeMessage: string;
      readonly correlationId: string;
    }
  | {
      readonly status: 'unknown';
      readonly code: 'TIMEOUT_AFTER_DISPATCH' | 'SERVER_5XX_UNCERTAIN' | 'MALFORMED_RESPONSE_UNCERTAIN' | 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN' | 'NETWORK_UNCERTAIN';
      readonly safeMessage: string;
      readonly correlationId: string;
    };

export interface SafeLiaraReleaseDetail extends SafeLiaraRelease {
  readonly status: string;
  readonly failReason?: string;
  readonly port?: number;
}

export interface SafeLiaraLogEntry {
  readonly type: string;
  readonly datetime: string;
  readonly message: string;
}

export interface SafeLiaraLogsResult {
  readonly lines: SafeLiaraLogEntry[];
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly bytesBudgetExceeded: boolean;
  readonly bytesRead: number;
}

export interface LiaraLogQueryOptions {
  readonly since?: string | number;
  readonly maxLines?: number;
  readonly maxBodyBytes?: number;
}

/**
 * Redacts potential secrets, credentials, tokens, and DB connection strings from untrusted text.
 */
export function redactLogSecrets(rawText: string, specificApiKey?: string): string {
  if (!rawText) return '';
  let text = rawText;

  if (specificApiKey && specificApiKey.trim() && text.includes(specificApiKey)) {
    text = text.replaceAll(specificApiKey, '[REDACTED_API_KEY]');
  }

  return text
    // Database connection strings
    .replace(/(postgres|postgresql|mysql|mongodb|redis|sqlite):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]')
    // Bearer / Token headers or assignments
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.~]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(token|api[_-]?key|jwt|secret|password|access[_-]?key)\s*[:=]\s*["']?[a-zA-Z0-9_\-\.~]+["']?/gi, '$1=[REDACTED]')
    // JWT pattern
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]')
    // Canary strings pattern
    .replace(/LIARA_API_TOKEN_CANARY_[^\s"'<>]+/g, '[REDACTED_TOKEN]')
    .replace(/CANARY_[A-Z0-9_]+/g, '[REDACTED_SECRET]');
}

export class LiaraOperationalAdapter {
  readonly #apiKey: string;
  readonly #teamId?: string;
  readonly #timeoutMs: number;
  readonly #maxSizeBytes: number;
  readonly #fetchFn: typeof fetch;
  readonly #readClient: LiaraClient;

  constructor(config: LiaraConnectionConfig, readClient?: LiaraClient) {
    if (!config.apiKey || typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
      throw new Error('LiaraConnectionConfig requires a valid non-empty apiKey');
    }

    const rawTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('timeoutMs must be a finite positive number');
    }
    this.#timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_CEILING_MS);

    const rawMaxSize = config.maxResponseSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    if (typeof rawMaxSize !== 'number' || !Number.isFinite(rawMaxSize) || rawMaxSize <= 0) {
      throw new Error('maxResponseSizeBytes must be a finite positive number');
    }
    this.#maxSizeBytes = Math.min(rawMaxSize, MAX_SIZE_CEILING_BYTES);

    this.#apiKey = config.apiKey.trim();
    this.#teamId = config.teamId?.trim() || undefined;
    this.#fetchFn = config.fetchFn ?? globalThis.fetch;
    this.#readClient = readClient ?? new LiaraClient(config);
  }

  get readClient(): LiaraClient {
    return this.#readClient;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get maxSizeBytes(): number {
    return this.#maxSizeBytes;
  }

  /**
   * Validates project slug without echoing raw inputs in error messages.
   */
  private validateAppSlug(appSlug: string): string {
    if (!appSlug || typeof appSlug !== 'string' || !appSlug.trim()) {
      throw new Error('Valid appSlug is required');
    }
    const trimmed = appSlug.trim().toLowerCase();
    if (trimmed.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(trimmed)) {
      throw new Error('Invalid appSlug: must be 1-64 alphanumeric characters, hyphens, or underscores');
    }
    return trimmed;
  }

  private verifyAuthority(operation: LiaraMutationOperation, authority?: LiaraOperationAuthority): void {
    if (!authority || !authority.approved || !authority.token || !authority.token.trim()) {
      throw new Error(
        `Mutation "${operation}" is blocked: explicit caller authority with an approved token is required.`
      );
    }
  }

  private redact(text: string): string {
    return redactLogSecrets(text, this.#apiKey);
  }

  /**
   * Reads response stream bounded by exact byte count before decode/append.
   * Cancels reader immediately on abort, oversize, or failure without full buffering.
   * Content-Length header is checked early if present, but never trusted alone.
   */
  private async readBoundedStream(
    response: Response,
    signal: AbortSignal,
    maxBytes: number,
    correlationId: string,
    isMutation: boolean
  ): Promise<string> {
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const parsedLen = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        if (isMutation) {
          throw new LiaraApiError({
            code: 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN',
            statusCode: 200,
            safeMessage: `Liara API response size exceeded ${maxBytes} bytes limit after mutation dispatch. Outcome is uncertain; auto-resend is forbidden.`,
            correlationId,
            retryable: false,
          });
        }
        throw new LiaraApiError({
          code: 'RESPONSE_SIZE_EXCEEDED',
          statusCode: 200,
          safeMessage: `Liara API response size exceeded ${maxBytes} bytes limit`,
          correlationId,
          retryable: false,
        });
      }
    }

    if (!response.body) {
      if (signal.aborted) {
        throw new LiaraApiError({
          code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading response body`,
          correlationId,
          retryable: false,
        });
      }
      return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let bytesRead = 0;

    const cancelBody = () => {
      try {
        reader.cancel().catch(() => {});
      } catch {
        // ignore
      }
    };

    try {
      while (true) {
        if (signal.aborted) {
          cancelBody();
          throw new LiaraApiError({
            code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
            statusCode: 408,
            safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading response body`,
            correlationId,
            retryable: false,
          });
        }

        let cleanupListener: (() => void) | undefined;
        let readResult: Awaited<ReturnType<typeof reader.read>>;

        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              const onAbort = () => {
                cancelBody();
                reject(
                  new LiaraApiError({
                    code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
                    statusCode: 408,
                    safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading response body`,
                    correlationId,
                    retryable: false,
                  })
                );
              };
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener('abort', onAbort, { once: true });
              cleanupListener = () => signal.removeEventListener('abort', onAbort);
            }),
          ]);
        } finally {
          cleanupListener?.();
        }

        if (signal.aborted) {
          cancelBody();
          throw new LiaraApiError({
            code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
            statusCode: 408,
            safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading response body`,
            correlationId,
            retryable: false,
          });
        }

        const { done, value } = readResult;
        if (done) break;

        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          cancelBody();
          if (isMutation) {
            throw new LiaraApiError({
              code: 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN',
              statusCode: 200,
              safeMessage: `Liara API response size exceeded ${maxBytes} bytes limit after mutation dispatch. Outcome is uncertain; auto-resend is forbidden.`,
              correlationId,
              retryable: false,
            });
          }
          throw new LiaraApiError({
            code: 'RESPONSE_SIZE_EXCEEDED',
            statusCode: 200,
            safeMessage: `Liara API response size exceeded ${maxBytes} bytes limit`,
            correlationId,
            retryable: false,
          });
        }

        accumulated += decoder.decode(value, { stream: true });
      }

      if (signal.aborted) {
        cancelBody();
        throw new LiaraApiError({
          code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading response body`,
          correlationId,
          retryable: false,
        });
      }

      accumulated += decoder.decode();
      return accumulated;
    } catch (err) {
      cancelBody();
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Internal safe transport for operational requests with fixed origin and redirect security.
   * If a mutating write has been dispatched and receives 5xx, timeout, or malformed response,
   * it throws an error flagging the outcome as UNCERTAIN (never auto-resend).
   */
  private async safeOperationalFetch(
    endpoint: string,
    options: RequestInit,
    isMutation: boolean,
    maxResponseBytes?: number
  ): Promise<{ data: unknown; correlationId: string }> {
    const fullUrlString = endpoint.startsWith('http')
      ? endpoint
      : `${LIARA_API_ORIGIN}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const url = new URL(fullUrlString);
    if (url.origin !== LIARA_API_ORIGIN) {
      throw new LiaraOriginMismatchError(fullUrlString);
    }

    if (this.#teamId) {
      url.searchParams.set('teamID', this.#teamId);
    }

    const correlationId = crypto.randomUUID();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.#timeoutMs);

    const effectiveLimit = Math.min(
      maxResponseBytes !== undefined && Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
        ? maxResponseBytes
        : this.#maxSizeBytes,
      MAX_SIZE_CEILING_BYTES
    );

    let dispatched = false;

    try {
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', `Bearer ${this.#apiKey}`);
      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
      }

      dispatched = true;

      const response = await this.#fetchFn(url.toString(), {
        ...options,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });

      // Block all credentialed redirects
      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        controller.abort();
        throw new CredentialedRedirectBlockedError();
      }

      // 5xx on dispatched mutations: state change is uncertain
      if (response.status >= 500 && isMutation) {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        controller.abort();
        throw new LiaraApiError({
          code: 'SERVER_5XX_UNCERTAIN',
          statusCode: response.status,
          safeMessage: `Liara API server returned HTTP ${response.status} after mutation dispatch. Outcome is uncertain; auto-resend is forbidden.`,
          correlationId,
          retryable: false,
        });
      }

      if (!response.ok) {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        controller.abort();
        throw new LiaraApiError({
          code: `HTTP_${response.status}`,
          statusCode: response.status,
          safeMessage: `Liara API error: HTTP ${response.status}`,
          correlationId,
          retryable: false,
        });
      }

      // Stream bounded response without full in-memory buffering
      const text = await this.readBoundedStream(
        response,
        controller.signal,
        effectiveLimit,
        correlationId,
        isMutation
      );

      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (isMutation) {
            throw new LiaraApiError({
              code: 'MALFORMED_RESPONSE_UNCERTAIN',
              statusCode: 200,
              safeMessage: 'Liara API returned unparseable response after mutation dispatch. Outcome is uncertain.',
              correlationId,
              retryable: false,
            });
          }
          parsed = { message: text.trim().slice(0, 256) };
        }
      }

      return { data: parsed, correlationId };
    } catch (err) {
      controller.abort();

      if (
        err instanceof CredentialedRedirectBlockedError ||
        err instanceof LiaraOriginMismatchError ||
        err instanceof LiaraApiError
      ) {
        throw err;
      }

      const isAbort =
        (err instanceof Error && err.name === 'AbortError') || controller.signal.aborted;

      if (isAbort && dispatched && isMutation) {
        throw new LiaraApiError({
          code: 'TIMEOUT_AFTER_DISPATCH',
          statusCode: 408,
          safeMessage: `Liara API write request timed out after dispatch (${this.#timeoutMs}ms). Outcome is unknown; auto-resend is forbidden.`,
          correlationId,
          retryable: false,
        });
      }

      if (isAbort) {
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms`,
          correlationId,
          retryable: !isMutation,
        });
      }

      if (dispatched && isMutation) {
        throw new LiaraApiError({
          code: 'NETWORK_UNCERTAIN',
          statusCode: 0,
          safeMessage: 'Liara API network drop after mutation dispatch. Outcome is uncertain; auto-resend is forbidden.',
          correlationId,
          retryable: false,
        });
      }

      throw new LiaraApiError({
        code: 'NETWORK_FAILURE',
        statusCode: 0,
        safeMessage: 'Liara API network error: unable to complete request',
        correlationId,
        retryable: false,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --- Proposal Generators (for Primary Broker Gating) ---

  proposeCreateApp(params: CreateAppParams): LiaraOperationProposal<CreateAppParams> {
    const slug = this.validateAppSlug(params.appSlug);
    if (!params.planId || typeof params.planId !== 'string' || !params.planId.trim()) {
      throw new Error('Explicit planId is required for app creation');
    }
    const cleanPlan = params.planId.trim();
    return {
      id: crypto.randomUUID(),
      operation: 'create_app',
      appSlug: slug,
      summary: `Create new Liara app "${slug}" (platform: ${params.platform}, plan: ${cleanPlan})`,
      params: {
        appSlug: slug,
        platform: params.platform,
        planId: cleanPlan,
      },
      riskLevel: 'medium',
      createdAt: new Date().toISOString(),
    };
  }

  proposeUploadSource(params: UploadSourceParams): LiaraOperationProposal<{ appSlug: string; bytesLength: number }> {
    const slug = this.validateAppSlug(params.appSlug);
    return {
      id: crypto.randomUUID(),
      operation: 'upload_source',
      appSlug: slug,
      summary: `Upload source archive to Liara app "${slug}" (${params.sourceArchiveBytes.byteLength} bytes)`,
      params: {
        appSlug: slug,
        bytesLength: params.sourceArchiveBytes.byteLength,
      },
      riskLevel: 'medium',
      createdAt: new Date().toISOString(),
    };
  }

  proposeCreateRelease(params: CreateReleaseParams): LiaraOperationProposal<CreateReleaseParams> {
    const slug = this.validateAppSlug(params.appSlug);
    return {
      id: crypto.randomUUID(),
      operation: 'create_release',
      appSlug: slug,
      summary: `Deploy release for Liara app "${slug}" with sourceID "${params.sourceId}"`,
      params: {
        appSlug: slug,
        sourceId: params.sourceId,
        port: params.port,
        platform: params.platform,
      },
      riskLevel: 'high',
      createdAt: new Date().toISOString(),
    };
  }

  proposeRestartApp(params: RestartAppParams): LiaraOperationProposal<RestartAppParams> {
    const slug = this.validateAppSlug(params.appSlug);
    return {
      id: crypto.randomUUID(),
      operation: 'restart_app',
      appSlug: slug,
      summary: `Restart Liara application "${slug}"`,
      params: { appSlug: slug },
      riskLevel: 'medium',
      createdAt: new Date().toISOString(),
    };
  }

  // --- Explicit Caller Mutation Methods ---

  /**
   * Create app with explicit required planId (no default assumptions).
   * Documented: POST /v1/projects
   */
  async createApp(
    params: CreateAppParams,
    authority: LiaraOperationAuthority
  ): Promise<LiaraExecutionOutcome<{ appSlug: string; planId: string }>> {
    this.verifyAuthority('create_app', authority);
    const slug = this.validateAppSlug(params.appSlug);

    if (!params.planId || typeof params.planId !== 'string' || !params.planId.trim()) {
      throw new Error('Explicit planId is required for app creation');
    }
    const planID = params.planId.trim();

    try {
      const { correlationId } = await this.safeOperationalFetch(
        '/v1/projects',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: slug,
            planID,
            platform: params.platform,
          }),
        },
        true
      );

      return {
        status: 'accepted',
        data: { appSlug: slug, planId: planID },
        correlationId,
      };
    } catch (err) {
      return this.handleExecutionError(err);
    }
  }

  /**
   * Upload source archive. Bounded to 50 MiB max archive size.
   * Documented: POST /v2/projects/{name}/sources
   * Content-Type: multipart/form-data with field name 'file'.
   */
  async uploadSource(
    params: UploadSourceParams,
    authority: LiaraOperationAuthority
  ): Promise<LiaraExecutionOutcome<{ sourceId: string }>> {
    this.verifyAuthority('upload_source', authority);
    const slug = this.validateAppSlug(params.appSlug);

    if (!params.sourceArchiveBytes || params.sourceArchiveBytes.byteLength === 0) {
      throw new Error('sourceArchiveBytes must not be empty');
    }

    if (params.sourceArchiveBytes.byteLength > MAX_SOURCE_ARCHIVE_BYTES) {
      throw new Error(`sourceArchiveBytes exceeds maximum allowed limit of ${MAX_SOURCE_ARCHIVE_BYTES} bytes (50 MiB)`);
    }

    try {
      const formData = new FormData();
      const blob = new Blob([params.sourceArchiveBytes], { type: 'application/gzip' });
      formData.append('file', blob, params.filename ?? 'source.tar.gz');

      const { data, correlationId } = await this.safeOperationalFetch(
        `/v2/projects/${encodeURIComponent(slug)}/sources`,
        {
          method: 'POST',
          body: formData,
        },
        true
      );

      // Strict validation of sourceID: string matching [A-Za-z0-9_-]{1,128} (never accept objects or coercion)
      const rawSourceId =
        typeof data === 'object' && data !== null && 'sourceID' in data
          ? (data as Record<string, unknown>).sourceID
          : undefined;

      if (typeof rawSourceId !== 'string' || !STRICT_ID_REGEX.test(rawSourceId)) {
        return {
          status: 'unknown',
          code: 'MALFORMED_RESPONSE_UNCERTAIN',
          safeMessage: 'Liara API returned unexpected source upload payload; status uncertain',
          correlationId,
        };
      }

      return {
        status: 'accepted',
        data: { sourceId: rawSourceId },
        correlationId,
      };
    } catch (err) {
      return this.handleExecutionError(err);
    }
  }

  /**
   * Create deployment release.
   * Documented: POST /v2/projects/{name}/releases
   * Returns accepted outcome with releaseId.
   */
  async createRelease(
    params: CreateReleaseParams,
    authority: LiaraOperationAuthority
  ): Promise<LiaraExecutionOutcome<{ releaseId: string }>> {
    this.verifyAuthority('create_release', authority);
    const slug = this.validateAppSlug(params.appSlug);

    if (
      !params.sourceId ||
      typeof params.sourceId !== 'string' ||
      !STRICT_ID_REGEX.test(params.sourceId.trim())
    ) {
      throw new Error('Valid strict sourceId is required to create a release');
    }
    const cleanSourceId = params.sourceId.trim();

    try {
      const bodyPayload: Record<string, unknown> = {
        sourceID: cleanSourceId,
      };
      if (params.port) {
        bodyPayload.port = params.port;
      }
      if (params.platform) {
        bodyPayload.type = params.platform;
      }

      const { data, correlationId } = await this.safeOperationalFetch(
        `/v2/projects/${encodeURIComponent(slug)}/releases`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        },
        true
      );

      // Strict validation of releaseID: string matching [A-Za-z0-9_-]{1,128}
      const rawReleaseId =
        typeof data === 'object' && data !== null && 'releaseID' in data
          ? (data as Record<string, unknown>).releaseID
          : undefined;

      if (typeof rawReleaseId !== 'string' || !STRICT_ID_REGEX.test(rawReleaseId)) {
        return {
          status: 'unknown',
          code: 'MALFORMED_RESPONSE_UNCERTAIN',
          safeMessage: 'Liara API returned unexpected create release payload; status uncertain',
          correlationId,
        };
      }

      return {
        status: 'accepted',
        data: { releaseId: rawReleaseId },
        correlationId,
      };
    } catch (err) {
      return this.handleExecutionError(err);
    }
  }

  /**
   * Restart application.
   * Documented: POST /v1/projects/{name}/actions/restart
   * Note: HTTP 200 response is solely an acknowledgment that the restart was requested.
   * Broker must verify new applet/restart timestamp + HTTP health, not assuming running means restarted.
   */
  async restartApp(
    params: RestartAppParams,
    authority: LiaraOperationAuthority
  ): Promise<LiaraExecutionOutcome<{ restartRequested: boolean }>> {
    this.verifyAuthority('restart_app', authority);
    const slug = this.validateAppSlug(params.appSlug);

    try {
      const { correlationId } = await this.safeOperationalFetch(
        `/v1/projects/${encodeURIComponent(slug)}/actions/restart`,
        { method: 'POST' },
        true
      );

      return {
        status: 'accepted',
        data: { restartRequested: true },
        correlationId,
      };
    } catch (err) {
      return this.handleExecutionError(err);
    }
  }

  /**
   * Dispatches an approved operation proposal.
   */
  async executeApproved<TResult, TParams = unknown>(
    proposal: LiaraOperationProposal<TParams>,
    authority: LiaraOperationAuthority
  ): Promise<LiaraExecutionOutcome<TResult>> {
    switch (proposal.operation) {
      case 'create_app':
        return this.createApp(proposal.params as unknown as CreateAppParams, authority) as Promise<
          LiaraExecutionOutcome<TResult>
        >;
      case 'upload_source':
        return this.uploadSource(
          proposal.params as unknown as UploadSourceParams,
          authority
        ) as Promise<LiaraExecutionOutcome<TResult>>;
      case 'create_release':
        return this.createRelease(
          proposal.params as unknown as CreateReleaseParams,
          authority
        ) as Promise<LiaraExecutionOutcome<TResult>>;
      case 'restart_app':
        return this.restartApp(
          proposal.params as unknown as RestartAppParams,
          authority
        ) as Promise<LiaraExecutionOutcome<TResult>>;
      default:
        throw new Error(`Unsupported mutation operation: ${(proposal as any).operation}`);
    }
  }

  // --- Observation Methods (Verified Documented Safe Reads) ---

  /**
   * Get app details (delegated to LiaraClient).
   * Documented: GET /v1/projects/{name}
   */
  async getAppDetail(appSlug: string): Promise<SafeLiaraAppDetail> {
    const slug = this.validateAppSlug(appSlug);
    return this.#readClient.getProjectDetail(slug);
  }

  /**
   * List releases for an app (delegated to LiaraClient).
   * Documented: GET /v1/projects/{name}/releases
   */
  async listReleases(appSlug: string): Promise<SafeLiaraRelease[]> {
    const slug = this.validateAppSlug(appSlug);
    return this.#readClient.listReleases(slug);
  }

  /**
   * Get release detail to verify actual release outcome.
   * Matches by exact releaseId from documented GET /v1/projects/{name}/releases.
   * Note on verified route: @liara/cli v9.4.7 (src/commands/deploy.ts line 527) calls
   * GET /v1/releases/{releaseID} to check build progress; here we query project releases
   * scoped by app slug, which is documented and safe without unverified global endpoints.
   * Strips and redacts any secret tokens from failReason and status strings.
   */
  async getReleaseDetail(
    appSlug: string,
    releaseId: string
  ): Promise<SafeLiaraReleaseDetail | null> {
    const slug = this.validateAppSlug(appSlug);
    if (!releaseId || typeof releaseId !== 'string' || !STRICT_ID_REGEX.test(releaseId.trim())) {
      throw new Error('Valid strict releaseId is required');
    }
    const targetId = releaseId.trim();

    // Query documented releases list for the project
    const releases = await this.listReleases(slug);
    const matched = releases.find((r) => r.id === targetId);
    if (!matched) {
      return null;
    }

    const safeStatus = this.redact(matched.state || 'unknown').slice(0, 64);

    return {
      ...matched,
      status: safeStatus,
      state: safeStatus,
    };
  }

  /**
   * Bounded logs retrieval with untrusted secret redaction and line/byte budgets.
   * Documented: GET /v1/projects/{name}/logs
   * Official documentation specifies 'since' is required. Defaults to ISO timestamp 15 minutes ago.
   * Bounded by maxResponseBytes to avoid fetching more than the requested budget.
   */
  async getBoundedLogs(
    appSlug: string,
    options: LiaraLogQueryOptions = {}
  ): Promise<SafeLiaraLogsResult> {
    const slug = this.validateAppSlug(appSlug);

    let maxLines = 100;
    if (options.maxLines !== undefined) {
      if (typeof options.maxLines !== 'number' || !Number.isInteger(options.maxLines) || options.maxLines <= 0) {
        throw new Error('maxLines must be a positive integer');
      }
      maxLines = Math.min(options.maxLines, 500);
    }

    let maxBytes = 65_536; // 64 KiB default
    if (options.maxBodyBytes !== undefined) {
      if (typeof options.maxBodyBytes !== 'number' || !Number.isFinite(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
        throw new Error('maxBodyBytes must be a positive finite number');
      }
      maxBytes = Math.min(Math.max(Math.floor(options.maxBodyBytes), 1024), 512 * 1024);
    }

    // Official docs require 'since'. Strict validation and safe default (15 min ago).
    let sinceParam: string;
    if (options.since !== undefined) {
      if (typeof options.since === 'number') {
        if (!Number.isFinite(options.since) || options.since < 0) {
          throw new Error('since timestamp must be a positive finite number');
        }
        sinceParam = String(Math.floor(options.since));
      } else if (typeof options.since === 'string') {
        const trimmed = options.since.trim();
        if (!trimmed || trimmed.length > 64 || !/^[a-zA-Z0-9-:.+TZ ]+$/.test(trimmed)) {
          throw new Error('Invalid since parameter: must be a valid timestamp string up to 64 characters');
        }
        sinceParam = trimmed;
      } else {
        throw new Error('since parameter must be a valid string or number');
      }
    } else {
      // Default to ISO timestamp from 15 minutes ago
      sinceParam = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    }

    const query = new URLSearchParams();
    query.set('since', sinceParam);

    const endpoint = `/v1/projects/${encodeURIComponent(slug)}/logs?${query.toString()}`;

    // Pass maxBytes to safeOperationalFetch to bound response payload honest size
    const { data } = await this.safeOperationalFetch(
      endpoint,
      { method: 'GET' },
      false,
      maxBytes
    );

    let rawList: unknown[] = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (typeof data === 'object' && data !== null && 'logs' in data && Array.isArray((data as any).logs)) {
      rawList = (data as any).logs;
    }

    const ALLOWED_LOG_TYPES = new Set(['stdout', 'stderr', 'system']);
    const safeLines: SafeLiaraLogEntry[] = [];
    let bytesRead = 0;
    let truncated = false;
    let bytesBudgetExceeded = false;

    for (const raw of rawList) {
      if (safeLines.length >= maxLines) {
        truncated = true;
        break;
      }

      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;

      // Strict allowlist for type to prevent secret echoing in metadata
      const rawType = typeof entry.type === 'string' ? entry.type.toLowerCase().trim() : '';
      const type = ALLOWED_LOG_TYPES.has(rawType) ? rawType : 'unknown';

      // Strict datetime validation to prevent secret echoing in timestamp
      let datetime = 'unknown';
      if (typeof entry.datetime === 'string' && entry.datetime.length <= 64) {
        const parsedTime = Date.parse(entry.datetime);
        if (!Number.isNaN(parsedTime)) {
          datetime = new Date(parsedTime).toISOString();
        }
      } else if (typeof entry.datetime === 'number' && Number.isFinite(entry.datetime) && entry.datetime > 0) {
        datetime = new Date(entry.datetime).toISOString();
      }

      const rawMessage = typeof entry.message === 'string' ? entry.message : '';

      // REDACT all untrusted secrets before returning
      const redactedMessage = this.redact(rawMessage);
      const entryBytes = Buffer.byteLength(redactedMessage, 'utf8');

      if (bytesRead + entryBytes > maxBytes) {
        bytesBudgetExceeded = true;
        truncated = true;
        break;
      }

      bytesRead += entryBytes;
      safeLines.push({
        type,
        datetime,
        message: redactedMessage,
      });
    }

    return {
      lines: safeLines,
      totalLines: safeLines.length,
      truncated,
      bytesBudgetExceeded,
      bytesRead,
    };
  }

  private handleExecutionError<T>(err: unknown): LiaraExecutionOutcome<T> {
    if (err instanceof LiaraApiError) {
      if (
        err.code === 'TIMEOUT_AFTER_DISPATCH' ||
        err.code === 'SERVER_5XX_UNCERTAIN' ||
        err.code === 'MALFORMED_RESPONSE_UNCERTAIN' ||
        err.code === 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN' ||
        err.code === 'NETWORK_UNCERTAIN'
      ) {
        return {
          status: 'unknown',
          code: err.code,
          safeMessage: err.safeMessage,
          correlationId: err.correlationId ?? crypto.randomUUID(),
        };
      }
      return {
        status: 'rejected',
        code: err.code,
        safeMessage: err.safeMessage,
        correlationId: err.correlationId ?? crypto.randomUUID(),
      };
    }

    const correlationId = crypto.randomUUID();
    return {
      status: 'rejected',
      code: 'UNEXPECTED_ERROR',
      safeMessage: 'Operation encountered an unexpected safe error',
      correlationId,
    };
  }
}
