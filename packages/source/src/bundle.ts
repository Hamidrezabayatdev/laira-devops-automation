import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { isExcludedSourcePath, validateSourcePath } from './policy.js';
import {
  DEFAULT_SOURCE_LIMITS,
  SourceImportError,
  type SourceFile,
  type SourceInventory,
} from './types.js';

export interface DeployBundle {
  /** Deterministic gzipped tar archive bytes */
  bytes: Uint8Array;
  /** sha256 hex digest of the deployment bundle archive bytes: sha256:<hex> */
  bundleDigest: string;
  /** Size in bytes of the deploy bundle archive */
  bundleBytes: number;
  /** Number of files included in the deploy bundle */
  fileCount: number;
  /** Total uncompressed bytes of the files included */
  totalBytes: number;
  /** Original source archive digest: sha256:<hex> (distinct from bundleDigest) */
  sourceDigest?: string;
  /** Exact commit SHA (40-hex) attached separately, if provided */
  commitSha?: string;
  /** Canonical relative file paths included in the deploy bundle */
  paths: string[];
}

export interface BundleOptions {
  /**
   * Strip single common top-level directory prefix if all files share it.
   * Defaults to FALSE in generic API to prevent altering legitimate single-dir projects (e.g. src/).
   */
  stripLeadingDir?: boolean;
  /** Exact git commit SHA (40-hex) to bind with the deployment bundle */
  commitSha?: string;
  /** Original source archive digest to bind with the bundle */
  sourceDigest?: string;
  /** Maximum allowable deployment bundle compressed archive size in bytes (defaults to 50MB, reduce-only) */
  maxBundleBytes?: number;
}

export type BundleErrorCode =
  | 'OVERSIZED_FILES'
  | 'LIMIT_EXCEEDED'
  | 'EMPTY_BUNDLE'
  | 'UNSAFE_PATH';

/**
 * Static bundle error representation.
 * Error messages are static codes only; internal paths and content are never echoed.
 */
export class BundleError extends Error {
  constructor(public readonly code: BundleErrorCode) {
    super(`Bundle rejected: ${code}`);
    this.name = 'BundleError';
  }
}

class PathCollisionTracker {
  private readonly seenEntries = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly ancestorDirs = new Set<string>();

  checkAndRecord(validatedPath: string): void {
    const canonical = validatedPath.normalize('NFC').toLowerCase();

    // Direct collision: identical canonical path seen before (including NFC / case)
    if (this.seenEntries.has(canonical)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    const segments = canonical.split('/');
    const parents: string[] = [];
    for (let i = 1; i < segments.length; i++) {
      parents.push(segments.slice(0, i).join('/'));
    }

    // Cannot declare a file if this path was already used as an ancestor directory by an existing entry
    if (this.ancestorDirs.has(canonical)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }
    // Cannot declare a file if any ancestor was declared as a regular file
    for (const parent of parents) {
      if (this.seenFiles.has(parent)) {
        throw new SourceImportError('UNSAFE_ENTRY');
      }
    }

    this.seenEntries.add(canonical);
    this.seenFiles.add(canonical);
    for (const parent of parents) {
      this.ancestorDirs.add(parent);
    }
  }
}

/**
 * Validates that a path fits in standard USTAR framing (name <= 100 or prefix <= 155 + name <= 100 split on slash).
 * Strict USTAR readers reject archives that use GNU long metadata ('L') or PAX headers ('x').
 */
function fitsInUstar(path: string): boolean {
  const byteLen = Buffer.byteLength(path, 'utf8');
  if (byteLen <= 100) return true;
  if (byteLen > 256) return false;

  const parts = path.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (
      Buffer.byteLength(prefix, 'utf8') <= 155 &&
      Buffer.byteLength(name, 'utf8') <= 100
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a sanitized, deterministic deployment bundle (.tar.gz) from an ingested candidate SourceInventory.
 *
 * Security & Boundary Contracts:
 * 1. Fails closed if any oversized candidate files were omitted during archive ingestion (`oversizedCount > 0`).
 * 2. Excludes recognized secrets, build artifacts, and dependency directories per policy (`isExcludedSourcePath`).
 * 3. Does not exclude .gitignore / .gitattributes as they can control build behavior; excludes .gitmodules.
 * 4. Preserves layout: generic API defaults `stripLeadingDir: false` so single-folder projects (e.g. src/)
 *    are not altered.
 * 5. Guarantees bit-for-bit determinism: entries sorted lexicographically by code point, fixed mode 0o644,
 *    fixed mtime 0, zeroed gzip header timestamp.
 * 6. Bounds: 10,000 files, 1 MiB per file, 16 MiB total uncompressed files, 50 MiB compressed bundle.
 * 7. Candidate source is untrusted and may contain arbitrary secrets; requires explicit user review.
 * 8. Never executes, builds, or installs source files. AGENTS.md instructions are never treated as control directives.
 */
export async function createDeployBundle(
  inventory: SourceInventory,
  options?: BundleOptions
): Promise<DeployBundle> {
  // Candidate inventory intentionally omits oversized files (>1MB).
  // We cannot silently deploy an incomplete codebase: fail bundle immediately if oversizedCount > 0.
  if (inventory.oversizedCount > 0) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }

  return createDeployBundleFromFiles(inventory.files, {
    stripLeadingDir: options?.stripLeadingDir ?? false,
    commitSha: options?.commitSha,
    sourceDigest: options?.sourceDigest ?? inventory.archiveDigest,
    maxBundleBytes: options?.maxBundleBytes,
  });
}

/**
 * Creates a deterministic deployment bundle directly from an array of SourceFile entries.
 */
export async function createDeployBundleFromFiles(
  files: SourceFile[],
  options?: BundleOptions
): Promise<DeployBundle> {
  // Snapshot input files immediately before any awaits so caller cannot concurrently mutate
  const snapshot: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }
    const copy = new Uint8Array(f.bytes.byteLength);
    copy.set(f.bytes);
    snapshot.push({ path: f.path, bytes: copy });
  }

