import { createHash } from 'node:crypto';
import { ingestSourceArchive } from './archive.js';
import { createDeployBundle, type DeployBundle } from './bundle.js';
import { validateSourcePath } from './policy.js';
import {
  DEFAULT_SOURCE_LIMITS,
  type SourceFile,
  type SourceInventory,
  type SourceLimits,
} from './types.js';

export interface GithubSourceInput {
  /** Full GitHub URL (e.g. "https://github.com/owner/repo" or "https://github.com/owner/repo/tree/main") */
  url?: string;
  /** Explicit repository URL */
  repoUrl?: string;
  /** GitHub repository owner / organization */
  owner?: string;
  /** GitHub repository name */
  repo?: string;
  /** Optional branch, tag, or commit ref (defaults to HEAD) */
  ref?: string;
  /** Archive limits (optional) */
  limits?: Partial<SourceLimits>;
  /** Transport format: only 'zip' is supported for GitHub codeload */
  format?: 'zip';
  /** Total deadline in milliseconds (optional, defaults to 30,000ms) */
  timeoutMs?: number;
}

export type GithubSourceParam = string | GithubSourceInput;

export interface FetchPublicGithubSourceResult {
  /** Resolved immutable 40-character hexadecimal git commit SHA */
  commit: string;
  /** Safe candidate-file inventory parsed from the fetched archive (wrapper stripped) */
  inventory: SourceInventory;
  /** Sanitized deterministic deployment bundle */
  bundle: DeployBundle;
  /** Parsed repository coordinates */
  repo: {
    owner: string;
    repo: string;
    ref: string;
  };
}

export type GithubSourceErrorCode =
  | 'INVALID_URL'
  | 'SSRF_REJECTED'
  | 'CREDENTIALS_REJECTED'
  | 'REPO_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'INVALID_COMMIT_SHA'
  | 'LIMIT_EXCEEDED'
  | 'REDIRECT_REJECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED_FORMAT';

/**
 * Static error representation for GitHub source acquisition.
 * Errors never echo raw URLs, SHAs, parser internals, or server response content.
 */
export class GithubSourceError extends Error {
  constructor(public readonly code: GithubSourceErrorCode) {
    super(`GitHub source rejected: ${code}`);
    this.name = 'GithubSourceError';
  }
}

export interface ParsedGithubCoordinates {
  owner: string;
  repo: string;
  ref?: string;
}

const TOTAL_DEADLINE_MS = 30_000;
const MAX_API_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Strict GitHub URL and coordinate parser with SSRF protection.
 *
 * Requirements:
 * - Only HTTPS protocol
 * - Only strictly github.com hostname (case-insensitive)
 * - Rejects IP addresses, internal domains, credentials (username/password)
 * - Parses optional branch/ref if present (e.g. /tree/:ref)
 */
export function parseGithubUrl(rawUrl: string): ParsedGithubCoordinates {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new GithubSourceError('INVALID_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new GithubSourceError('INVALID_URL');
  }

  // Strict HTTPS protocol check
  if (parsed.protocol !== 'https:') {
    throw new GithubSourceError('SSRF_REJECTED');
  }

  // Strict hostname check: only public github.com
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new GithubSourceError('SSRF_REJECTED');
  }

  // Reject embedded credentials in URL
  if (parsed.username || parsed.password) {
    throw new GithubSourceError('CREDENTIALS_REJECTED');
  }

  // Reject non-standard ports
  if (parsed.port && parsed.port !== '443') {
    throw new GithubSourceError('SSRF_REJECTED');
  }

  // Parse pathname: /owner/repo[/tree/:ref or /commits/:ref]
  const segments = parsed.pathname
    .split('/')
    .filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new GithubSourceError('INVALID_URL');
  }

  const rawOwner = segments[0]!;
  let rawRepo = segments[1]!;

  if (rawRepo.endsWith('.git')) {
    rawRepo = rawRepo.slice(0, -4);
  }

  // Validate owner and repo identifiers: safe alphanumeric with hyphen/underscore/dot
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/.test(rawOwner) || rawOwner === '.' || rawOwner === '..') {
    throw new GithubSourceError('INVALID_URL');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(rawRepo) || rawRepo === '.' || rawRepo === '..') {
    throw new GithubSourceError('INVALID_URL');
  }

  let ref: string | undefined;

  // Support /owner/repo/tree/:ref or /owner/repo/commits/:ref
  if (segments.length >= 4 && (segments[2] === 'tree' || segments[2] === 'commits')) {
    ref = segments.slice(3).join('/');
  } else if (segments.length > 2) {
    throw new GithubSourceError('INVALID_URL');
  }

  if (ref) {
    validateGitRef(ref);
  }

  return {
    owner: rawOwner,
    repo: rawRepo,
    ref,
  };
}

