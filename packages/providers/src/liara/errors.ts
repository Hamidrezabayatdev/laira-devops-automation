/**
 * Liara Provider Errors
 * Guarantees no sensitive raw provider bodies, authorization tokens,
 * headers, or canary secrets are exposed in error messages or properties.
 */

export interface SafeLiaraErrorDetails {
  code: string;
  statusCode: number;
  safeMessage: string;
  correlationId?: string;
  retryable: boolean;
}

export class LiaraApiError extends Error implements SafeLiaraErrorDetails {
  readonly code: string;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly correlationId?: string;
  readonly retryable: boolean;

  constructor(details: SafeLiaraErrorDetails) {
    super(details.safeMessage);
    this.name = 'LiaraApiError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.safeMessage = details.safeMessage;
    this.correlationId = details.correlationId;
    this.retryable = details.retryable;
    Object.setPrototypeOf(this, LiaraApiError.prototype);
  }
}

export class CredentialedRedirectBlockedError extends Error {
  readonly code = 'CREDENTIALED_REDIRECT_BLOCKED';
  readonly safeMessage: string;

  constructor(targetUrl?: string) {
    let sanitizedTarget = 'destination';
    if (targetUrl) {
      try {
        const parsed = new URL(targetUrl);
        sanitizedTarget = `${parsed.protocol}//${parsed.host}`;
      } catch {
        // Redact any non-URL or invalid string
        sanitizedTarget = 'destination';
      }
    }
    const message = `Credentialed redirect to "${sanitizedTarget}" is blocked for security: all redirects are forbidden.`;
    super(message);
    this.name = 'CredentialedRedirectBlockedError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, CredentialedRedirectBlockedError.prototype);
  }
}

export class MutationBlockedInReadOnlyAdapterError extends Error {
  readonly code = 'MUTATION_BLOCKED_PHASE0_READ_ONLY';
  readonly safeMessage: string;

  constructor(operation: string) {
    const message = `Mutation operation "${operation}" is blocked: Phase 0 Liara adapter is strictly read-only and requires an approved ActionPlan in Phase 1.`;
    super(message);
    this.name = 'MutationBlockedInReadOnlyAdapterError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, MutationBlockedInReadOnlyAdapterError.prototype);
  }
}

export class LiaraOriginMismatchError extends Error {
  readonly code = 'ORIGIN_MISMATCH';
  readonly safeMessage: string;

  constructor(_attemptedUrl?: string) {
    const message = `Liara adapter only connects to fixed origin https://api.liara.ir. Attempted URL violates fixed origin constraint.`;
    super(message);
    this.name = 'LiaraOriginMismatchError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, LiaraOriginMismatchError.prototype);
  }
}
