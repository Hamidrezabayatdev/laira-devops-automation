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
  type SafeLiaraApp,
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

export const MAX_RUNTIME_ENVS_COUNT = 40;
export const MAX_RUNTIME_ENVS_BYTES = 32 * 1024; // 32 KiB limit
export const RUNTIME_ENV_KEY_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/;
export const RESERVED_RUNTIME_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

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
  readonly bundlePlanId?: string; // Optional bundle plan ID
  readonly networkId?: string; // Optional network ID (24-character hexadecimal)
}

export interface SafeLiaraNetwork {
  readonly id: string;
  readonly name: string;
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
  readonly runtimeEnvs?: readonly { readonly key: string; readonly value: string }[];
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
  readonly releaseId?: string;
  readonly lastLines?: boolean;
}

/**
 * Safe terminal reason codes.
 * Raw provider fail reasons are NEVER reflected because they could contain
 * internal stack traces, environment variables, or canary credentials.
 */
export const SAFE_TERMINAL_FAIL_REASONS = [
  'DISK_NOT_FOUND',
  'BUILD_FAILED',
  'HEALTH_CHECK_FAILED',
  'DEPLOYMENT_TIMEOUT',
  'DEPLOYMENT_CANCELED',
  'INVALID_PORT',
  'OUT_OF_MEMORY',
  'RELEASE_FAILED',
] as const;

export type SafeTerminalFailReason = (typeof SAFE_TERMINAL_FAIL_REASONS)[number];

export const ALLOWED_VALIDATION_FIELDS = [
  'network',
  'platform',
  'planID',
  'bundlePlanID',
  'name',
  'region',
] as const;

export type SafeValidationField = (typeof ALLOWED_VALIDATION_FIELDS)[number];

export const SAFE_VALIDATION_ERROR_CODES = [
  'APP_NAME_INVALID',
  'PLAN_UNAVAILABLE',
  'BUNDLE_UNAVAILABLE',
  'NETWORK_REQUIRED',
  'REGION_REQUIRED',
  'ACCOUNT_VERIFICATION_REQUIRED',
  'INSUFFICIENT_BALANCE',
] as const;

export type SafeValidationErrorCode = (typeof SAFE_VALIDATION_ERROR_CODES)[number];

export function sanitizeReleaseFailReason(rawReason: unknown): SafeTerminalFailReason {
  if (typeof rawReason !== 'string' || !rawReason.trim()) {
    return 'RELEASE_FAILED';
  }
  const trimmed = rawReason.trim().toLowerCase();
  if (trimmed.startsWith('disk_not_found') || trimmed.includes('disk')) {
    return 'DISK_NOT_FOUND';
  }
  if (trimmed.startsWith('build_failed') || trimmed.includes('build failed') || trimmed.includes('build error')) {
    return 'BUILD_FAILED';
  }
  if (trimmed.startsWith('health_check_failed') || trimmed.includes('unhealthy') || trimmed.includes('health')) {
    return 'HEALTH_CHECK_FAILED';
  }
  if (trimmed.startsWith('timeout') || trimmed.includes('timed out') || trimmed.includes('timeout')) {
    return 'DEPLOYMENT_TIMEOUT';
  }
  if (trimmed.startsWith('canceled') || trimmed.startsWith('cancelled') || trimmed.includes('cancel')) {
    return 'DEPLOYMENT_CANCELED';
  }
  if (trimmed.startsWith('port_not_found') || trimmed.includes('port')) {
    return 'INVALID_PORT';
  }
  if (trimmed.startsWith('out_of_memory') || trimmed.includes('oom') || trimmed.includes('memory')) {
    return 'OUT_OF_MEMORY';
  }
  return 'RELEASE_FAILED';
}

