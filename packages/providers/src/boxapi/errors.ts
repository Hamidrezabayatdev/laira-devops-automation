/**
 * BoxAPI Provider Safe Errors
 * Ensures provider raw response bodies, bearer tokens, or canaries
 * are strictly sanitized and never exposed in error messages.
 */

export interface SafeBoxApiErrorDetails {
  code: string;
  statusCode: number;
  safeMessage: string;
  retryable: boolean;
  correlationId?: string;
}

export class BoxApiError extends Error implements SafeBoxApiErrorDetails {
  readonly code: string;
  readonly statusCode: number;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly correlationId?: string;

  constructor(details: SafeBoxApiErrorDetails) {
    super(details.safeMessage);
    this.name = 'BoxApiError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.safeMessage = details.safeMessage;
    this.retryable = details.retryable;
    this.correlationId = details.correlationId;
    Object.setPrototypeOf(this, BoxApiError.prototype);
  }
}

/**
 * Thrown on 401/403. Disables live AI and provides explicit access instructions.
 * Automatic fallback to other models (e.g. GPT-4, GPT-6 Luna) is strictly forbidden.
 */
export class AuthDeniedDisableError extends BoxApiError {
  constructor(statusCode: number = 401) {
    const safeMessage =
      `Access denied by BoxAPI (${statusCode}). Live AI is disabled. ` +
      `Prerequisite: Ensure a valid BoxAPI key with access to the designated model is configured. ` +
      `Automatic fallback is disabled by policy.`;
    super({
      code: 'AUTH_DENIED_LIVE_AI_DISABLED',
      statusCode,
      safeMessage,
      retryable: false,
    });
    this.name = 'AuthDeniedDisableError';
    Object.setPrototypeOf(this, AuthDeniedDisableError.prototype);
  }
}

/**
 * Thrown on 429 when rate limit is hit.
 * Counts against the run's bounded call allowance.
 */
export class RateLimitExceededError extends BoxApiError {
  constructor(retryAfterSeconds?: number) {
    const msg = retryAfterSeconds
      ? `BoxAPI rate limit exceeded (429). Retry after ${retryAfterSeconds}s. Call counted against run budget.`
      : `BoxAPI rate limit exceeded (429). Call counted against run budget.`;
    super({
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      safeMessage: msg,
      retryable: true,
    });
    this.name = 'RateLimitExceededError';
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }
}

/**
 * Thrown when run exceeds the maximum allowed model dispatches (4 per run).
 */
export class RunBudgetExceededError extends Error {
  readonly code = 'RUN_BUDGET_EXCEEDED';
  readonly safeMessage: string;

  constructor(runId: string, callCount: number, maxCalls: number = 4) {
    const message = `Run "${runId}" exceeded maximum model call budget (${callCount}/${maxCalls} dispatches). Halting further model calls.`;
    super(message);
    this.name = 'RunBudgetExceededError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, RunBudgetExceededError.prototype);
  }
}

/**
 * Thrown when workspace exceeds concurrency limit of 1 active call.
 */
export class WorkspaceConcurrencyLimitExceededError extends Error {
  readonly code = 'WORKSPACE_CONCURRENCY_LIMIT_EXCEEDED';
  readonly safeMessage: string;

  constructor(workspaceId: string) {
    const message = `Workspace "${workspaceId}" already has an active model call in flight (limit is 1 concurrent model call).`;
    super(message);
    this.name = 'WorkspaceConcurrencyLimitExceededError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, WorkspaceConcurrencyLimitExceededError.prototype);
  }
}

/**
 * Thrown when workspace AI is stopped via the stop switch.
 */
export class AiStoppedError extends Error {
  readonly code = 'AI_STOPPED';
  readonly safeMessage: string;

  constructor(workspaceId: string) {
    const message = `AI dispatch is stopped for workspace "${workspaceId}". New model calls are blocked.`;
    super(message);
    this.name = 'AiStoppedError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, AiStoppedError.prototype);
  }
}

/**
 * Thrown when non-demo owner tries to use operator demo key.
 */
export class DemoOperatorKeyDeniedError extends Error {
  readonly code = 'DEMO_OPERATOR_KEY_DENIED';
  readonly safeMessage: string;

  constructor(ownerId: string) {
    const message = `Operator demo key is restricted exclusively to configured demo owner identity. Owner "${ownerId}" cannot use operator demo key.`;
    super(message);
    this.name = 'DemoOperatorKeyDeniedError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, DemoOperatorKeyDeniedError.prototype);
  }
}

/**
 * Thrown when tool call arguments from model are malformed or fail schema validation.
 */
export class MalformedToolCallError extends Error {
  readonly code = 'MALFORMED_TOOL_CALL';
  readonly toolName: string;
  readonly safeMessage: string;
  readonly errors: string[];

  constructor(toolName: string, validationErrors: string[]) {
    const message = `Tool call arguments for "${toolName}" failed strict validation: ${validationErrors.join('; ')}`;
    super(message);
    this.name = 'MalformedToolCallError';
    this.toolName = toolName;
    this.safeMessage = message;
    this.errors = validationErrors;
    Object.setPrototypeOf(this, MalformedToolCallError.prototype);
  }
}

export class BoxApiOriginMismatchError extends Error {
  readonly code = 'ORIGIN_MISMATCH';
  readonly safeMessage: string;

  constructor(url: string) {
    const message = `BoxAPI adapter only connects to fixed origin https://ai.boxapi.ir/ai/v1. URL "${url}" violates origin constraint.`;
    super(message);
    this.name = 'BoxApiOriginMismatchError';
    this.safeMessage = message;
    Object.setPrototypeOf(this, BoxApiOriginMismatchError.prototype);
  }
}

export class BoxApiRedirectError extends BoxApiError {
  constructor(_targetUrl?: string) {
    super({
      code: 'BOXAPI_REDIRECT_BLOCKED',
      statusCode: 302,
      safeMessage: 'BoxAPI request returned an unexpected redirect. Redirects are blocked for credential safety.',
      retryable: false,
    });
    this.name = 'BoxApiRedirectError';
    Object.setPrototypeOf(this, BoxApiRedirectError.prototype);
  }
}

export class ResponseSizeExceededError extends BoxApiError {
  readonly limitBytes: number;

  constructor(maxBytes: number) {
    super({
      code: 'RESPONSE_SIZE_EXCEEDED',
      statusCode: 200,
      safeMessage: `BoxAPI response exceeded maximum byte limit of ${maxBytes} bytes.`,
      retryable: false,
    });
    this.name = 'ResponseSizeExceededError';
    this.limitBytes = maxBytes;
    Object.setPrototypeOf(this, ResponseSizeExceededError.prototype);
  }
}

export class InterruptedStreamError extends BoxApiError {
  constructor(reason: string = 'Stream terminated prematurely before completion [DONE]') {
    super({
      code: 'STREAM_INTERRUPTED',
      statusCode: 0,
      safeMessage: `BoxAPI streaming connection interrupted: ${reason}`,
      retryable: true,
    });
    this.name = 'InterruptedStreamError';
    Object.setPrototypeOf(this, InterruptedStreamError.prototype);
  }
}

export class MalformedPayloadError extends BoxApiError {
  constructor(details: string = 'Provider returned malformed non-JSON payload') {
    super({
      code: 'MALFORMED_PAYLOAD',
      statusCode: 200,
      safeMessage: `BoxAPI response parsing failed: ${details}`,
      retryable: false,
    });
    this.name = 'MalformedPayloadError';
    Object.setPrototypeOf(this, MalformedPayloadError.prototype);
  }
}
