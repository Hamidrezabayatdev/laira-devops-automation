export interface SourceLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxRetainedBytes: number;
}

export const DEFAULT_SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
  maxArchiveBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024,
});

/** Untrusted content: never execute, log, or automatically send to a model. */
export interface SourceFile {
  path: string;
  bytes: Uint8Array;
}

export interface SourceInventory {
  archiveDigest: string;
  archiveBytes: number;
  expandedBytes: number;
  entryCount: number;
  files: SourceFile[];
  excludedCount: number;
  oversizedCount: number;
}

export type SourceErrorCode =
  | 'INVALID_ARCHIVE'
  | 'UNSAFE_ENTRY'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED_FORMAT';

/** Static errors only: archive paths/content and underlying parser errors are not safe diagnostics. */
export class SourceImportError extends Error {
  constructor(public readonly code: SourceErrorCode) {
    super(`Source import rejected: ${code}`);
    this.name = 'SourceImportError';
  }
}

export interface StaticAnalysis {
  /** Inference from static files, not an observed deployment or verified build. */
  provenance: 'static_inference';
  /** null means recognized by name only; syntax was not validated. */
  manifests: Array<{ path: string; kind: string; valid: boolean | null }>;
  runtimes: string[];
  packageManagers: string[];
  dependencyNames: string[];
  environmentVariableNames: string[];
  ports: number[];
  limitations: string[];
}
