import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'EXPIRED',
  'APPROVAL_DRIFT',
  'RATE_LIMITED',
  'UNCERTAIN_OUTCOME',
  'INTERNAL_ERROR',
  'PROVIDER_ERROR',
  'DECRYPTION_FAILED',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SafeFieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export type SafeFieldError = z.infer<typeof SafeFieldErrorSchema>;

export const SafeErrorDtoSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  correlationId: z.string(),
  retryable: z.boolean(),
  statusCode: z.number().int().min(400).max(599),
  fieldErrors: z.array(SafeFieldErrorSchema).optional(),
}).strict();

export type SafeErrorDto = z.infer<typeof SafeErrorDtoSchema>;

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  statusCode?: number;
  correlationId?: string;
  retryable?: boolean;
  fieldErrors?: SafeFieldError[];
  cause?: unknown;
}

const DEFAULT_STATUS_CODES: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  EXPIRED: 410,
  APPROVAL_DRIFT: 409,
  RATE_LIMITED: 429,
  UNCERTAIN_OUTCOME: 500,
  INTERNAL_ERROR: 500,
  PROVIDER_ERROR: 502,
  DECRYPTION_FAILED: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly statusCode: number;
  readonly fieldErrors?: SafeFieldError[];
  readonly isAppError = true;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.correlationId = options.correlationId ?? randomUUID();
    this.statusCode = options.statusCode ?? DEFAULT_STATUS_CODES[options.code] ?? 500;
    this.retryable = options.retryable ?? (this.statusCode >= 500 || this.statusCode === 429);
    this.fieldErrors = options.fieldErrors;
  }
}

/**
 * Standard sensitive patterns to scrub from all user-facing or logged messages.
 */
const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /(?:api[_-]?key|token|secret|password|passwd|auth)[=:]\s*['"]?(?!\[REDACTED_)[^\s,'";)]+['"]?/gi,
  /liara_[a-zA-Z0-9_-]+/gi,
  /sk-[a-zA-Z0-9_-]+/gi,
];

/**
 * Scrubs any sensitive secrets or canary tokens from error messages.
 */
export function sanitizeErrorMessage(
  message: string,
  extraCanaries: readonly string[] = []
): string {
  if (!message) return 'An unexpected error occurred';

  let sanitized = message;

  // Scrub registered canary values first
  for (const canary of extraCanaries) {
    if (canary && canary.length > 0) {
      sanitized = sanitized.replaceAll(canary, '[REDACTED_SECRET]');
    }
  }

  // Scrub regex sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_CREDENTIAL]');
  }

  return sanitized;
}

/**
 * Transforms an arbitrary error into a safe, standardized error DTO.
 * Guarantees no stack trace or raw canary secrets leak in the result.
 *
 * Note on AppError vs generic Error:
 * - AppError: Intended for trusted, safe application-level errors. Its safeMessage and
 *   field errors are sanitized (including field names and values) before presentation.
 * - Non-AppError (generic Error, TypeError, AxiosError, etc.): Strictly returns a static
 *   generic error message to prevent opaque, unregistered canary tokens or raw exception
 *   internals from leaking.
 */
export const STATIC_INTERNAL_ERROR_MESSAGE =
  'An internal error occurred. Please reference correlationId for support.';

export function toSafeErrorDto(
  error: unknown,
  fallbackCorrelationId?: string,
  canaries: readonly string[] = []
): SafeErrorDto {
  const correlationId = fallbackCorrelationId ?? (error instanceof AppError ? error.correlationId : randomUUID());

  if (error instanceof AppError) {
    return {
      code: error.code,
      message: sanitizeErrorMessage(error.message, canaries),
      correlationId: error.correlationId,
      retryable: error.retryable,
      statusCode: error.statusCode,
      fieldErrors: error.fieldErrors?.map((f) => ({
        field: sanitizeErrorMessage(f.field, canaries),
        message: sanitizeErrorMessage(f.message, canaries),
      })),
    };
  }

  // Non-AppError (generic or unknown exception): strictly fail-closed with static message.
  // Never echo error.message from arbitrary errors as they frequently contain unvetted
  // connection strings, query dumps, or opaque canary secrets.
  return {
    code: 'INTERNAL_ERROR',
    message: STATIC_INTERNAL_ERROR_MESSAGE,
    correlationId,
    retryable: true,
    statusCode: 500,
  };
}
