import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSafeErrorDto } from '@laira/security';
import { runMigrations } from '../src/migrator.js';
import { getOrCreateOwnerWorkspace } from '../src/repositories/workspace.js';
import { createProject } from '../src/repositories/project.js';
import {
  createRun,
  getRun,
  getRunEvents,
  ProjectNotFoundError,
} from '../src/repositories/run.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Advisory Prerequisite: Project/Workspace Binding', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  async function createTrackedWorkspace(name: string, suffix: string) {
    const { user, workspace } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name },
      githubUserId: `gh_bind_${Date.now()}_${suffix}_${Math.floor(Math.random() * 100000)}`,
      workspaceName: `Workspace ${suffix}`,
    });
    trackedWorkspaceIds.add(workspace.id);
    return { user, workspace };
  }

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
  });

  afterEach(async () => {
    if (pool && trackedWorkspaceIds.size > 0) {
      const ids = Array.from(trackedWorkspaceIds);
      await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
    }
  });

  afterAll(async () => {
    if (pool) {
      if (trackedWorkspaceIds.size > 0) {
        const ids = Array.from(trackedWorkspaceIds);
        await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
      }
      await pool.end();
    }
  });

  it.skipIf(!testDbUrl)('repeatedmigrations safe: subsequent runMigrations calls are idempotent', async () => {
    // runMigrations handles advisory locks internally to serialize migration execution safely
    const appliedSecondTime = await runMigrations(pool);
    expect(appliedSecondTime).toEqual([]);
  });

  it.skipIf(!testDbUrl)('introspection verifies pg_get_constraintdef composite FK deletion includes (project_id)', async () => {
    const constraintCheck = await pool.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      WHERE conrelid = 'app.runs'::regclass
        AND conname = 'runs_workspace_project_fkey';
    `);

    expect(constraintCheck.rows.length).toBe(1);
    const def = constraintCheck.rows[0].def;
    expect(def).toContain('FOREIGN KEY (workspace_id, project_id) REFERENCES app.projects(workspace_id, id)');
    // Strictly verify SQL-authoritative deletion semantics: sets ONLY project_id to NULL, not workspace_id
    expect(def).toContain('ON DELETE SET NULL (project_id)');

    // Verify unique constraint on projects(workspace_id, id)
    const uniqueCheck = await pool.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      WHERE conrelid = 'app.projects'::regclass
        AND conname = 'projects_ws_id_unique';
    `);

    expect(uniqueCheck.rows.length).toBe(1);
    expect(uniqueCheck.rows[0].def).toContain('UNIQUE (workspace_id, id)');
  });

  it.skipIf(!testDbUrl)('actual migration 0002 SQL fails closed on corrupted cross-workspace data in disposable schema', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const disposableSchema = `test_corrupt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      await client.query(`CREATE SCHEMA ${disposableSchema}`);

      // Minimal table setup mirroring pre-migration-0002 baseline
      await client.query(`
        CREATE TABLE ${disposableSchema}.projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          CONSTRAINT projects_ws_id_unique UNIQUE (workspace_id, id)
        );
        CREATE TABLE ${disposableSchema}.runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT
        );
      `);

      // Seed valid row and cross-workspace corrupted row (r2 has ws1 but project p2 belongs to ws2)
      await client.query(`
        INSERT INTO ${disposableSchema}.projects (id, workspace_id) VALUES ('p1', 'ws1'), ('p2', 'ws2');
        INSERT INTO ${disposableSchema}.runs (id, workspace_id, project_id) VALUES
          ('r1', 'ws1', 'p1'),
          ('r2', 'ws1', 'p2');
      `);

      // Read the ACTUAL migration file 0002
      const migrationFile = path.resolve(__dirname, '../migrations/0002_runs_project_workspace_fk.sql');
      const actualSql = fs.readFileSync(migrationFile, 'utf8');

      // Remap schema references from app. to disposableSchema.
      const remappedSql = actualSql.replaceAll('app.', `${disposableSchema}.`);

      // Execute actual migration 0002 SQL
      let migrationError: Error | null = null;
      try {
        await client.query(remappedSql);
      } catch (err) {
        migrationError = err as Error;
      }

      // Assert fail-closed behavior with safe diagnostic message
      expect(migrationError).not.toBeNull();
      expect(migrationError?.message).toContain('Migration 0002 aborted: found 1 cross-workspace corrupted run(s)');
      expect(migrationError?.message).toContain('Data violates (workspace_id, project_id) integrity');

      // Transaction rollback ensures zero changes leak or persist
      await client.query('ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  it.skipIf(!testDbUrl)('actual migration 0002 SQL succeeds and adds composite FK on clean data in disposable schema', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const disposableSchema = `test_clean_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      await client.query(`CREATE SCHEMA ${disposableSchema}`);

      await client.query(`
        CREATE TABLE ${disposableSchema}.projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          CONSTRAINT projects_ws_id_unique UNIQUE (workspace_id, id)
        );
        CREATE TABLE ${disposableSchema}.runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT
        );
      `);

      // Seed only clean data
      await client.query(`
        INSERT INTO ${disposableSchema}.projects (id, workspace_id) VALUES ('p1', 'ws1'), ('p2', 'ws2');
        INSERT INTO ${disposableSchema}.runs (id, workspace_id, project_id) VALUES ('r1', 'ws1', 'p1');
      `);

      // Read and execute actual migration file 0002
      const migrationFile = path.resolve(__dirname, '../migrations/0002_runs_project_workspace_fk.sql');
      const actualSql = fs.readFileSync(migrationFile, 'utf8');
      const remappedSql = actualSql.replaceAll('app.', `${disposableSchema}.`);

      await client.query(remappedSql);

      // Verify composite FK constraint was added by the real migration SQL
      const checkFk = await client.query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c
        WHERE conrelid = '${disposableSchema}.runs'::regclass
          AND conname = 'runs_workspace_project_fkey';
      `);

      expect(checkFk.rows.length).toBe(1);
      expect(checkFk.rows[0].def).toContain(`FOREIGN KEY (workspace_id, project_id) REFERENCES ${disposableSchema}.projects(workspace_id, id)`);
      expect(checkFk.rows[0].def).toContain('ON DELETE SET NULL (project_id)');

      await client.query('ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  it.skipIf(!testDbUrl)('foreign project rejected: createRun with foreign projB.id throws static ProjectNotFoundError and writes zero records', async () => {
    const { workspace: wsA } = await createTrackedWorkspace('Owner A', 'foreign_a');
    const { workspace: wsB } = await createTrackedWorkspace('Owner B', 'foreign_b');

    // Create project in Workspace B
    const projB = await createProject(pool, { workspaceId: wsB.id }, {
      name: 'Project B Foreign',
      slug: 'project-b-foreign',
    });

    const foreignCandidateRunId = `run_candidate_foreign_${crypto.randomUUID().replace(/-/g, '')}`;

    let caughtError: unknown = null;
    try {
      // Attempt to create a run in Workspace A specifying Workspace B's actual project ID
      await createRun(pool, { workspaceId: wsA.id }, {
        id: foreignCandidateRunId,
        projectId: projB.id,
        type: 'demo_fixture',
        initialMessage: 'Should not write foreign run',
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ProjectNotFoundError);
    const notFoundErr = caughtError as ProjectNotFoundError;
    expect(notFoundErr.code).toBe('NOT_FOUND');
    expect(notFoundErr.statusCode).toBe(404);

    // Static error message: does NOT echo the foreign project ID, workspace, or reveal foreign existence
    expect(notFoundErr.message).toBe('Project not found');
    expect(notFoundErr.message).not.toContain(projB.id);
    expect(notFoundErr.message).not.toContain(wsB.id);
    expect((notFoundErr as unknown as { projectId?: unknown }).projectId).toBeUndefined();

    // Verify NO run was written for the candidate run ID
    const runCheck = await pool.query(`SELECT * FROM app.runs WHERE id = $1`, [foreignCandidateRunId]);
    expect(runCheck.rows.length).toBe(0);

    // Verify NO run events were written
    const eventCheck = await pool.query(`SELECT * FROM app.run_events WHERE run_id = $1`, [foreignCandidateRunId]);
    expect(eventCheck.rows.length).toBe(0);

    // Verify NO outbox items were written
    const outboxCheck = await pool.query(
      `SELECT * FROM app.outbox WHERE payload->>'runId' = $1`,
      [foreignCandidateRunId]
    );
    expect(outboxCheck.rows.length).toBe(0);
  });

  it.skipIf(!testDbUrl)('secret canary absent: canary passed as projectId is not leaked in static error or serialized safe error', async () => {
    const { workspace: wsA } = await createTrackedWorkspace('Owner Canary', 'canary_test');

    const canaryToken = 'canary_secret_OIDC_TOKEN_DO_NOT_EXPOSE_998877';
    const canaryCandidateRunId = `run_candidate_canary_${crypto.randomUUID().replace(/-/g, '')}`;

    let caughtError: unknown = null;
    try {
      await createRun(pool, { workspaceId: wsA.id }, {
        id: canaryCandidateRunId,
        projectId: canaryToken,
        type: 'demo_fixture',
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ProjectNotFoundError);
    const notFoundErr = caughtError as ProjectNotFoundError;
    expect(notFoundErr.message).toBe('Project not found');
    expect(notFoundErr.message).not.toContain(canaryToken);
    expect((notFoundErr as unknown as { projectId?: unknown }).projectId).toBeUndefined();

    // Serialized safe error DTO must never contain the secret canary
    const safeErrorDto = toSafeErrorDto(caughtError, undefined, [canaryToken]);
    expect(safeErrorDto.message).toBe('Project not found');
    expect(JSON.stringify(safeErrorDto)).not.toContain(canaryToken);
    expect(JSON.stringify(caughtError)).not.toContain(canaryToken);

    // Verify zero writes
    const runCheck = await pool.query(`SELECT * FROM app.runs WHERE id = $1`, [canaryCandidateRunId]);
    expect(runCheck.rows.length).toBe(0);

    const eventCheck = await pool.query(`SELECT * FROM app.run_events WHERE run_id = $1`, [canaryCandidateRunId]);
    expect(eventCheck.rows.length).toBe(0);

    const outboxCheck = await pool.query(
      `SELECT * FROM app.outbox WHERE payload->>'runId' = $1`,
      [canaryCandidateRunId]
    );
    expect(outboxCheck.rows.length).toBe(0);
  });

  it.skipIf(!testDbUrl)('nonexistent project ID rejected with static ProjectNotFoundError', async () => {
    const { workspace: wsA } = await createTrackedWorkspace('Owner Nonexistent', 'nonexistent_test');

    const bogusProjectId = 'proj_does_not_exist_xyz';

    let caught: unknown = null;
    try {
      await createRun(pool, { workspaceId: wsA.id }, {
        projectId: bogusProjectId,
        type: 'demo_fixture',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProjectNotFoundError);
    expect((caught as Error).message).toBe('Project not found');
    expect((caught as unknown as { projectId?: unknown }).projectId).toBeUndefined();
  });

  it.skipIf(!testDbUrl)('sameworkspace succeeds: creates run, initial event, and outbox', async () => {
    const { workspace: wsA } = await createTrackedWorkspace('Owner SameWS', 'same_ws');

    const projA = await createProject(pool, { workspaceId: wsA.id }, {
      name: 'Project Alpha',
      slug: 'project-alpha',
    });

    const run = await createRun(pool, { workspaceId: wsA.id }, {
      projectId: projA.id,
      type: 'demo_fixture',
      input: { key: 'test_val' },
      initialMessage: 'Same workspace run started',
    });

    expect(run.id).toBeDefined();
    expect(run.workspaceId).toBe(wsA.id);
    expect(run.projectId).toBe(projA.id);
    expect(run.status).toBe('queued');

    // Verify run is retrievable via getRun
    const fetched = await getRun(pool, { workspaceId: wsA.id }, run.id);
    expect(fetched?.projectId).toBe(projA.id);
    expect(fetched?.workspaceId).toBe(wsA.id);

    // Verify initial run event was created
    const events = await getRunEvents(pool, { workspaceId: wsA.id }, run.id);
    expect(events.length).toBe(1);
    expect(events[0].seq).toBe(1);
    expect(events[0].type).toBe('run_started');

    // Verify outbox entry was created
    const outboxRes = await pool.query(
      `SELECT * FROM app.outbox WHERE workspace_id = $1 AND payload->>'runId' = $2`,
      [wsA.id, run.id]
    );
    expect(outboxRes.rows.length).toBe(1);
    expect(outboxRes.rows[0].topic).toBe('run.dispatched');
    expect(outboxRes.rows[0].status).toBe('pending');
  });

  it.skipIf(!testDbUrl)('rawSQL foreign pair FKreject: composite foreign key blocks raw INSERT', async () => {
    const { workspace: wsA } = await createTrackedWorkspace('Raw Owner A', 'raw_a');
    const { workspace: wsB } = await createTrackedWorkspace('Raw Owner B', 'raw_b');

    const projB = await createProject(pool, { workspaceId: wsB.id }, {
      name: 'Project B Raw',
      slug: 'project-b-raw',
    });

    const rawRunId = `run_raw_${crypto.randomUUID().replace(/-/g, '')}`;

    let error: (Error & { code?: string; constraint?: string }) | null = null;
    try {
      await pool.query(
        `INSERT INTO app.runs (id, workspace_id, project_id, type, status, input)
         VALUES ($1, $2, $3, 'demo_fixture', 'queued', '{}'::jsonb)`,
        [rawRunId, wsA.id, projB.id]
      );
    } catch (err) {
      error = err as Error & { code?: string; constraint?: string };
    }

    expect(error).not.toBeNull();
    // PostgreSQL error code 23503 is foreign_key_violation
    expect(error?.code).toBe('23503');
    expect(error?.constraint).toBe('runs_workspace_project_fkey');
  });

  it.skipIf(!testDbUrl)('nullfixture works: null or omitted projectId succeeds and preserves transactional outbox', async () => {
    const { workspace } = await createTrackedWorkspace('Null Owner', 'null_fixture');

    // 1. Omitted projectId
    const run1 = await createRun(pool, { workspaceId: workspace.id }, {
      type: 'demo_fixture',
      input: { variant: 'omitted' },
    });
    expect(run1.projectId).toBeNull();
    expect(run1.workspaceId).toBe(workspace.id);

    // 2. Explicit undefined projectId
    const run2 = await createRun(pool, { workspaceId: workspace.id }, {
      projectId: undefined,
      type: 'demo_fixture',
      input: { variant: 'undefined' },
    });
    expect(run2.projectId).toBeNull();

    // Verify transactional outbox populated for both
    const outboxCheck = await pool.query(
      `SELECT * FROM app.outbox WHERE workspace_id = $1 AND payload->>'runId' IN ($2, $3)`,
      [workspace.id, run1.id, run2.id]
    );
    expect(outboxCheck.rows.length).toBe(2);
  });

  it.skipIf(!testDbUrl)('deleting project sets project_id to NULL on existing runs without deleting the run', async () => {
    const { workspace } = await createTrackedWorkspace('Delete Proj Owner', 'del_proj');

    const project = await createProject(pool, { workspaceId: workspace.id }, {
      name: 'To Be Deleted',
      slug: 'to-be-deleted',
    });

    const run = await createRun(pool, { workspaceId: workspace.id }, {
      projectId: project.id,
      type: 'demo_fixture',
    });
    expect(run.projectId).toBe(project.id);

    // Delete the project
    await pool.query(`DELETE FROM app.projects WHERE id = $1`, [project.id]);

    // Verify run still exists, but project_id is set to NULL
    const runAfter = await getRun(pool, { workspaceId: workspace.id }, run.id);
    expect(runAfter).not.toBeNull();
    expect(runAfter?.id).toBe(run.id);
    expect(runAfter?.projectId).toBeNull();
    expect(runAfter?.workspaceId).toBe(workspace.id);
  });
});
