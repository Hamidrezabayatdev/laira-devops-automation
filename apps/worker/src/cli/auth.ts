import childProcess from 'node:child_process';
import type { GitHubUser, OperatorCliDependencies } from './types.js';

const GITHUB_USER_API_URL = 'https://api.github.com/user';
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024; // 1 MiB bounded body
const DEFAULT_TIMEOUT_MS = 10_000; // 10s bounded timeout

/**
 * Resolves GitHub authentication token in order of precedence:
 * 1. GH_TOKEN environment variable
 * 2. GITHUB_TOKEN environment variable
 * 3. `gh auth token` child process execution (CLI runtime only, never agent tool)
 *
 * Fails closed if no token can be resolved.
 */
export function resolveGitHubToken(deps?: OperatorCliDependencies): string {
  const env = deps?.env ?? process.env;

  const envToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  // Fall back to executing `gh auth token` via child process
  try {
    const rawOutput = deps?.execFn
      ? deps.execFn('gh auth token')
      : childProcess.execSync('gh auth token', {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });

    const token = typeof rawOutput === 'string' ? rawOutput.trim() : '';
    if (token) {
      return token;
    }
  } catch {
    // Child process failed or `gh` CLI not logged in
  }

  throw new Error(
    'GitHub authentication failed: no token available. Set GH_TOKEN/GITHUB_TOKEN or run "gh auth login".'
  );
}

interface StreamCancelable {
  cancel: () => Promise<unknown>;
}

/**
 * Calls the GitHub authenticated user API to retrieve verified identity.
 * Enforces:
 * - Whole-body deadline via Promise.race across both headers and body streaming.
 * - redirect: 'manual' with strict rejection of all 3xx to prevent credential forwarding.
 * - Incremental streaming byte bound <= 1 MiB with immediate reader cancellation.
 * - Reader cancellation and controller abort in finally block.
 * - Never leaks token or raw API payload in errors.
 */
export async function fetchAuthenticatedGitHubUser(
  token: string,
  deps?: OperatorCliDependencies
): Promise<GitHubUser> {
  const fetchImpl = deps?.fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Runtime error: global fetch is unavailable');
  }

  const controller = new AbortController();
  let reader: (ReadableStreamDefaultReader<Uint8Array> & StreamCancelable) | null = null;
  let timeoutTimer: NodeJS.Timeout | undefined = undefined;
  const timeoutMs = deps?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
      if (reader) {
        (reader as StreamCancelable).cancel().catch(() => {});
      }
      reject(new Error('GitHub API request timed out'));
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<GitHubUser> => {
    let response: Response;
    try {
      response = await fetchImpl(GITHUB_USER_API_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'laira-operator-cli',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error('GitHub API request timed out');
      }
      throw new Error('GitHub API network connection failed');
    }

    // Strict 3xx redirect rejection to prevent credential leakage
    if (
      (response.status >= 300 && response.status < 400) ||
      response.type === 'opaqueredirect'
    ) {
      throw new Error('GitHub API redirect rejected: credential forwarding prohibited');
    }

    if (!response.ok) {
      throw new Error(`GitHub user authentication failed (HTTP ${response.status})`);
    }

    // Stream and accumulate bytes incrementally with strict <= 1 MiB limit
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    if (response.body && typeof response.body.getReader === 'function') {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_GITHUB_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('GitHub API response body exceeded size limit');
          }
          chunks.push(value);
        }
      }
    } else {
      // Fallback for mocked Response environments without ReadableStream reader
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > MAX_GITHUB_RESPONSE_BYTES) {
        throw new Error('GitHub API response body exceeded size limit');
      }
      chunks.push(buf);
      totalBytes = buf.byteLength;
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    const textBody = new TextDecoder().decode(combined);

    let data: unknown;
    try {
      data = JSON.parse(textBody);
    } catch {
      throw new Error('Invalid JSON received from GitHub API');
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid user payload structure from GitHub API');
    }

    const rawUser = data as Record<string, unknown>;
    const rawId = rawUser.id;
    const rawLogin = rawUser.login;

    if (rawId === undefined || rawId === null) {
      throw new Error('GitHub user payload missing numeric id');
    }

    const numericId = String(rawId).trim();
    if (!/^\d+$/.test(numericId)) {
      throw new Error('GitHub user id is not a valid numeric string');
    }

    if (typeof rawLogin !== 'string' || !rawLogin.trim()) {
      throw new Error('GitHub user payload missing login handle');
    }

    return {
      id: numericId,
      login: rawLogin.trim(),
      name: typeof rawUser.name === 'string' ? rawUser.name.trim() : null,
      email: typeof rawUser.email === 'string' ? rawUser.email.trim() : null,
      avatarUrl: typeof rawUser.avatar_url === 'string' ? rawUser.avatar_url.trim() : null,
    };
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (reader) {
      (reader as StreamCancelable).cancel().catch(() => {});
    }
    try {
      controller.abort();
    } catch {}
  }
}

/**
 * Strictly verifies that the authenticated user matches the configured operator ID.
 * Requires non-empty numeric DEMO_OWNER_GITHUB_ID or explicit expected ID.
 * Fails closed without any hardcoded fallback.
 */
export function verifyOperatorIdentity(
  user: GitHubUser,
  expectedOperatorId?: string,
  deps?: OperatorCliDependencies
): void {
  const env = deps?.env ?? process.env;
  const targetId = (expectedOperatorId ?? env.DEMO_OWNER_GITHUB_ID)?.trim();

  if (!targetId || !/^\d+$/.test(targetId)) {
    throw new Error(
      'Operator verification failed: DEMO_OWNER_GITHUB_ID environment variable is required and must be numeric'
    );
  }

  if (user.id !== targetId) {
    throw new Error(
      'Identity mismatch: authenticated GitHub user does not match authorized operator ID'
    );
  }
}

/**
 * High-level helper to authenticate and verify the operator in one step.
 */
export async function authenticateOperator(
  deps?: OperatorCliDependencies
): Promise<GitHubUser> {
  const token = resolveGitHubToken(deps);
  const user = await fetchAuthenticatedGitHubUser(token, deps);
  verifyOperatorIdentity(user, undefined, deps);
  return user;
}