const ALLOWED_RELEASE_STATES = new Set([
  'PENDING',
  'INITIALIZING',
  'BUILDING',
  'PUSHING',
  'PUSHED',
  'DEPLOYING',
  'READY',
  'UNHEALTHY',
  'FAILED',
  'CANCELED',
  'TIMEDOUT',
  'STOPPED',
]);

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

  /**
   * Validates optional network ID (strictly 24-character hexadecimal MongoDB ObjectId).
   * Static error message never echoes raw inputs.
   */
  private validateNetworkId(networkId?: string): string | undefined {
    if (networkId === undefined) {
      return undefined;
    }
    if (typeof networkId !== 'string' || !networkId.trim()) {
      throw new Error('networkId must be a non-empty string when provided');
    }
    const trimmed = networkId.trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(trimmed)) {
      throw new Error('Invalid networkId: must be a 24-character hexadecimal string');
    }
    return trimmed;
  }

  /**
   * Validates runtime environment variables before release dispatch.
   * Enforces:
   * 1. Max 40 keys
   * 2. Key format: /^[A-Z][A-Z0-9_]{0,127}$/
   * 3. Total size <= 32 KiB
   * 4. No reserved keys: NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH
   * 5. No duplicate keys
   * 6. Strictly static error messages that never echo raw keys or sensitive values
   */
  private validateRuntimeEnvs(
    runtimeEnvs?: readonly { readonly key: string; readonly value: string }[]
  ): Record<string, string> | undefined {
    if (runtimeEnvs === undefined) {
      return undefined;
    }
    if (!Array.isArray(runtimeEnvs)) {
      throw new Error('runtimeEnvs must be an array of key-value pairs');
    }
    if (runtimeEnvs.length > MAX_RUNTIME_ENVS_COUNT) {
      throw new Error(`runtimeEnvs cannot exceed ${MAX_RUNTIME_ENVS_COUNT} variables`);
    }

    const seenKeys = new Set<string>();
    const envRecord: Record<string, string> = {};
    let totalBytes = 0;

    for (const item of runtimeEnvs) {
      if (!item || typeof item !== 'object') {
        throw new Error('Each environment variable must be an object with key and value strings');
      }
      const { key, value } = item;
      if (typeof key !== 'string' || !RUNTIME_ENV_KEY_REGEX.test(key)) {
        throw new Error('Invalid environment variable key: must match ^[A-Z][A-Z0-9_]{0,127}$');
      }
      if (typeof value !== 'string') {
        throw new Error('Invalid environment variable value: must be a string');
      }
      if (RESERVED_RUNTIME_ENV_KEYS.has(key)) {
        throw new Error('Reserved environment variable key is not allowed');
      }
      if (seenKeys.has(key)) {
        throw new Error('Duplicate environment variable key is not allowed');
      }
      seenKeys.add(key);

      const entryBytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
      totalBytes += entryBytes;
      if (totalBytes > MAX_RUNTIME_ENVS_BYTES) {
        throw new Error('runtimeEnvs total size exceeds 32 KiB limit');
      }

      envRecord[key] = value;
    }

    return envRecord;
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
   * Reads error response stream bounded by exact byte count (<= 16 KiB) under existing deadline.
   * Cancels reader immediately on abort, oversize, or failure without buffering full payload.
   */
  private async readBoundedErrorText(
    response: Response,
    signal: AbortSignal,
    maxBytes: number,
    correlationId: string,
    isMutation: boolean
  ): Promise<string> {
    if (!response.body) {
      if (signal.aborted) {
        throw new LiaraApiError({
          code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading error response body`,
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
            safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading error response body`,
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
                    safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading error response body`,
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
            safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading error response body`,
            correlationId,
            retryable: false,
          });
        }

        const { done, value } = readResult;
        if (done) break;

        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          const remaining = maxBytes - (bytesRead - value.byteLength);
          if (remaining > 0) {
            const allowedSlice = value.subarray(0, remaining);
            accumulated += decoder.decode(allowedSlice, { stream: false });
          }
          cancelBody();
          break;
        }

        accumulated += decoder.decode(value, { stream: true });
      }

      if (signal.aborted) {
        cancelBody();
        throw new LiaraApiError({
          code: isMutation ? 'TIMEOUT_AFTER_DISPATCH' : 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.#timeoutMs}ms while reading error response body`,
          correlationId,
          retryable: false,
        });
      }

      return accumulated;
    } catch (err) {
      cancelBody();
      if (err instanceof LiaraApiError) {
        throw err;
      }
      return '';
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Allowlist-classifies known validation reasons and field names ONLY.
   * Guarantees:
   * 1. No raw provider messages, bodies, or canary credentials are ever reflected or logged.
   * 2. Allowed fields: 'network', 'platform', 'planID', 'bundlePlanID', 'name', 'region'.
   * 3. Safe codes: 'APP_NAME_INVALID', 'PLAN_UNAVAILABLE', 'BUNDLE_UNAVAILABLE',
   *    'NETWORK_REQUIRED', 'REGION_REQUIRED', 'ACCOUNT_VERIFICATION_REQUIRED', 'INSUFFICIENT_BALANCE'.
   * 4. Static safe messages matching known fields: "Liara API error: HTTP <status> validation rejected fields: <fields>"
   * 5. If no reliable match, returns null so HTTP_<status> remains unchanged.
   */
  private classifyValidationError(
    errorText: string,
    statusCode: number
  ): { code: string; safeMessage: string } | null {
    if (!errorText || !errorText.trim()) {
      if (statusCode === 402) {
        return {
          code: 'INSUFFICIENT_BALANCE',
          safeMessage: 'Liara API error: HTTP 402 (INSUFFICIENT_BALANCE)',
        };
      }
      return null;
    }

    const detectedFields = new Set<SafeValidationField>();
    let reliableCode: SafeValidationErrorCode | undefined;

    if (statusCode === 402) {
      reliableCode = 'INSUFFICIENT_BALANCE';
    }

    // Try parsing as JSON to inspect structured error fields safely
    let parsedJson: any = null;
    try {
      parsedJson = JSON.parse(errorText);
    } catch {
      // plain text fallback
    }

    const inspectFieldKey = (rawKey: unknown) => {
      if (typeof rawKey !== 'string') return;
      const k = rawKey.toLowerCase().replace(/[-_]/g, '');
      if (k === 'network' || k === 'networkid') detectedFields.add('network');
      else if (k === 'platform' || k === 'type') detectedFields.add('platform');
      else if (k === 'plan' || k === 'planid') detectedFields.add('planID');
      else if (k === 'bundleplan' || k === 'bundleplanid' || k === 'featureplan') detectedFields.add('bundlePlanID');
      else if (k === 'name' || k === 'app' || k === 'project' || k === 'appname' || k === 'projectname' || k === 'slug') detectedFields.add('name');
      else if (k === 'region' || k === 'zone') detectedFields.add('region');
    };

    if (parsedJson && typeof parsedJson === 'object') {
      if (parsedJson.errors && typeof parsedJson.errors === 'object') {
        if (Array.isArray(parsedJson.errors)) {
          for (const item of parsedJson.errors) {
            if (typeof item === 'string') inspectFieldKey(item);
            else if (typeof item === 'object' && item !== null && 'field' in item) inspectFieldKey(item.field);
          }
        } else {
          for (const key of Object.keys(parsedJson.errors)) {
            inspectFieldKey(key);
          }
        }
      }

      if (Array.isArray(parsedJson.fields)) {
        for (const item of parsedJson.fields) {
          inspectFieldKey(item);
        }
      }

      if (parsedJson.details && typeof parsedJson.details === 'object' && !Array.isArray(parsedJson.details)) {
        for (const key of Object.keys(parsedJson.details)) {
          inspectFieldKey(key);
        }
      }

      const rawCode = typeof parsedJson.code === 'string'
        ? parsedJson.code
        : typeof parsedJson.data?.code === 'string'
          ? parsedJson.data.code
          : undefined;

      if (rawCode) {
        const lowerCode = rawCode.toLowerCase();
        if (lowerCode.includes('network')) {
          reliableCode = 'NETWORK_REQUIRED';
          detectedFields.add('network');
        } else if (lowerCode.includes('bundle')) {
          reliableCode = 'BUNDLE_UNAVAILABLE';
          detectedFields.add('bundlePlanID');
        } else if (lowerCode.includes('free_plan') || lowerCode.includes('plan')) {
          reliableCode = 'PLAN_UNAVAILABLE';
          detectedFields.add('planID');
        } else if (lowerCode.includes('name') || lowerCode.includes('project') || lowerCode.includes('app')) {
          reliableCode = 'APP_NAME_INVALID';
          detectedFields.add('name');
        } else if (lowerCode.includes('region')) {
          reliableCode = 'REGION_REQUIRED';
          detectedFields.add('region');
        } else if (lowerCode.includes('verification') || lowerCode.includes('verify')) {
          reliableCode = 'ACCOUNT_VERIFICATION_REQUIRED';
        } else if (lowerCode.includes('balance') || lowerCode.includes('credit')) {
          reliableCode = 'INSUFFICIENT_BALANCE';
        }
      }
    }

    const lowerText = errorText.toLowerCase();

    // Field-specific detection in text
    if (/\bnetwork\b/.test(lowerText)) {
      detectedFields.add('network');
    }
    if (/\b(platform)\b/.test(lowerText)) {
      detectedFields.add('platform');
    }
    if (/\b(plan|planid)\b/.test(lowerText) && !/bundle/i.test(lowerText)) {
      detectedFields.add('planID');
    }
    if (/\b(bundle|bundleplan|bundleplanid|feature[- ]plan)\b/.test(lowerText)) {
      detectedFields.add('bundlePlanID');
    }
    if (/\b(app[- ]name|project[- ]name|app\s+name|project\s+name)\b/.test(lowerText)) {
      detectedFields.add('name');
    }
    if (/\b(region|zone)\b/.test(lowerText)) {
      detectedFields.add('region');
    }

    // Code-specific classification in text
    if (!reliableCode) {
      if (
        /network.*required|required.*network|select.*network|network.*missing|missing.*network|create network|network.*not found/i.test(
          lowerText
        )
      ) {
        reliableCode = 'NETWORK_REQUIRED';
        detectedFields.add('network');
      } else if (
        /bundle.*not available|bundle.*unavailable|bundleplan.*not available|invalid.*bundle/i.test(lowerText)
      ) {
        reliableCode = 'BUNDLE_UNAVAILABLE';
        detectedFields.add('bundlePlanID');
      } else if (
        /plan.*not available|plan.*unavailable|invalid.*plan|plan.*not found|free_plan/i.test(lowerText)
      ) {
        reliableCode = 'PLAN_UNAVAILABLE';
        detectedFields.add('planID');
      } else if (
        /name.*invalid|invalid.*name|already exists|unique name|enter a valid name/i.test(lowerText)
      ) {
        reliableCode = 'APP_NAME_INVALID';
        detectedFields.add('name');
      } else if (
        /region.*required|required.*region|region.*missing|invalid.*region/i.test(lowerText)
      ) {
        reliableCode = 'REGION_REQUIRED';
        detectedFields.add('region');
      } else if (
        /verification.*required|verify.*account|identity.*verification|account.*not verified/i.test(lowerText)
      ) {
        reliableCode = 'ACCOUNT_VERIFICATION_REQUIRED';
      } else if (
        /not enough balance|insufficient.*balance|charge your account|not enough credit/i.test(lowerText)
      ) {
        reliableCode = 'INSUFFICIENT_BALANCE';
      } else if (detectedFields.has('network')) {
        reliableCode = 'NETWORK_REQUIRED';
      }
    }

    if (reliableCode === 'BUNDLE_UNAVAILABLE') {
      detectedFields.delete('planID');
      detectedFields.add('bundlePlanID');
    } else if (reliableCode === 'PLAN_UNAVAILABLE') {
      detectedFields.delete('bundlePlanID');
      detectedFields.add('planID');
    } else if (reliableCode === 'NETWORK_REQUIRED') {
      detectedFields.add('network');
    } else if (reliableCode === 'APP_NAME_INVALID') {
      detectedFields.add('name');
    } else if (reliableCode === 'REGION_REQUIRED') {
      detectedFields.add('region');
    }

    if (!reliableCode && detectedFields.size === 0) {
      return null;
    }

    const code = reliableCode ?? `HTTP_${statusCode}`;
    const orderedFields = ALLOWED_VALIDATION_FIELDS.filter((f) => detectedFields.has(f));

    let safeMessage: string;
    if (orderedFields.length > 0) {
      safeMessage = `Liara API error: HTTP ${statusCode} validation rejected fields: ${orderedFields.join(', ')}`;
    } else {
      safeMessage = `Liara API error: HTTP ${statusCode} (${code})`;
    }

    return { code, safeMessage };
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
        let code = `HTTP_${response.status}`;
        let safeMessage = `Liara API error: HTTP ${response.status}`;

        if (response.status === 400 || response.status === 422 || response.status === 402) {
          try {
            const errorText = await this.readBoundedErrorText(
              response,
              controller.signal,
              16 * 1024,
              correlationId,
              isMutation
            );
            const classified = this.classifyValidationError(errorText, response.status);
            if (classified) {
              code = classified.code;
              safeMessage = classified.safeMessage;
            }
          } catch (err) {
            if (err instanceof LiaraApiError) {
              throw err;
            }
            // ignore non-timeout read errors and preserve default HTTP_<status>
          }
        } else {
          try {
            response.body?.cancel().catch(() => {});
          } catch {
            // ignore
          }
        }

        controller.abort();
        throw new LiaraApiError({
          code,
          statusCode: response.status,
          safeMessage,
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
    let cleanBundlePlan: string | undefined;
    if (params.bundlePlanId !== undefined) {
      if (typeof params.bundlePlanId !== 'string' || !params.bundlePlanId.trim()) {
        throw new Error('bundlePlanId must be a non-empty string when provided');
      }
      const trimmedBundle = params.bundlePlanId.trim();
      if (trimmedBundle.length > 64 || !/^[a-z0-9_-]+$/i.test(trimmedBundle)) {
        throw new Error('Invalid bundlePlanId: must be 1-64 alphanumeric characters, hyphens, or underscores');
      }
      cleanBundlePlan = trimmedBundle;
    }
    const cleanNetworkId = this.validateNetworkId(params.networkId);

    const summaryParts = [
      `platform: ${params.platform}`,
      `plan: ${cleanPlan}`,
    ];
    if (cleanBundlePlan) {
      summaryParts.push(`bundle: ${cleanBundlePlan}`);
    }
    if (cleanNetworkId) {
      summaryParts.push(`network: ${cleanNetworkId}`);
    }

    return {
      id: crypto.randomUUID(),
      operation: 'create_app',
      appSlug: slug,
      summary: `Create new Liara app "${slug}" (${summaryParts.join(', ')})`,
      params: {
        appSlug: slug,
        platform: params.platform,
        planId: cleanPlan,
        ...(cleanBundlePlan ? { bundlePlanId: cleanBundlePlan } : {}),
        ...(cleanNetworkId ? { networkId: cleanNetworkId } : {}),
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
    if (params.runtimeEnvs && params.runtimeEnvs.length > 0) {
      throw new Error('runtime environments require credential references at broker');
    }
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
  ): Promise<LiaraExecutionOutcome<{ appSlug: string; planId: string; bundlePlanId?: string; networkId?: string }>> {
    this.verifyAuthority('create_app', authority);
    const slug = this.validateAppSlug(params.appSlug);

    if (!params.planId || typeof params.planId !== 'string' || !params.planId.trim()) {
      throw new Error('Explicit planId is required for app creation');
    }
    const planID = params.planId.trim();

    let bundlePlanID: string | undefined;
    if (params.bundlePlanId !== undefined) {
      if (typeof params.bundlePlanId !== 'string' || !params.bundlePlanId.trim()) {
        throw new Error('bundlePlanId must be a non-empty string when provided');
      }
      const trimmedBundle = params.bundlePlanId.trim();
      if (trimmedBundle.length > 64 || !/^[a-z0-9_-]+$/i.test(trimmedBundle)) {
        throw new Error('Invalid bundlePlanId: must be 1-64 alphanumeric characters, hyphens, or underscores');
      }
      bundlePlanID = trimmedBundle;
    }

    const cleanNetworkId = this.validateNetworkId(params.networkId);

    try {
      const payload: Record<string, unknown> = {
        name: slug,
        planID,
        platform: params.platform,
      };
      if (bundlePlanID) {
        payload.bundlePlanID = bundlePlanID;
      }
      if (cleanNetworkId) {
        payload.network = cleanNetworkId;
      }

      const { correlationId } = await this.safeOperationalFetch(
        '/v1/projects',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        true
      );

      return {
        status: 'accepted',
        data: {
          appSlug: slug,
          planId: planID,
          ...(bundlePlanID ? { bundlePlanId: bundlePlanID } : {}),
          ...(cleanNetworkId ? { networkId: cleanNetworkId } : {}),
        },
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

    // Validate runtimeEnvs before any dispatch
    const envsRecord = this.validateRuntimeEnvs(params.runtimeEnvs);

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
      if (envsRecord) {
        bodyPayload.envs = envsRecord;
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
   * List all projects/apps (delegated to LiaraClient).
   * Documented: GET /v1/projects
   */
  async listApps(): Promise<SafeLiaraApp[]> {
    return this.#readClient.listProjects();
  }

  /**
   * List networks for account / team.
   * Verified CLI route: GET /v1/networks
   * Returns safe allowlisted network descriptors { id, name }.
   * Strictly validates 24-character hex ID and bounded name.
   */
  async listNetworks(): Promise<SafeLiaraNetwork[]> {
    const { data } = await this.safeOperationalFetch(
      '/v1/networks',
      { method: 'GET' },
      false
    );

    let rawList: unknown[] = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (
      typeof data === 'object' &&
      data !== null &&
      'networks' in data &&
      Array.isArray((data as Record<string, unknown>).networks)
    ) {
      rawList = (data as Record<string, unknown>).networks as unknown[];
    }

    const safeNetworks: SafeLiaraNetwork[] = [];
    for (const item of rawList) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const rawId = rec._id ?? rec.id;
      const rawName = rec.name;

      if (typeof rawId === 'string' && /^[a-f0-9]{24}$/i.test(rawId.trim())) {
        const cleanId = rawId.trim().toLowerCase();
        const cleanName =
          typeof rawName === 'string' && rawName.trim()
            ? rawName.trim().slice(0, 64)
            : cleanId;
        safeNetworks.push({
          id: cleanId,
          name: cleanName,
        });
      }
    }

    return safeNetworks;
  }

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
   * Calls verified global route GET /v1/releases/{releaseId} with strict ID validation.
   * Verifies project slug matches if present in provider payload.
   * Strictly allowlists state and sanitizes failReason to safe static terminal codes,
   * guaranteeing that raw provider error bodies/fail reasons NEVER leak secrets.
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

    let resData: unknown;
    try {
      const res = await this.safeOperationalFetch(
        `/v1/releases/${encodeURIComponent(targetId)}`,
        { method: 'GET' },
        false
      );
      resData = res.data;
    } catch (err) {
      if (err instanceof LiaraApiError && (err.statusCode === 404 || err.code === 'HTTP_404')) {
        return null;
      }
      throw err;
    }

    const rawRelease = (typeof resData === 'object' && resData !== null && 'release' in resData)
      ? (resData as Record<string, unknown>).release
      : resData;

    if (typeof rawRelease !== 'object' || rawRelease === null || Array.isArray(rawRelease)) {
      return null;
    }

    const release = rawRelease as Record<string, unknown>;

    // Verify project slug if present in release payload
    const rawProject = release.project_id ?? release.projectId ?? release.project ?? release.name;
    if (typeof rawProject === 'string' && rawProject.trim()) {
      if (rawProject.trim().toLowerCase() !== slug) {
        return null; // Mismatch: release belongs to a different project
      }
    }

    const rawState = typeof release.state === 'string'
      ? release.state
      : typeof release.status === 'string'
        ? release.status
        : '';
    const upperState = rawState.trim().toUpperCase();
    const safeState = ALLOWED_RELEASE_STATES.has(upperState) ? upperState : 'UNKNOWN';

    // Map failReason safely: NEVER reflect raw provider failReason as it could contain secrets
    let safeFailReason: string | undefined;
    if (typeof release.failReason === 'string' && release.failReason.trim()) {
      safeFailReason = sanitizeReleaseFailReason(release.failReason);
    } else if (safeState === 'FAILED') {
      safeFailReason = 'RELEASE_FAILED';
    } else if (safeState === 'TIMEDOUT') {
      safeFailReason = 'DEPLOYMENT_TIMEOUT';
    }

    let port: number | undefined;
    if (typeof release.port === 'number' && Number.isInteger(release.port) && release.port > 0 && release.port <= 65535) {
      port = release.port;
    }

    const tag = typeof release.tag === 'string' ? release.tag.slice(0, 64) : undefined;
    const createdAt = typeof release.created_at === 'string'
      ? release.created_at.slice(0, 64)
      : typeof release.createdAt === 'string'
        ? release.createdAt.slice(0, 64)
        : new Date().toISOString();

    return {
      id: targetId,
      projectId: slug,
      state: safeState,
      status: safeState,
      tag,
      createdAt,
      port,
      failReason: safeFailReason,
    };
  }

  /**
   * Bounded logs retrieval with untrusted secret redaction and line/byte budgets.
   * Uses verified CLI v2 endpoint: GET /v2/projects/{slug}/logs
   * Search parameters:
   *   - start: unix timestamp in seconds
   *   - direction: 'forward'
   *   - last_lines: 'false' | 'true'
   *   - releaseId (optional)
   * Response format: { data: [ { metaData: { releaseId }, values: [ [ timestamp, jsonstring ] ] } ] }
   * Safely parses bounded _entry and type, redacting all secrets and enforcing budgets.
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

    let startUnix: number;
    if (options.since !== undefined) {
      if (typeof options.since === 'number') {
        if (!Number.isFinite(options.since) || options.since < 0) {
          throw new Error('since timestamp must be a positive finite number');
        }
        startUnix = options.since > 1e11 ? Math.floor(options.since / 1000) : Math.floor(options.since);
      } else if (typeof options.since === 'string') {
        const trimmed = options.since.trim();
        if (!trimmed || trimmed.length > 64) {
          throw new Error('Invalid since parameter: must be a valid timestamp string up to 64 characters');
        }
        if (/^\d+$/.test(trimmed)) {
          const parsedNum = Number.parseInt(trimmed, 10);
          startUnix = parsedNum > 1e11 ? Math.floor(parsedNum / 1000) : parsedNum;
        } else {
          const parsedTime = Date.parse(trimmed);
          if (Number.isNaN(parsedTime)) {
            throw new Error('Invalid since parameter: must be a valid timestamp string up to 64 characters');
          }
          startUnix = Math.floor(parsedTime / 1000);
        }
      } else {
        throw new Error('since parameter must be a valid string or number');
      }
    } else {
      // Default to 15 minutes ago in Unix seconds
      startUnix = Math.floor((Date.now() - 15 * 60 * 1000) / 1000);
    }

    const query = new URLSearchParams();
    query.set('start', String(startUnix));
    query.set('direction', 'forward');
    query.set('last_lines', options.lastLines ? 'true' : 'false');

    if (options.releaseId && typeof options.releaseId === 'string' && options.releaseId.trim()) {
      if (!STRICT_ID_REGEX.test(options.releaseId.trim())) {
        throw new Error('Valid strict releaseId is required');
      }
      query.set('releaseId', options.releaseId.trim());
    }

    const endpoint = `/v2/projects/${encodeURIComponent(slug)}/logs?${query.toString()}`;

    // Pass maxBytes to safeOperationalFetch to bound response payload honest size
    const { data } = await this.safeOperationalFetch(
      endpoint,
      { method: 'GET' },
      false,
      maxBytes
    );

    const ALLOWED_LOG_TYPES = new Set(['stdout', 'stderr', 'system']);
    const safeLines: SafeLiaraLogEntry[] = [];
    let bytesRead = 0;
    let truncated = false;
    let bytesBudgetExceeded = false;

    // Check if wire response matches CLI v2 format: { data: [ { metaData, values: [ [ ts, val ] ] } ] }
    if (typeof data === 'object' && data !== null && 'data' in data && Array.isArray((data as any).data)) {
      const entries = (data as any).data as unknown[];
      const allTuples: Array<[rawTs: unknown, rawVal: unknown]> = [];

      for (const entry of entries) {
        if (typeof entry === 'object' && entry !== null && 'values' in entry && Array.isArray((entry as any).values)) {
          for (const tuple of (entry as any).values) {
            if (Array.isArray(tuple) && tuple.length >= 2) {
              allTuples.push([tuple[0], tuple[1]]);
            }
          }
        }
      }

      // Sort all tuples by timestamp ascending
      allTuples.sort((a, b) => {
        try {
          const tA = BigInt(String(a[0]).replace(/\D/g, '') || '0');
          const tB = BigInt(String(b[0]).replace(/\D/g, '') || '0');
          return tA < tB ? -1 : tA > tB ? 1 : 0;
        } catch {
          return 0;
        }
      });

      for (const [rawTs, rawVal] of allTuples) {
        if (safeLines.length >= maxLines) {
          truncated = true;
          break;
        }

        // Parse datetime safely
        let datetime = 'unknown';
        if (typeof rawTs === 'string' && rawTs.length <= 64) {
          if (/^\d+$/.test(rawTs)) {
            const sec = Number.parseInt(rawTs.slice(0, 10), 10);
            if (!Number.isNaN(sec) && sec > 0) {
              datetime = new Date(sec * 1000).toISOString();
            }
          } else {
            const parsed = Date.parse(rawTs);
            if (!Number.isNaN(parsed)) {
              datetime = new Date(parsed).toISOString();
            }
          }
        } else if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) {
          const sec = rawTs > 1e11 ? Math.floor(rawTs / 1000) : Math.floor(rawTs);
          datetime = new Date(sec * 1000).toISOString();
        }

        // Parse log message and type
        let rawMessage = '';
        let rawType = 'stdout';

        if (typeof rawVal === 'string') {
          try {
            const parsedObj = JSON.parse(rawVal);
            if (typeof parsedObj === 'object' && parsedObj !== null) {
              rawMessage = typeof parsedObj._entry === 'string'
                ? parsedObj._entry
                : typeof parsedObj.message === 'string'
                  ? parsedObj.message
                  : '';
              rawType = typeof parsedObj.type === 'string' ? parsedObj.type : 'stdout';
            } else {
              rawMessage = rawVal;
            }
          } catch {
            rawMessage = rawVal;
          }
        } else if (typeof rawVal === 'object' && rawVal !== null) {
          rawMessage = typeof (rawVal as any)._entry === 'string'
            ? (rawVal as any)._entry
            : typeof (rawVal as any).message === 'string'
              ? (rawVal as any).message
              : '';
          rawType = typeof (rawVal as any).type === 'string' ? (rawVal as any).type : 'stdout';
        } else if (rawVal !== undefined && rawVal !== null) {
          rawMessage = String(rawVal);
        }

        const safeType = ALLOWED_LOG_TYPES.has(rawType.toLowerCase().trim())
          ? rawType.toLowerCase().trim()
          : 'unknown';

        const boundedRaw = rawMessage.slice(0, 32768);
        const redactedMessage = this.redact(boundedRaw);
        const entryBytes = Buffer.byteLength(redactedMessage, 'utf8');

        if (bytesRead + entryBytes > maxBytes) {
          bytesBudgetExceeded = true;
          truncated = true;
          break;
        }

        bytesRead += entryBytes;
        safeLines.push({
          type: safeType,
          datetime,
          message: redactedMessage,
        });
      }
    } else {
      // Graceful fallback for legacy/docs array or { logs: [...] } format
      let rawList: unknown[] = [];
      if (Array.isArray(data)) {
        rawList = data;
      } else if (typeof data === 'object' && data !== null && 'logs' in data && Array.isArray((data as any).logs)) {
        rawList = (data as any).logs;
      }

      for (const raw of rawList) {
        if (safeLines.length >= maxLines) {
          truncated = true;
          break;
        }

        if (typeof raw !== 'object' || raw === null) continue;
        const entry = raw as Record<string, unknown>;

        const rawType = typeof entry.type === 'string' ? entry.type.toLowerCase().trim() : '';
        const type = ALLOWED_LOG_TYPES.has(rawType) ? rawType : 'unknown';

        let datetime = 'unknown';
        if (typeof entry.datetime === 'string' && entry.datetime.length <= 64) {
          const parsedTime = Date.parse(entry.datetime);
          if (!Number.isNaN(parsedTime)) {
            datetime = new Date(parsedTime).toISOString();
          }
        } else if (typeof entry.datetime === 'number' && Number.isFinite(entry.datetime) && entry.datetime > 0) {
          datetime = new Date(entry.datetime).toISOString();
        }

        const rawMessage = typeof entry._entry === 'string'
          ? entry._entry
          : typeof entry.message === 'string'
            ? entry.message
            : '';

        const boundedRaw = rawMessage.slice(0, 32768);
        const redactedMessage = this.redact(boundedRaw);
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
