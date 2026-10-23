import crypto from 'node:crypto';
import pg from 'pg';

export interface WorkspaceScope {
  workspaceId: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  githubUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionWorkspaceLookupResult {
  workspace: Workspace;
  user: User;
}

export interface CreateWorkspaceParams {
  id?: string;
  name: string;
  slug: string;
  ownerUserId: string;
  githubUserId: string;
}

export interface GetOrCreateOwnerWorkspaceParams {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  githubUserId: string;
  workspaceName?: string;
  slug?: string;
}

function mapWorkspaceRow(row: any): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerUserId: row.owner_user_id,
    githubUserId: row.github_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isPoolClient(target: pg.Pool | pg.PoolClient): target is pg.PoolClient {
  return typeof (target as pg.PoolClient).release === 'function';
}

function isPool(target: pg.Pool | pg.PoolClient): target is pg.Pool {
  return !isPoolClient(target);
}

/**
 * Reconciles workspace ownership to a verified OAuth user.
 *
 * TRANSACTION CONTRACT:
 * - When called with a `pg.Pool`, automatically checks out a client and manages BEGIN / COMMIT / ROLLBACK.
 * - When called with a checked-out `pg.PoolClient` (discriminated by `client.release`), the caller owns
 *   the connection and its surrounding transaction lifecycle (caller-owned transaction).
 *
 * SECURITY INVARIANTS:
 * 1. Attaches workspace ONLY from verified persisted app.accounts GitHub provider_account_id == workspace.github_user_id.
 * 2. Candidate user must have exactly 1 account proof (fails closed on ambiguity / multiple accounts).
 * 3. Provider account ID must be strictly numeric (/^\d+$/).
 * 4. Rejects if old owner has any OAuth identity or conflicting account.
 * 5. Locks the workspace row (FOR UPDATE) to serialize concurrent operations.
 * 6. Preserves workspace ID, runs, and connections without moving credentials across GitHub identities.
 */
export async function reconcileWorkspaceOwnerForUser(
  poolOrClient: pg.Pool | pg.PoolClient,
  userId: string
): Promise<Workspace | null> {
  const poolMode = isPool(poolOrClient);
  const client = poolMode ? await (poolOrClient as pg.Pool).connect() : (poolOrClient as pg.PoolClient);

  try {
    if (poolMode) {
      await client.query('BEGIN');
    }

    // 1. Check if user already owns a workspace directly
    const existingWsRes = await client.query(
      `SELECT * FROM app.workspaces WHERE owner_user_id = $1 LIMIT 1`,
      [userId]
    );
    if (existingWsRes.rows.length > 0) {
      if (poolMode) await client.query('COMMIT');
      return mapWorkspaceRow(existingWsRes.rows[0]);
    }

    // 2. Candidate proof of identity: check app.accounts for verified GitHub OAuth account
    // Fail closed on missing account or ambiguity / multiple accounts
    const accountsRes = await client.query(
      `SELECT provider, provider_account_id FROM app.accounts WHERE user_id = $1`,
      [userId]
    );

    if (accountsRes.rows.length !== 1) {
      if (poolMode) await client.query('ROLLBACK');
      return null;
    }

    const account = accountsRes.rows[0];
    if (account.provider !== 'github' || !account.provider_account_id || !/^\d+$/.test(account.provider_account_id)) {
      if (poolMode) await client.query('ROLLBACK');
      return null;
    }

    const githubUserId = account.provider_account_id;

    // 3. Lock workspace row with FOR UPDATE to serialize concurrent attempts
    const wsRes = await client.query(
      `SELECT * FROM app.workspaces WHERE github_user_id = $1 FOR UPDATE`,
      [githubUserId]
    );

    if (wsRes.rows.length === 0) {
      if (poolMode) await client.query('ROLLBACK');
      return null;
    }

    const wsRow = wsRes.rows[0];
    if (wsRow.owner_user_id === userId) {
      if (poolMode) await client.query('COMMIT');
      return mapWorkspaceRow(wsRow);
    }

    // 4. Verify old owner has NO conflicting account / other OAuth
    const oldOwnerId = wsRow.owner_user_id;
    const oldOwnerAccountsRes = await client.query(
      `SELECT 1 FROM app.accounts WHERE user_id = $1 LIMIT 1`,
      [oldOwnerId]
    );

    if (oldOwnerAccountsRes.rows.length > 0) {
      // Old owner is an authenticated OAuth user with conflicting account. Fail closed.
      if (poolMode) await client.query('ROLLBACK');
      return null;
    }

    // 5. Reconcile workspace ownership
    const updateRes = await client.query(
      `UPDATE app.workspaces
       SET owner_user_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [userId, wsRow.id]
    );

    if (poolMode) {
      await client.query('COMMIT');
    }

    return mapWorkspaceRow(updateRes.rows[0]);
  } catch (err) {
    if (poolMode) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }
    throw err;
  } finally {
    if (poolMode) {
      client.release();
    }
  }
}

export async function lookupWorkspaceBySessionToken(
  poolOrClient: pg.Pool | pg.PoolClient,
  sessionToken: string
): Promise<SessionWorkspaceLookupResult | null> {
  const query = `
    SELECT
      u.id AS u_id, u.name AS u_name, u.email AS u_email, u.image AS u_image,
      u.created_at AS u_created_at, u.updated_at AS u_updated_at
    FROM app.sessions s
    JOIN app.users u ON s.user_id = u.id
    WHERE s.session_token = $1 AND s.expires > NOW()
    LIMIT 1;
  `;

  const res = await poolOrClient.query(query, [sessionToken]);
  if (res.rows.length === 0) {
    return null;
  }

  const uRow = res.rows[0];
  const user: User = {
    id: uRow.u_id,
    name: uRow.u_name,
    email: uRow.u_email,
    image: uRow.u_image,
    createdAt: uRow.u_created_at,
    updatedAt: uRow.u_updated_at,
  };

  const workspace = await lookupWorkspaceByUserId(poolOrClient, user.id);
  if (!workspace) {
    return null;
  }

  return {
    workspace,
    user,
  };
}

export async function lookupWorkspaceByUserId(
  poolOrClient: pg.Pool | pg.PoolClient,
  userId: string
): Promise<Workspace | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.workspaces WHERE owner_user_id = $1 LIMIT 1`,
    [userId]
  );
  if (res.rows.length > 0) {
    return mapWorkspaceRow(res.rows[0]);
  }

  // Idempotently reconcile workspace if absent for verified OAuth user
  return await reconcileWorkspaceOwnerForUser(poolOrClient, userId);
}

export async function lookupWorkspaceByGitHubId(
  poolOrClient: pg.Pool | pg.PoolClient,
  githubUserId: string
): Promise<Workspace | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.workspaces WHERE github_user_id = $1 LIMIT 1`,
    [githubUserId]
  );
  if (res.rows.length === 0) return null;
  return mapWorkspaceRow(res.rows[0]);
}

export async function createWorkspace(
  poolOrClient: pg.Pool | pg.PoolClient,
  params: CreateWorkspaceParams
): Promise<Workspace> {
  const id = params.id || `ws_${crypto.randomUUID().replace(/-/g, '')}`;
  const res = await poolOrClient.query(
    `INSERT INTO app.workspaces (id, name, slug, owner_user_id, github_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING *`,
    [id, params.name, params.slug, params.ownerUserId, params.githubUserId]
  );
  return mapWorkspaceRow(res.rows[0]);
}

export async function getOrCreateOwnerWorkspace(
  pool: pg.Pool,
  params: GetOrCreateOwnerWorkspaceParams
): Promise<{ user: User; workspace: Workspace }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure user row exists
    let userRes = await client.query(`SELECT * FROM app.users WHERE id = $1`, [params.user.id]);
    let userRow = userRes.rows[0];

    if (!userRow) {
      const insertUserRes = await client.query(
        `INSERT INTO app.users (id, name, email, image, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [params.user.id, params.user.name ?? null, params.user.email ?? null, params.user.image ?? null]
      );
      userRow = insertUserRes.rows[0];
    }

    // 2. Lookup existing workspace by githubUserId WITH ROW LOCK
    let wsRes = await client.query(
      `SELECT * FROM app.workspaces WHERE github_user_id = $1 FOR UPDATE`,
      [params.githubUserId]
    );

    let wsRow = wsRes.rows[0];
    if (!wsRow) {
      const wsId = `ws_${crypto.randomUUID().replace(/-/g, '')}`;
      const defaultName = params.workspaceName || `${params.user.name || 'Owner'}'s Workspace`;
      const defaultSlug =
        params.slug ||
        `workspace-${params.githubUserId.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;

      const insertWsRes = await client.query(
        `INSERT INTO app.workspaces (id, name, slug, owner_user_id, github_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (github_user_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [wsId, defaultName, defaultSlug, userRow.id, params.githubUserId]
      );
      wsRow = insertWsRes.rows[0];
    }

    // Unified owner check (runs for both pre-existing workspace and ON CONFLICT returned workspace):
    if (wsRow.owner_user_id !== userRow.id) {
      // Owner mismatch: check if reconciliation is permitted
      // Invariant 1: Proof of identity for candidate user from app.accounts
      const accountsRes = await client.query(
        `SELECT provider, provider_account_id FROM app.accounts WHERE user_id = $1`,
        [userRow.id]
      );

      // Must have exactly 1 account proof, strictly numeric (/^\d+$/), matching workspace github_user_id and params.githubUserId
      const hasSingleVerifiedGithubAccount =
        accountsRes.rows.length === 1 &&
        accountsRes.rows[0].provider === 'github' &&
        typeof accountsRes.rows[0].provider_account_id === 'string' &&
        /^\d+$/.test(accountsRes.rows[0].provider_account_id) &&
        accountsRes.rows[0].provider_account_id === wsRow.github_user_id &&
        accountsRes.rows[0].provider_account_id === params.githubUserId;

      if (!hasSingleVerifiedGithubAccount) {
        throw new Error('Workspace ownership mismatch: candidate user lacks verified account proof');
      }

      // Invariant 2: Old owner must NOT have any conflicting accounts / other OAuth
      const oldOwnerAccountsRes = await client.query(
        `SELECT 1 FROM app.accounts WHERE user_id = $1 LIMIT 1`,
        [wsRow.owner_user_id]
      );

      if (oldOwnerAccountsRes.rows.length > 0) {
        throw new Error('Workspace ownership mismatch: existing owner has conflicting authenticated account');
      }

      // Reconcile: bind workspace to verified OAuth user
      const updateWsRes = await client.query(
        `UPDATE app.workspaces
         SET owner_user_id = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [userRow.id, wsRow.id]
      );
      wsRow = updateWsRes.rows[0];
    }

    await client.query('COMMIT');

    return {
      user: {
        id: userRow.id,
        name: userRow.name,
        email: userRow.email,
        image: userRow.image,
        createdAt: userRow.created_at,
        updatedAt: userRow.updated_at,
      },
      workspace: mapWorkspaceRow(wsRow),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
