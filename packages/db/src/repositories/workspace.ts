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

export async function lookupWorkspaceBySessionToken(
  poolOrClient: pg.Pool | pg.PoolClient,
  sessionToken: string
): Promise<SessionWorkspaceLookupResult | null> {
  const query = `
    SELECT
      w.id AS w_id, w.name AS w_name, w.slug AS w_slug,
      w.owner_user_id AS w_owner_user_id, w.github_user_id AS w_github_user_id,
      w.created_at AS w_created_at, w.updated_at AS w_updated_at,
      u.id AS u_id, u.name AS u_name, u.email AS u_email, u.image AS u_image,
      u.created_at AS u_created_at, u.updated_at AS u_updated_at
    FROM app.sessions s
    JOIN app.users u ON s.user_id = u.id
    JOIN app.workspaces w ON w.owner_user_id = u.id
    WHERE s.session_token = $1 AND s.expires > NOW()
    LIMIT 1;
  `;

  const res = await poolOrClient.query(query, [sessionToken]);
  if (res.rows.length === 0) {
    return null;
  }

  const row = res.rows[0];
  return {
    workspace: {
      id: row.w_id,
      name: row.w_name,
      slug: row.w_slug,
      ownerUserId: row.w_owner_user_id,
      githubUserId: row.w_github_user_id,
      createdAt: row.w_created_at,
      updatedAt: row.w_updated_at,
    },
    user: {
      id: row.u_id,
      name: row.u_name,
      email: row.u_email,
      image: row.u_image,
      createdAt: row.u_created_at,
      updatedAt: row.u_updated_at,
    },
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
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
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

export async function lookupWorkspaceByGitHubId(
  poolOrClient: pg.Pool | pg.PoolClient,
  githubUserId: string
): Promise<Workspace | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.workspaces WHERE github_user_id = $1 LIMIT 1`,
    [githubUserId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
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
  const row = res.rows[0];
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

    // 2. Lookup existing workspace by githubUserId
    let wsRes = await client.query(
      `SELECT * FROM app.workspaces WHERE github_user_id = $1 LIMIT 1`,
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
         RETURNING *`,
        [wsId, defaultName, defaultSlug, userRow.id, params.githubUserId]
      );
      wsRow = insertWsRes.rows[0];
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
      workspace: {
        id: wsRow.id,
        name: wsRow.name,
        slug: wsRow.slug,
        ownerUserId: wsRow.owner_user_id,
        githubUserId: wsRow.github_user_id,
        createdAt: wsRow.created_at,
        updatedAt: wsRow.updated_at,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
