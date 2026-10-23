import pg from 'pg';
import {
  getOrCreateOwnerWorkspace,
  type User,
  type Workspace,
} from '@laira/db';
import type { GitHubUser, OperatorCliDependencies } from './types.js';

const { Pool } = pg;

export interface ManagedPool {
  pool: pg.Pool;
  shouldClose: boolean;
}

/**
 * Validates database URL without logging credentials or connection strings.
 */
export function validateDatabaseUrl(
  rawUrl: string,
  options?: { requireLocalhost?: boolean }
): string {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid DATABASE_URL connection format');
  }

  if (options?.requireLocalhost) {
    const hostname = parsed.hostname.toLowerCase();
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0';

    if (!isLocal) {
      throw new Error(
        'Operator local mode requires the database host to be on localhost'
      );
    }
  }

  return rawUrl.trim();
}

/**
 * Obtains a PostgreSQL pool instance, either from injected dependencies or constructed
 * from the environment DATABASE_URL.
 */
export function resolveDatabasePool(deps?: OperatorCliDependencies): ManagedPool {
  if (deps?.pool) {
    return {
      pool: deps.pool,
      shouldClose: false,
    };
  }

  const env = deps?.env ?? process.env;
  const rawUrl = env.DATABASE_URL;

  const requireLocal =
    deps?.requireLocalhost ??
    (env.OPERATOR_REQUIRE_LOCALHOST === 'true');

  const connectionString = validateDatabaseUrl(rawUrl ?? '', {
    requireLocalhost: requireLocal,
  });

  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  return {
    pool,
    shouldClose: true,
  };
}

/**
 * Deterministically resolves or provisions the workspace for the verified GitHub operator.
 * Uses the exact existing getOrCreateOwnerWorkspace pattern.
 */
export async function resolveOperatorWorkspace(
  pool: pg.Pool,
  user: GitHubUser
): Promise<{ user: User; workspace: Workspace }> {
  return await getOrCreateOwnerWorkspace(pool, {
    user: {
      id: user.id,
      name: user.name || user.login,
      email: user.email,
      image: user.avatarUrl,
    },
    githubUserId: user.id,
  });
}
