-- Migration 0002: Enforce composite foreign key runs(workspace_id, project_id) -> projects(workspace_id, id)
-- Fail closed if existing corrupted cross-workspace or unmatched rows exist.

DO $$
DECLARE
  corrupted_count INTEGER;
BEGIN
  -- 1. Ensure unique constraint on projects(workspace_id, id) exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_ws_id_unique'
      AND conrelid = 'app.projects'::regclass
  ) THEN
    ALTER TABLE app.projects ADD CONSTRAINT projects_ws_id_unique UNIQUE (workspace_id, id);
  END IF;

  -- 2. Fail closed if any cross-workspace or invalid references exist in app.runs
  SELECT COUNT(*) INTO corrupted_count
  FROM app.runs r
  WHERE r.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.projects p
      WHERE p.workspace_id = r.workspace_id
        AND p.id = r.project_id
    );

  IF corrupted_count > 0 THEN
    RAISE EXCEPTION 'Migration 0002 aborted: found % cross-workspace corrupted run(s). Data violates (workspace_id, project_id) integrity.', corrupted_count;
  END IF;

  -- 3. Drop legacy single-column FK if present
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_project_id_fkey'
      AND conrelid = 'app.runs'::regclass
  ) THEN
    ALTER TABLE app.runs DROP CONSTRAINT runs_project_id_fkey;
  END IF;

  -- 4. Add composite FK runs(workspace_id, project_id) -> projects(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_workspace_project_fkey'
      AND conrelid = 'app.runs'::regclass
  ) THEN
    ALTER TABLE app.runs
      ADD CONSTRAINT runs_workspace_project_fkey
      FOREIGN KEY (workspace_id, project_id)
      REFERENCES app.projects (workspace_id, id)
      ON DELETE SET NULL (project_id);
  END IF;
END $$;