  // Resolve and validate maxBundleBytes (reduce-only override of default 50MB)
  let maxBundleBytes = DEFAULT_SOURCE_LIMITS.maxArchiveBytes;
  if (options?.maxBundleBytes !== undefined) {
    if (
      typeof options.maxBundleBytes !== 'number' ||
      !Number.isSafeInteger(options.maxBundleBytes) ||
      options.maxBundleBytes <= 0 ||
      options.maxBundleBytes > DEFAULT_SOURCE_LIMITS.maxArchiveBytes
    ) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }
    maxBundleBytes = options.maxBundleBytes;
  }

  // Standalone limit enforcement: max 10,000 entries
  if (snapshot.length > DEFAULT_SOURCE_LIMITS.maxEntries) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }

  // Filter excluded files per policy; do not normalize backslashes before validation (fail strict)
  const candidateFiles = snapshot.filter((file) => {
    // Exclude .gitmodules
    const parts = file.path.split('/');
    if (parts.includes('.gitmodules')) return false;
    // Exclude recognized secret, build, and dependency paths (keeps .gitignore/.gitattributes)
    if (isExcludedSourcePath(file.path)) return false;
    return true;
  });

  // Optional leading directory stripping (defaults to false in standalone bundle API)
  let processedFiles = candidateFiles;
  const stripLeadingDir = options?.stripLeadingDir ?? false;

  if (stripLeadingDir && candidateFiles.length > 0) {
    const firstSlash = candidateFiles[0]!.path.indexOf('/');
    if (firstSlash > 0) {
      const commonPrefix = candidateFiles[0]!.path.slice(0, firstSlash + 1);
      const allSharePrefix = candidateFiles.every((f) => f.path.startsWith(commonPrefix));
      if (allSharePrefix) {
        processedFiles = candidateFiles.map((f) => ({
          path: f.path.slice(commonPrefix.length),
          bytes: f.bytes,
        }));
      }
    }
  }

  // Validate paths, enforce per-file limit (1MB), total retained limit (16MB), and collision tracker
  const tracker = new PathCollisionTracker();
  const validatedFiles: Array<{ path: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;

  for (const file of processedFiles) {
    if (!file.path || file.path === '.' || file.path === '/') {
      continue;
    }

    // Fail strict on raw path: validateSourcePath rejects backslashes and traversal
    const validated = validateSourcePath(file.path, false);
    tracker.checkAndRecord(validated);

    // Standalone limit: max 1 MiB per file
    if (file.bytes.byteLength > DEFAULT_SOURCE_LIMITS.maxFileBytes) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }

    // Standalone limit: max 16 MiB total retained files
    totalBytes += file.bytes.byteLength;
    if (totalBytes > DEFAULT_SOURCE_LIMITS.maxRetainedBytes) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }

    // Strict USTAR framing fit check
    if (!fitsInUstar(validated)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    validatedFiles.push({
      path: validated,
      bytes: file.bytes,
    });
  }

  // Deterministic sorting: sort lexicographically by code point (locale-independent)
  validatedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Pack tar deterministically
  const pack = tar.pack();
  const chunks: Buffer[] = [];

  const packPromise = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk: unknown) => {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.from(
                (chunk as Uint8Array).buffer,
                (chunk as Uint8Array).byteOffset,
                (chunk as Uint8Array).byteLength
              )
      );
    });
    pack.on('error', (err: unknown) => reject(err));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });

  for (const file of validatedFiles) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: file.path,
          size: file.bytes.byteLength,
          mode: 0o644,
          mtime: new Date(0),
          type: 'file',
          uid: 0,
          gid: 0,
          uname: '',
          gname: '',
        },
        Buffer.from(file.bytes),
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  pack.finalize();
  const rawTar = await packPromise;

  // Compress deterministically (zeroed mtime in gzip header)
  const gzipped = gzipSync(rawTar);
  if (gzipped.length >= 10) {
    gzipped[4] = 0;
    gzipped[5] = 0;
    gzipped[6] = 0;
    gzipped[7] = 0;
  }

  if (gzipped.byteLength > maxBundleBytes) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }

  const bundleDigest = `sha256:${createHash('sha256').update(gzipped).digest('hex')}`;

  return {
    bytes: new Uint8Array(gzipped),
    bundleDigest,
    bundleBytes: gzipped.byteLength,
    fileCount: validatedFiles.length,
    totalBytes,
    sourceDigest: options?.sourceDigest,
    commitSha: options?.commitSha,
    paths: validatedFiles.map((f) => f.path),
  };
}
