import {
  LIARA_API_ORIGIN,
  type LiaraConnectionConfig,
  type SafeLiaraApp,
  type SafeLiaraAppDetail,
  type SafeLiaraRelease,
  type SafeLiaraCapability,
} from './types.ts';
import {
  LiaraApiError,
  CredentialedRedirectBlockedError,
  MutationBlockedInReadOnlyAdapterError,
  LiaraOriginMismatchError,
} from './errors.ts';
import { toSafeLiaraApp, toSafeLiaraAppDetail, toSafeLiaraRelease } from './dtos.ts';
import { getLiaraCapabilities } from './capabilities.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024; // 1 MiB

export class LiaraClient {
  // Use ECMAScript private field so API key is never enumerable on the object or exposed via JSON/inspect
  readonly #apiKey: string;
  readonly teamId?: string;
  readonly timeoutMs: number;
  readonly maxSizeBytes: number;
  readonly #fetchFn: typeof fetch;

  constructor(config: LiaraConnectionConfig) {
    if (!config.apiKey || typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
      throw new Error('LiaraConnectionConfig requires a valid non-empty apiKey');
    }

    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('timeoutMs must be a finite positive number');
    }

    const maxSize = config.maxResponseSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize) || maxSize <= 0) {
      throw new Error('maxResponseSizeBytes must be a finite positive number');
    }

    this.#apiKey = config.apiKey.trim();
    this.teamId = config.teamId?.trim() || undefined;
    this.timeoutMs = timeout;
    this.maxSizeBytes = maxSize;
    this.#fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Hide private fields from JSON serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      teamId: this.teamId,
      timeoutMs: this.timeoutMs,
      maxSizeBytes: this.maxSizeBytes,
    };
  }

  /**
   * Custom Node.js inspect formatter to prevent key leakage in console.log / util.inspect
   */
  [Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
    return {
      teamId: this.teamId,
      timeoutMs: this.timeoutMs,
      maxSizeBytes: this.maxSizeBytes,
    };
  }

  /**
   * Safe fetch with:
   * 1. Fixed origin enforcement (https://api.liara.ir)
   * 2. TeamID override on every request
   * 3. Blocking ALL credentialed redirects (no resend or recursion, cancel body + abort controller)
   * 4. Static safe errors with locally-generated correlation UUID (never reflects provider headers or bodies)
   * 5. Never reading raw error bodies (cancel body + abort controller immediately)
   * 6. Wholebody deadline with abort listener race for both header fetch and streaming body
   * 7. Safe malformed payload handling
   */
  private async safeFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const fullUrlString = endpoint.startsWith('http')
      ? endpoint
      : `${LIARA_API_ORIGIN}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const url = new URL(fullUrlString);
    if (url.origin !== LIARA_API_ORIGIN) {
      throw new LiaraOriginMismatchError(fullUrlString);
    }

    // Always enforce / override teamID query parameter on every request if configured
    if (this.teamId) {
      url.searchParams.set('teamID', this.teamId);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', `Bearer ${this.#apiKey}`);
      headers.set('Accept', 'application/json');

      if (controller.signal.aborted) {
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.timeoutMs}ms`,
          correlationId: crypto.randomUUID(),
          retryable: true,
        });
      }

      // Race the initial fetch against signal abort to protect against non-cooperative / hanging fetchFn
      let cleanupFetchListener: (() => void) | undefined;
      let response: Response;

      try {
        response = await Promise.race([
          this.#fetchFn(url.toString(), {
            ...options,
            headers,
            signal: controller.signal,
            redirect: 'manual', // Strictly intercept and block all redirects
          }),
          new Promise<never>((_, reject) => {
            const onAbort = () => {
              reject(
                new LiaraApiError({
                  code: 'REQUEST_TIMEOUT',
                  statusCode: 408,
                  safeMessage: `Liara API request timed out after ${this.timeoutMs}ms`,
                  correlationId: crypto.randomUUID(),
                  retryable: true,
                })
              );
            };
            if (controller.signal.aborted) {
              onAbort();
              return;
            }
            controller.signal.addEventListener('abort', onAbort, { once: true });
            cleanupFetchListener = () => controller.signal.removeEventListener('abort', onAbort);
          }),
        ]);
      } finally {
        cleanupFetchListener?.();
      }

      // Requirement 1: Block ALL credentialed redirects unconditionally (cancel body + abort controller, no recursion)
      if (response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        controller.abort();
        throw new CredentialedRedirectBlockedError();
      }

      // Requirement 2 & 3: Never read raw error bodies; cancel body, abort controller, use static safe error
      if (!response.ok) {
        try {
          response.body?.cancel().catch(() => {});
        } catch {
          // ignore
        }
        controller.abort();
        const localCorrelationId = crypto.randomUUID();
        throw new LiaraApiError({
          code: `HTTP_${response.status}`,
          statusCode: response.status,
          safeMessage: `Liara API error: HTTP ${response.status}`,
          correlationId: localCorrelationId,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      // Requirement 4: Bounded stream bytes + wholebody deadline with immediate abort listener race
      const responseText = await this.readBoundedStream(response, controller.signal);

      if (controller.signal.aborted) {
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
          correlationId: crypto.randomUUID(),
          retryable: true,
        });
      }

      if (!responseText.trim()) {
        return {};
      }

      // Requirement 5: Invalid JSON is caught safely without leaking raw payloads
      try {
        return JSON.parse(responseText);
      } catch {
        throw new LiaraApiError({
          code: 'MALFORMED_PAYLOAD',
          statusCode: 200,
          safeMessage: 'Liara API returned invalid JSON payload',
          correlationId: crypto.randomUUID(),
          retryable: false,
        });
      }
    } catch (err: unknown) {
      controller.abort();

      if (
        err instanceof LiaraApiError ||
        err instanceof CredentialedRedirectBlockedError ||
        err instanceof LiaraOriginMismatchError
      ) {
        throw err;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.timeoutMs}ms`,
          correlationId: crypto.randomUUID(),
          retryable: true,
        });
      }

      // Requirement 2: Static safe message on network error; NEVER reflect err.message or regex it
      throw new LiaraApiError({
        code: 'NETWORK_FAILURE',
        statusCode: 0,
        safeMessage: 'Liara API network error: unable to complete request',
        correlationId: crypto.randomUUID(),
        retryable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Reads response stream bounded by exact byte count (not UTF-16 character count)
   * while racing pending read against the wholebody deadline AbortSignal immediately.
   * Cancels underlying body stream on abort, oversize, or failure.
   */
  private async readBoundedStream(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) {
      if (signal.aborted) {
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
          correlationId: crypto.randomUUID(),
          retryable: true,
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
            code: 'REQUEST_TIMEOUT',
            statusCode: 408,
            safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
            correlationId: crypto.randomUUID(),
            retryable: true,
          });
        }

        let cleanupListener: (() => void) | undefined;
        let readResult: Awaited<ReturnType<typeof reader.read>>;

        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              const onAbort = () => {
                reject(
                  new LiaraApiError({
                    code: 'REQUEST_TIMEOUT',
                    statusCode: 408,
                    safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
                    correlationId: crypto.randomUUID(),
                    retryable: true,
                  })
                );
                cancelBody();
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
            code: 'REQUEST_TIMEOUT',
            statusCode: 408,
            safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
            correlationId: crypto.randomUUID(),
            retryable: true,
          });
        }

        const { done, value } = readResult;
        if (done) break;

        bytesRead += value.byteLength;
        if (bytesRead > this.maxSizeBytes) {
          cancelBody();
          throw new LiaraApiError({
            code: 'RESPONSE_SIZE_EXCEEDED',
            statusCode: 200,
            safeMessage: `Liara API response size exceeded ${this.maxSizeBytes} bytes limit`,
            correlationId: crypto.randomUUID(),
            retryable: false,
          });
        }

        accumulated += decoder.decode(value, { stream: true });
      }

      if (signal.aborted) {
        cancelBody();
        throw new LiaraApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `Liara API request timed out after ${this.timeoutMs}ms while reading response body`,
          correlationId: crypto.randomUUID(),
          retryable: true,
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
   * List projects (applications)
   * GET /v1/projects
   * Throws MALFORMED_PAYLOAD if payload structure is not an array or { projects: array }
   */
  async listProjects(): Promise<SafeLiaraApp[]> {
    const raw = await this.safeFetch('/v1/projects');

    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === 'object' && raw !== null && 'projects' in raw && Array.isArray((raw as any).projects)) {
      items = (raw as any).projects;
    } else {
      throw new LiaraApiError({
        code: 'MALFORMED_PAYLOAD',
        statusCode: 200,
        safeMessage: 'Liara API list projects returned unexpected payload structure',
        correlationId: crypto.randomUUID(),
        retryable: false,
      });
    }

    return items.map((item: unknown) => {
      try {
        return toSafeLiaraApp(item);
      } catch {
        throw new LiaraApiError({
          code: 'MALFORMED_PAYLOAD',
          statusCode: 200,
          safeMessage: 'Liara API returned invalid project item in list',
          correlationId: crypto.randomUUID(),
          retryable: false,
        });
      }
    });
  }

  /**
   * Get project details
   * GET /v1/projects/{projectId}
   * Preserves internal ID while routing by encoded project_id slug.
   * Strips all secret values and environment variables immediately.
   */
  async getProjectDetail(projectId: string): Promise<SafeLiaraAppDetail> {
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Valid projectId slug is required');
    }

    const raw = await this.safeFetch(`/v1/projects/${encodeURIComponent(projectId.trim())}`);
    const project = (typeof raw === 'object' && raw !== null && 'project' in raw)
      ? (raw as any).project
      : raw;

    if (typeof project !== 'object' || project === null || Array.isArray(project)) {
      throw new LiaraApiError({
        code: 'MALFORMED_PAYLOAD',
        statusCode: 200,
        safeMessage: 'Liara API project detail returned unexpected payload structure',
        correlationId: crypto.randomUUID(),
        retryable: false,
      });
    }

    try {
      return toSafeLiaraAppDetail(project);
    } catch {
      throw new LiaraApiError({
        code: 'MALFORMED_PAYLOAD',
        statusCode: 200,
        safeMessage: 'Liara API project detail failed safe validation',
        correlationId: crypto.randomUUID(),
        retryable: false,
      });
    }
  }

  /**
   * List releases for a project
   * GET /v1/projects/{projectId}/releases
   */
  async listReleases(projectId: string): Promise<SafeLiaraRelease[]> {
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Valid projectId slug is required');
    }

    const raw = await this.safeFetch(`/v1/projects/${encodeURIComponent(projectId.trim())}/releases`);

    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === 'object' && raw !== null && 'releases' in raw && Array.isArray((raw as any).releases)) {
      items = (raw as any).releases;
    } else {
      throw new LiaraApiError({
        code: 'MALFORMED_PAYLOAD',
        statusCode: 200,
        safeMessage: 'Liara API list releases returned unexpected payload structure',
        correlationId: crypto.randomUUID(),
        retryable: false,
      });
    }

    return items.map((item: unknown) => {
      try {
        return toSafeLiaraRelease(item);
      } catch {
        throw new LiaraApiError({
          code: 'MALFORMED_PAYLOAD',
          statusCode: 200,
          safeMessage: 'Liara API returned invalid release item in list',
          correlationId: crypto.randomUUID(),
          retryable: false,
        });
      }
    });
  }

  /**
   * Returns honest capability status for Phase 0
   */
  getCapabilities(): SafeLiaraCapability[] {
    return getLiaraCapabilities();
  }

  // --- Blocked Phase 0 Mutations ---

  async deploy(): Promise<never> {
    throw new MutationBlockedInReadOnlyAdapterError('deploy');
  }

  async restart(): Promise<never> {
    throw new MutationBlockedInReadOnlyAdapterError('restart');
  }

  async power(): Promise<never> {
    throw new MutationBlockedInReadOnlyAdapterError('power');
  }

  async resize(): Promise<never> {
    throw new MutationBlockedInReadOnlyAdapterError('resize');
  }
}
