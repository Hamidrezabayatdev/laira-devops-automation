import crypto from 'node:crypto';
import pg from 'pg';
import type { CredentialEnvelope } from '@laira/security';
import type { WorkspaceScope } from './workspace.js';

export interface Connection {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  status: string;
  activeVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionCredentialVersion {
  id: string;
  workspaceId: string;
  connectionId: string;
  version: number;
  algorithm: string;
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
  createdAt: Date;
}

export type { WorkspaceScope };

export interface CreateConnectionParams {
  id?: string;
  name: string;
  provider: string;
}

export async function createConnection(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  params: CreateConnectionParams
): Promise<Connection> {
  const id = params.id || `conn_${crypto.randomUUID().replace(/-/g, '')}`;
  const res = await poolOrClient.query(
    `INSERT INTO app.connections (id, workspace_id, name, provider, status, active_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', 1, NOW(), NOW())
     RETURNING *`,
    [id, workspace.workspaceId, params.name, params.provider]
  );
  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    activeVersion: row.active_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnection(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  connectionId: string
): Promise<Connection | null> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.connections
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [connectionId, workspace.workspaceId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    activeVersion: row.active_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnections(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope
): Promise<Connection[]> {
  const res = await poolOrClient.query(
    `SELECT * FROM app.connections
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspace.workspaceId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    activeVersion: row.active_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function addCredentialVersion(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  connectionId: string,
  envelope: CredentialEnvelope
): Promise<ConnectionCredentialVersion> {
  // Ensure connection exists and belongs to this workspace
  const conn = await getConnection(poolOrClient, workspace, connectionId);
  if (!conn) {
    throw new Error(`Connection ${connectionId} not found in workspace ${workspace.workspaceId}`);
  }

  // Envelope workspaceId and connectionId must strictly match context
  if (envelope.workspaceId !== workspace.workspaceId || envelope.connectionId !== connectionId) {
    throw new Error('Credential envelope AAD context mismatch with target workspace and connection');
  }

  const verNum = Number(envelope.version);
  const id = `cred_${crypto.randomUUID().replace(/-/g, '')}`;

  const res = await poolOrClient.query(
    `INSERT INTO app.connection_credential_versions (
       id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING *`,
    [
      id,
      workspace.workspaceId,
      connectionId,
      verNum,
      envelope.algorithm,
      envelope.ciphertext,
      envelope.iv,
      envelope.tag,
      envelope.keyVersion,
    ]
  );

  // Update active_version on connection
  await poolOrClient.query(
    `UPDATE app.connections
     SET active_version = $1, updated_at = NOW()
     WHERE id = $2 AND workspace_id = $3`,
    [verNum, connectionId, workspace.workspaceId]
  );

  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    version: row.version,
    algorithm: row.algorithm,
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
    keyVersion: row.key_version,
    createdAt: row.created_at,
  };
}

export async function getActiveCredentialVersion(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspace: WorkspaceScope,
  connectionId: string
): Promise<ConnectionCredentialVersion | null> {
  const conn = await getConnection(poolOrClient, workspace, connectionId);
  if (!conn) return null;

  const res = await poolOrClient.query(
    `SELECT * FROM app.connection_credential_versions
     WHERE workspace_id = $1 AND connection_id = $2 AND version = $3
     LIMIT 1`,
    [workspace.workspaceId, connectionId, conn.activeVersion]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    version: row.version,
    algorithm: row.algorithm,
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
    keyVersion: row.key_version,
    createdAt: row.created_at,
  };
}