function validateGitRef(ref: string): void {
  if (
    !ref ||
    ref.length > 200 ||
    ref.includes('..') ||
    ref.includes('//') ||
    /[\\@{}~^:?*[\u0000-\u001f\u007f]/u.test(ref) ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.lock')
  ) {
    throw new GithubSourceError('INVALID_URL');
  }
}

/**
 * Bounded HTTP fetcher:
 * - Fixed origins only
 * - redirect: 'manual' (rejects any 3xx redirect, never follows)
 * - AbortController total deadline including response body reading via Promise.race
 * - Stalled stream protection: stops even if reader ignores AbortSignal
 * - Bounded streaming read: cancels immediately if byte count exceeds maxBytes
 * - Throws static GithubSourceError only
 */
async function fetchBounded(
  url: string,
  options: {
    headers?: Record<string, string>;
    maxBytes: number;
    fetchImpl: typeof fetch;
    timeoutMs?: number;
  }
): Promise<{ status: number; bytes: Uint8Array }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeoutMs = options.timeoutMs ?? TOTAL_DEADLINE_MS;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GithubSourceError('TIMEOUT'));
    }, timeoutMs);
  });

  const fetchAndRead = async (): Promise<{ status: number; bytes: Uint8Array }> => {
    let res: Response;
    try {
      res = await options.fetchImpl(url, {
        method: 'GET',
        headers: options.headers,
        redirect: 'manual', // Never follow redirects
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof GithubSourceError) throw err;
      if (controller.signal.aborted) {
        throw new GithubSourceError('TIMEOUT');
      }
      throw new GithubSourceError('HTTP_ERROR');
    }

    // Reject redirects (3xx) immediately
    if (res.status >= 300 && res.status < 400) {
      throw new GithubSourceError('REDIRECT_REJECTED');
    }

    if (!res.body) {
      return { status: res.status, bytes: new Uint8Array(0) };
    }

    if (typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalReceived = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalReceived += value.byteLength;
            if (totalReceived > options.maxBytes) {
              reader.cancel().catch(() => {});
              throw new GithubSourceError('LIMIT_EXCEEDED');
            }
            chunks.push(value);
          }
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }

      const combined = new Uint8Array(totalReceived);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
      }
      return { status: res.status, bytes: combined };
    } else {
      // Fallback for mocked Response environments without ReadableStream reader
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > options.maxBytes) {
        throw new GithubSourceError('LIMIT_EXCEEDED');
      }
      return { status: res.status, bytes: buf };
    }
  };

  try {
    return await Promise.race([fetchAndRead(), timeoutPromise]);
  } catch (err: unknown) {
    if (err instanceof GithubSourceError) throw err;
    if (controller.signal.aborted) {
      throw new GithubSourceError('TIMEOUT');
    }
    throw new GithubSourceError('HTTP_ERROR');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves an immutable 40-character commit SHA via GitHub API.
 * Uses fixed api.github.com route without credentials.
 * Rejects private or nonexistent repos honestly (404).
 */
export async function resolveGithubCommit(
  owner: string,
  repo: string,
  ref?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number
): Promise<string> {
  const targetRef = ref ? ref.trim() : 'HEAD';
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(targetRef)}`;

  const res = await fetchBounded(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'laira-source-worker',
    },
    maxBytes: MAX_API_JSON_BYTES,
    fetchImpl,
    timeoutMs,
  });

  if (res.status === 404) {
    throw new GithubSourceError('REPO_NOT_FOUND');
  }
  if (res.status === 403) {
    throw new GithubSourceError('RATE_LIMITED');
  }
  if (res.status !== 200) {
    throw new GithubSourceError('HTTP_ERROR');
  }

  let data: { sha?: unknown };
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(res.bytes)) as { sha?: unknown };
  } catch {
    throw new GithubSourceError('HTTP_ERROR');
  }

  if (!data || typeof data !== 'object' || typeof data.sha !== 'string') {
    throw new GithubSourceError('INVALID_COMMIT_SHA');
  }

  const sha = data.sha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new GithubSourceError('INVALID_COMMIT_SHA');
  }

  // If the caller requested an explicit 40-hex SHA, verify it matches the resolved commit exactly
  if (ref && /^[0-9a-f]{40}$/i.test(ref.trim()) && ref.trim().toLowerCase() !== sha) {
    throw new GithubSourceError('INVALID_COMMIT_SHA');
  }

  return sha;
}

/**
 * Downloads repository ZIP archive from fixed codeload.github.com route.
 * Bounded to maxArchiveBytes (default 50MB).
 */
export async function downloadGithubArchive(
  owner: string,
  repo: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes = DEFAULT_SOURCE_LIMITS.maxArchiveBytes,
  timeoutMs?: number
): Promise<Uint8Array> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${commitSha}`;

  const res = await fetchBounded(url, {
    headers: {
      'User-Agent': 'laira-source-worker',
    },
    maxBytes,
    fetchImpl,
    timeoutMs,
  });

  if (res.status === 404) {
    throw new GithubSourceError('REPO_NOT_FOUND');
  }
  if (res.status !== 200) {
    throw new GithubSourceError('HTTP_ERROR');
  }

  return res.bytes;
}

