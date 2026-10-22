-- Phase 0: Explicit Schemas Reservation
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS pgboss;
CREATE SCHEMA IF NOT EXISTS checkpoints;

-- Identity: Auth.js compatible tables
CREATE TABLE IF NOT EXISTS app.users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT,
  email TEXT UNIQUE,
  email_verified TIMESTAMPTZ,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app.accounts (
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS app.sessions (
  session_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  expires TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app.verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Workspaces: Owner workspace bound to GitHub numeric provider ID
CREATE TABLE IF NOT EXISTS app.workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  github_user_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Projects with workspace composite constraints
CREATE TABLE IF NOT EXISTS app.projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT projects_ws_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT projects_ws_slug_unique UNIQUE (workspace_id, slug)
);

-- Connections and credential versioning with composite workspace constraints
CREATE TABLE IF NOT EXISTS app.connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  active_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT connections_ws_id_unique UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.connection_credential_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES app.connections(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conn_cred_versions_ws_conn_ver_unique UNIQUE (workspace_id, connection_id, version)
);

-- Runs and events with monotonic sequence numbers and composite workspace isolation
CREATE TABLE IF NOT EXISTS app.runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES app.projects(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT runs_ws_id_unique UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.run_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES app.runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT run_events_run_seq_unique UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS run_events_ws_run_seq_idx
  ON app.run_events (workspace_id, run_id, seq);

-- Outbox table for atomic domain events dispatch
CREATE TABLE IF NOT EXISTS app.outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_status_created_idx
  ON app.outbox (status, created_at);

-- Worker heartbeats for worker process liveness tracking
CREATE TABLE IF NOT EXISTS app.worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'alive',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);
