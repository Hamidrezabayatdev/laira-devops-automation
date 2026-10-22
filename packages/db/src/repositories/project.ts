import crypto from 'node:crypto';
import pg from 'pg';
import type { WorkspaceScope } from './workspace.js';

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export type { WorkspaceScope };

export interface CreateProjectParams {
  id?: string;
  name: string;
  slug: string;
}

export async function createProject(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  params: CreateProjectParams
): Promise<Project> {
  const id = params.id || `proj_${crypto.randomUUID().replace(/-/g, '')}`;
  const res = await poolOrClient.query(
    `INSERT INTO app.projects (id, workspace_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING *`,
    [id, workspace.workspaceId, params.name, params.slug]
  );
  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getProject(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  projectId: string
): Promise<Project | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.projects
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [projectId, workspace.workspaceId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProjects(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope
): Promise<Project[]> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.projects
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspace.workspaceId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
