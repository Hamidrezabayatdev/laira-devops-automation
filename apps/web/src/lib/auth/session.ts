import { validateGitHubNumericId } from './github-provisioning';
import { dbAdapter, DatabaseUnavailableError } from '../db/adapter-bridge';

export interface AuthenticatedUser {
  id: string;
  githubNumericId: string;
  workspaceId: string;
  role: 'owner';
  name?: string | null;
  email?: string | null;
}

export interface WorkspaceResolutionResult {
  authenticated: boolean;
  user?: AuthenticatedUser;
  error?: string;
  status: number;
}

/**
 * Safely extracts session token from Request.
 * - Handles malformed percent-encoding safely without throwing or unhandled rejections.
 * - Enforces secure cookie precedence: __Secure- cookies cannot be shadowed by insecure cookies.
 * - Supports Bearer authorization token header fallback.
 */
export function extractSessionToken(request: Request): string | null {
  // 1. From Cookie header
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    try {
      const cookies: Record<string, string> = {};
      const parts = cookieHeader.split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const rawVal = trimmed.slice(eqIdx + 1).trim();
        try {
          cookies[key] = decodeURIComponent(rawVal);
        } catch {
          // If decoding fails, treat as malformed and assign empty string to avoid crash
          cookies[key] = '';
        }
      }

      // Secure cookie precedence: __Secure- cookies must take priority over plain cookies
      const secureToken =
        cookies['__Secure-authjs.session-token'] ||
        cookies['__Secure-next-auth.session-token'];
      if (secureToken) return secureToken;

      const standardToken =
        cookies['authjs.session-token'] ||
        cookies['next-auth.session-token'];
      if (standardToken) return standardToken;
    } catch {
      // In case of any parsing exception, fail safe
      return null;
    }
  }

  // 2. From Authorization header (Bearer <sessionToken>)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }

  return null;
}

/**
 * Resolves the authenticated workspace from database sessions.
 *
 * CRITICAL TENANT ISOLATION & FAIL-CLOSED ARCHITECTURE:
 * - NEVER trusts caller-provided IDs in `x-workspace-id`, query params, or JSON body.
 * - NO in-memory fallback on real APIs: if database is unreachable, returns 503 Service Unavailable.
 * - Workspace is strictly resolved from the authenticated GitHub provider numeric identity
 *   and persisted database session.
 */
export async function resolveAuthenticatedWorkspace(
  request: Request,
): Promise<WorkspaceResolutionResult> {
  const sessionToken = extractSessionToken(request);
  if (!sessionToken) {
    return {
      authenticated: false,
      error: 'نیاز به احراز هویت با گیت‌هاب (Unauthorized: valid session required)',
      status: 401,
    };
  }

  // Look up session in real database
  try {
    const lookup = await dbAdapter.lookupWorkspaceBySessionToken(sessionToken);
    if (!lookup) {
      return {
        authenticated: false,
        error: 'نشست کاربری نامعتبر است یا منقضی شده است (Unauthorized: session invalid or expired)',
        status: 401,
      };
    }

    // Validate that the GitHub user ID is strictly numeric
    let githubNumericId: string;
    try {
      githubNumericId = validateGitHubNumericId(lookup.workspace.githubUserId);
    } catch {
      return {
        authenticated: false,
        error: 'شناسه گیت‌هاب نامعتبر است (Forbidden: invalid provider identity)',
        status: 403,
      };
    }

    return {
      authenticated: true,
      user: {
        id: lookup.user.id,
        githubNumericId,
        workspaceId: lookup.workspace.id,
        role: 'owner',
        name: lookup.user.name,
        email: lookup.user.email,
      },
      status: 200,
    };
  } catch (err: unknown) {
    if (err instanceof DatabaseUnavailableError || (err as any)?.code === 'ECONNREFUSED' || (err as any)?.code === '57P01') {
      return {
        authenticated: false,
        error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
        status: 503,
      };
    }
    return {
      authenticated: false,
      error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
      status: 503,
    };
  }
}
