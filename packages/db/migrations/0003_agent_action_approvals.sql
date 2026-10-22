-- Migration 0003: Dedicated agent_action_approvals table for durable execution approval binding
-- Enforces:
-- 1. 1-to-1 unique mapping on source_run_id (an agent_task run can only be approved once).
-- 2. 1-to-1 unique mapping on execution_run_id (an execution run belongs to exactly one approval).
-- 3. Composite foreign keys binding workspace_id to runs(workspace_id, id) to prevent cross-workspace references.
-- 4. Frozen proposal JSONB copy to prevent post-approval drift.
-- 5. dispatched_at tracking for write-ahead single-dispatch claiming.

CREATE TABLE IF NOT EXISTS app.agent_action_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL UNIQUE,
  execution_run_id TEXT NOT NULL UNIQUE,
  proposal_hash TEXT NOT NULL,
  frozen_proposal JSONB NOT NULL,
  owner_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  CONSTRAINT agent_action_approvals_ws_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT agent_action_approvals_ws_source_run_unique UNIQUE (workspace_id, source_run_id),
  CONSTRAINT agent_action_approvals_ws_exec_run_unique UNIQUE (workspace_id, execution_run_id),
  CONSTRAINT agent_action_approvals_source_run_fkey FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES app.runs(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_action_approvals_execution_run_fkey FOREIGN KEY (workspace_id, execution_run_id)
    REFERENCES app.runs(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_action_approvals_ws_idx
  ON app.agent_action_approvals (workspace_id);

CREATE INDEX IF NOT EXISTS agent_action_approvals_exec_idx
  ON app.agent_action_approvals (workspace_id, execution_run_id);

CREATE INDEX IF NOT EXISTS agent_action_approvals_dispatched_idx
  ON app.agent_action_approvals (dispatched_at);
