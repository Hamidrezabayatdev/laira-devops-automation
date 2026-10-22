/**
 * Tenant-scoped storage errors.
 * Ensures static generic error messages on unknown provider failures.
 * Never leaks raw SDK messages, credentials, response bodies, headers, or canary tokens.
 */

export interface StorageErrorDetails {
  readonly code: string;
  readonly statusCode: number;
  readonly workspaceId?: string;
  readonly artifactId?: string;
  readonly safeDetails?: Record<string, unknown>;
}

export class StorageError extends Error implements StorageErrorDetails {
  readonly code: string;
  readonly statusCode: number;
  readonly workspaceId?: string;
  readonly artifactId?: string;
  readonly safeDetails?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      workspaceId?: string;
      artifactId?: string;
      safeDetails?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.workspaceId = options.workspaceId;
    this.artifactId = options.artifactId;
    this.safeDetails = options.safeDetails;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StorageConfigError extends StorageError {
  constructor(message: string, options?: { safeDetails?: Record<string, unknown> }) {
    super(message, {
      code: 'STORAGE_CONFIG_INVALID',
      statusCode: 400,
      safeDetails: options?.safeDetails,
    });
  }
}

export class CrossWorkspaceAccessError extends StorageError {
  constructor(options: { callerWorkspaceId: string; targetWorkspaceId?: string; artifactId?: string }) {
    super(
      `Cross-workspace access denied: caller workspace '${options.callerWorkspaceId}' cannot access artifact '${options.artifactId ?? 'unknown'}' in workspace '${options.targetWorkspaceId ?? 'unknown'}'`,
      {
        code: 'CROSS_WORKSPACE_ACCESS_DENIED',
        statusCode: 403,
        workspaceId: options.callerWorkspaceId,
        artifactId: options.artifactId,
        safeDetails: {
          targetWorkspaceId: options.targetWorkspaceId,
        },
      }
    );
  }
}

export class PathInjectionError extends StorageError {
  constructor(message: string, options?: { workspaceId?: string; artifactId?: string }) {
    super(`Path injection rejected: ${message}`, {
      code: 'PATH_INJECTION_DETECTED',
      statusCode: 400,
      workspaceId: options?.workspaceId,
      artifactId: options?.artifactId,
    });
  }
}

export class InvalidStorageKeyError extends StorageError {
  constructor(message: string, options?: { workspaceId?: string; artifactId?: string }) {
    super(`Invalid storage key: ${message}`, {
      code: 'INVALID_STORAGE_KEY',
      statusCode: 400,
      workspaceId: options?.workspaceId,
      artifactId: options?.artifactId,
    });
  }
}

export class ChecksumMismatchError extends StorageError {
  readonly expectedDigest?: string;
  readonly actualDigest?: string;

  constructor(options: {
    workspaceId: string;
    artifactId?: string;
    expectedDigest?: string;
    actualDigest?: string;
  }) {
    super(
      `Checksum mismatch for artifact '${options.artifactId ?? 'unknown'}' in workspace '${options.workspaceId}': integrity verification failed`,
      {
        code: 'CHECKSUM_MISMATCH',
        statusCode: 400,
        workspaceId: options.workspaceId,
        artifactId: options.artifactId,
        safeDetails: {
          expectedDigest: options.expectedDigest,
          actualDigest: options.actualDigest,
        },
      }
    );
    this.expectedDigest = options.expectedDigest;
    this.actualDigest = options.actualDigest;
  }
}

export class StorageIntegrityError extends StorageError {
  constructor(message: string, options?: { workspaceId?: string; artifactId?: string }) {
    super(`Storage integrity mismatch: ${message}`, {
      code: 'STORAGE_INTEGRITY_MISMATCH',
      statusCode: 400,
      workspaceId: options?.workspaceId,
      artifactId: options?.artifactId,
    });
  }
}

export class ArtifactSizeLimitExceededError extends StorageError {
  readonly actualBytes?: number;
  readonly maxBytes: number;

  constructor(options: {
    workspaceId: string;
    artifactId?: string;
    actualBytes?: number;
    maxBytes: number;
  }) {
    super(
      `Artifact size limit exceeded in workspace '${options.workspaceId}': artifact ${options.actualBytes !== undefined ? `${options.actualBytes} bytes ` : ''}exceeds bounded maximum of ${options.maxBytes} bytes`,
      {
        code: 'ARTIFACT_SIZE_LIMIT_EXCEEDED',
        statusCode: 413,
        workspaceId: options.workspaceId,
        artifactId: options.artifactId,
        safeDetails: {
          actualBytes: options.actualBytes,
          maxBytes: options.maxBytes,
        },
      }
    );
    this.actualBytes = options.actualBytes;
    this.maxBytes = options.maxBytes;
  }
}

export class StorageTimeoutError extends StorageError {
  constructor(options: { workspaceId: string; artifactId?: string; timeoutMs: number }) {
    super(
      `Storage operation timed out after ${options.timeoutMs}ms in workspace '${options.workspaceId}'`,
      {
        code: 'STORAGE_TIMEOUT',
        statusCode: 504,
        workspaceId: options.workspaceId,
        artifactId: options.artifactId,
        safeDetails: { timeoutMs: options.timeoutMs },
      }
    );
  }
}

export class ArtifactNotFoundError extends StorageError {
  constructor(options: { workspaceId: string; artifactId: string }) {
    super(`Artifact '${options.artifactId}' not found in workspace '${options.workspaceId}'`, {
      code: 'ARTIFACT_NOT_FOUND',
      statusCode: 404,
      workspaceId: options.workspaceId,
      artifactId: options.artifactId,
    });
  }
}

export class ArtifactAlreadyExistsError extends StorageError {
  constructor(options: { workspaceId: string; artifactId: string }) {
    super(
      `Artifact '${options.artifactId}' already exists in workspace '${options.workspaceId}'; immutable artifacts cannot be overwritten`,
      {
        code: 'ARTIFACT_ALREADY_EXISTS',
        statusCode: 409,
        workspaceId: options.workspaceId,
        artifactId: options.artifactId,
      }
    );
  }
}

export class ArtifactExpiredError extends StorageError {
  readonly expiry: string;