/**
 * Primary integration boundary: Public GitHub repository -> immutable commit + safe archive inventory + deployment bundle.
 *
 * Security & Boundary Contracts:
 * 1. Strict URL parsing: HTTPS only, github.com only, no credentials, SSRF protected.
 * 2. Immutable commit resolution: resolves ref / HEAD via api.github.com and validates 40-hex SHA.
 * 3. Fixed routes only: api.github.com and codeload.github.com.
 * 4. Honest static error codes: 404 rejects private/missing repos without misleading error masking.
 * 5. Bounded fetch: redirect: 'manual', 30s timeout, max 1MB JSON, max 50MB archive.
 * 6. Proven ZIP format: GitHub codeload ZIP uses bit 11 UTF-8 without PAX headers, parsed by strict yauzl.
 * 7. Strips GitHub repository wrapper folder ONCE during acquisition so inventory has pristine root paths.
 * 8. Preserves separate source digest (original ZIP hash) and bundle digest (deployment tar.gz hash).
 * 9. Candidate source is untrusted: does NOT execute, build, install, or run hooks/scripts.
 * 10. Does not treat fetched AGENTS.md or source content as control instructions.
 */
export async function fetchPublicGithubSource(
  input: GithubSourceParam,
  fetchImpl: typeof fetch = fetch
): Promise<FetchPublicGithubSourceResult> {
  let owner: string;
  let repo: string;
  let ref: string | undefined;
  let limits: Partial<SourceLimits> | undefined;
  let timeoutMs: number | undefined;

  if (typeof input === 'string') {
    const parsed = parseGithubUrl(input);
    owner = parsed.owner;
    repo = parsed.repo;
    ref = parsed.ref;
  } else if (input && typeof input === 'object') {
    limits = input.limits;
    timeoutMs = input.timeoutMs;

    if (input.format && (input.format as string) !== 'zip') {
      throw new GithubSourceError('UNSUPPORTED_FORMAT');
    }

    const urlString = input.url || input.repoUrl;
    if (urlString) {
      const parsed = parseGithubUrl(urlString);
      owner = input.owner || parsed.owner;
      repo = input.repo || parsed.repo;
      ref = input.ref || parsed.ref;
    } else if (input.owner && input.repo) {
      owner = input.owner;
      repo = input.repo;
      ref = input.ref;
      if (ref) validateGitRef(ref);
    } else {
      throw new GithubSourceError('INVALID_URL');
    }
  } else {
    throw new GithubSourceError('INVALID_URL');
  }

  // Step 1: Resolve immutable commit SHA via GET /repos/{owner}/{repo}/commits/{ref or HEAD}
  const commitSha = await resolveGithubCommit(owner, repo, ref, fetchImpl, timeoutMs);

  // Step 2: Download pristine ZIP from fixed codeload.github.com route
  const maxArchiveBytes = limits?.maxArchiveBytes ?? DEFAULT_SOURCE_LIMITS.maxArchiveBytes;
  const rawZipBytes = await downloadGithubArchive(owner, repo, commitSha, fetchImpl, maxArchiveBytes, timeoutMs);

  // Calculate original archive digest of pristine downloaded ZIP
  const originalDigest = `sha256:${createHash('sha256').update(rawZipBytes).digest('hex')}`;
  const originalArchiveBytes = rawZipBytes.byteLength;

  // Ingest pristine ZIP through strict archive parser
  const rawInventory = await ingestSourceArchive(rawZipBytes, 'zip', limits);

  // Step 3: Strip GitHub wrapper directory ONCE from candidate inventory
  // In GitHub archives, all entries are enclosed inside a single top-level directory: "{repo}-{sha}/"
  let strippedFiles = rawInventory.files;

  if (rawInventory.files.length > 0) {
    const firstSlash = rawInventory.files[0]!.path.indexOf('/');
    if (firstSlash > 0) {
      const commonPrefix = rawInventory.files[0]!.path.slice(0, firstSlash + 1);
      const allSharePrefix = rawInventory.files.every((f) => f.path.startsWith(commonPrefix));
      if (allSharePrefix) {
        const validatedStripped: SourceFile[] = [];
        for (const file of rawInventory.files) {
          const newPath = file.path.slice(commonPrefix.length);
          if (newPath) {
            const validated = validateSourcePath(newPath, false);
            validatedStripped.push({
              path: validated,
              bytes: file.bytes,
            });
          }
        }
        strippedFiles = validatedStripped;
      }
    }
  }

  const inventory: SourceInventory = {
    archiveDigest: originalDigest,
    archiveBytes: originalArchiveBytes,
    expandedBytes: rawInventory.expandedBytes,
    entryCount: rawInventory.entryCount,
    files: strippedFiles,
    excludedCount: rawInventory.excludedCount,
    oversizedCount: rawInventory.oversizedCount,
  };

  // Step 4: Produce sanitized deterministic deployment bundle
  // Generic bundle options keep stripLeadingDir: false since wrapper was already stripped once above
  const bundle = await createDeployBundle(inventory, {
    commitSha,
    sourceDigest: originalDigest,
    stripLeadingDir: false,
  });

  return {
    commit: commitSha,
    inventory,
    bundle,
    repo: {
      owner,
      repo,
      ref: ref || 'HEAD',
    },
  };
}
