-- Migration 0004: App Monitoring & Availability Incidents
-- Enforces:
-- 1. App monitor registration bound strictly to workspace and connection with idempotent (workspace_id, connection_id, app_slug) uniqueness.
-- 2. Health path strictly restricted to '/' or '/api/health' (no arbitrary URLs).
-- 3. Check intervals clamped between 60s and 3600s.
-- 4. Bounded static statuses: 'unknown', 'healthy', 'degraded', 'recovering', 'paused'.
-- 5. Atomic lease fencing columns: claim_token, lease_expires_at.
-- 6. Incidents table with exactly ONE open incident per monitor (enforced via partial unique index).
-- 7. Static incident evidence JSONB storage without bodies or secrets.

CREATE TABLE IF NOT EXISTS app.app_monitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  health_path TEXT NOT NULL DEFAULT '/' CHECK (health_path IN ('/', '/api/health')),
  interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds >= 60 AND interval_seconds <= 3600),
  is_active BOOLEAN NOT NULL DEFAULT true,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN ('unknown', 'healthy', 'degraded', 'recovering', 'paused')),
  last_checked_at TIMESTAMPTZ,
  claim_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_monitors_ws_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT app_monitors_ws_conn_slug_unique UNIQUE (workspace_id, connection_id, app_slug),
  CONSTRAINT app_monitors_ws_conn_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES app.connections (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_monitors_due_idx
  ON app.app_monitors (is_active, next_check_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS app_monitors_ws_idx
  ON app.app_monitors (workspace_id);

CREATE TABLE IF NOT EXISTS app.app_monitor_incidents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  failure_count INTEGER NOT NULL DEFAULT 3 CHECK (failure_count >= 1),
  evidence JSONB NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT app_monitor_incidents_ws_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT app_monitor_incidents_ws_monitor_fkey FOREIGN KEY (workspace_id, monitor_id)
    REFERENCES app.app_monitors (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS app_monitor_incidents_one_open_idx
  ON app.app_monitor_incidents (monitor_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS app_monitor_incidents_ws_idx
  ON app.app_monitor_incidents (workspace_id);

CREATE INDEX IF NOT EXISTS app_monitor_incidents_monitor_idx
  ON app.app_monitor_incidents (monitor_id);