  constructor(options: { workspaceId: string; artifactId: string; expiry: string }) {
    super(
      `Artifact '${options.artifactId}' in workspace '${options.workspaceId}' expired at ${options.expiry}`,
      {
        code: 'ARTIFACT_EXPIRED',
        statusCode: 410,
        workspaceId: options.workspaceId,
        artifactId: options.artifactId,
        safeDetails: {
          expiry: options.expiry,
        },
      }
    );
    this.expiry = options.expiry;
  }
}

export class UnsupportedStorageOperationError extends StorageError {
  constructor(operation: string) {
    super(`Storage operation '${operation}' is unsupported in Phase 0`, {
      code: 'STORAGE_OPERATION_UNSUPPORTED',
      statusCode: 501,
    });
  }
}

export class StorageOperationError extends StorageError {
  constructor(
    message: string,
    options?: {
      code?: string;
      statusCode?: number;
      workspaceId?: string;
      artifactId?: string;
      safeDetails?: Record<string, unknown>;
    }
  ) {
    super(message, {
      code: options?.code ?? 'STORAGE_OPERATION_FAILED',
      statusCode: options?.statusCode ?? 502,
      workspaceId: options?.workspaceId,
      artifactId: options?.artifactId,
      safeDetails: options?.safeDetails,
    });
  }

  /**
   * Safely maps any underlying S3 or network exception.
   * Guarantees:
   * - Never echoes raw error.message (preventing arbitrary credentials, tokens, or nonces leakage).
   * - Never attaches cause containing raw headers, request bodies, or internal provider dumps.
   * - Maps 404 / NoSuchKey to ArtifactNotFoundError.
   * - Maps 412 / PreconditionFailed to ArtifactAlreadyExistsError.
   * - Maps unknown failures to a static generic message.
   */
  static from(
    err: unknown,
    context?: { workspaceId?: string; artifactId?: string; operation?: string }
  ): StorageError {
    if (err instanceof StorageError) {
      return err;
    }

    const anyErr = err as Record<string, unknown> | null | undefined;
    const errName = typeof anyErr?.name === 'string' ? anyErr.name : '';
    const errCode = typeof anyErr?.Code === 'string' ? anyErr.Code : (typeof anyErr?.code === 'string' ? anyErr.code : '');
    const httpStatus = typeof anyErr?.$metadata === 'object' && anyErr.$metadata !== null && 'httpStatusCode' in anyErr.$metadata
      ? (anyErr.$metadata as { httpStatusCode: number }).httpStatusCode
      : (typeof anyErr?.statusCode === 'number' ? anyErr.statusCode : undefined);

    const ws = context?.workspaceId ?? 'unknown';
    const art = context?.artifactId ?? 'unknown';

    // 1. 404 / NoSuchKey / NotFound
    if (
      errName === 'NoSuchKey' ||
      errCode === 'NoSuchKey' ||
      errName === 'NotFound' ||
      httpStatus === 404
    ) {
      return new ArtifactNotFoundError({
        workspaceId: ws,
        artifactId: art,
      });
    }

    // 2. 412 / PreconditionFailed (IfNoneMatch collision)
    if (
      errName === 'PreconditionFailed' ||
      errCode === 'PreconditionFailed' ||
      httpStatus === 412
    ) {
      return new ArtifactAlreadyExistsError({
        workspaceId: ws,
        artifactId: art,
      });
    }

    // 3. Static generic message for unknown failures — NO raw message echo, NO raw cause
    const opPrefix = context?.operation ? `during '${context.operation}'` : 'operation';
    return new StorageOperationError(
      `Underlying S3 storage ${opPrefix} failed: An internal storage provider error occurred`,
      {
        workspaceId: context?.workspaceId,
        artifactId: context?.artifactId,
        statusCode: httpStatus && httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
      }
    );
  }
}

/**
 * Strips known sensitive credential patterns from error messages.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') return '';
  return message
    .replace(/(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/g, '[REDACTED_ACCESS_KEY]')
    .replace(/(?:secretAccessKey|secret|password|key|token)[=:]\s*['"]?[^'"\s&]+['"]?/gi, 'secret=[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/g, 'Bearer [REDACTED]')
    .replace(/X-Amz-[A-Za-z0-9-]+=[^&\s]+/gi, (m) => m.split('=')[0] + '=[REDACTED]')
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, '[XML_PAYLOAD_REDACTED]');
}
