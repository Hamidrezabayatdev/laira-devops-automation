import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { runMigrations } from '../src/migrator.js';
import {
  getOrCreateOwnerWorkspace,
  lookupWorkspaceBySessionToken,
  lookupWorkspaceByGitHubId,
} from '../src/repositories/workspace.js';
import {
  createProject,
  getProject,
  listProjects,
} from '../src/repositories/project.js';
import {
  createConnection,
  getConnection,
  addCredentialVersion,
  getActiveCredentialVersion,
} from '../src/repositories/connection.js';
import {
  createRun,
  getRun,
  cancelRun,
  getRunEvents,
} from '../src/repositories/run.js';
import {
  claimOutboxBatch,
  markOutboxDispatched,
} from '../src/repositories/outbox.js';
import { encryptCredential } from '@laira/security';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Database Multi-Tenant Integration Tests', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping DB integration tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it.skipIf(!testDbUrl)('verifies app, pgboss, and checkpoints schemas are created', async () => {
    const res = await pool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name IN ('app', 'pgboss', 'checkpoints')
      ORDER BY schema_name ASC;
    `);

    const schemas = res.rows.map((r) => r.schema_name);
    expect(schemas).toContain('app');
    expect(schemas).toContain('pgboss');
    expect(schemas).toContain('checkpoints');
  });

  it.skipIf(!testDbUrl)('creates owner workspace from numeric GitHub ID and verifies session lookup', async () => {
    const githubId = String(Math.floor(1000000 + Math.random() * 9000000));
    const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;

    const { user, workspace } = await getOrCreateOwnerWorkspace(pool, {
      user: {
        id: userId,
        name: 'Test GitHub Owner',
        email: `owner-${githubId}@example.com`,
      },
      githubUserId: githubId,
      workspaceName: 'DevOps Primary Workspace',
    });

    expect(workspace.githubUserId).toBe(githubId);
    expect(workspace.ownerUserId).toBe(user.id);

    // Verify lookup by githubUserId
    const foundByGithub = await lookupWorkspaceByGitHubId(pool, githubId);
    expect(foundByGithub?.id).toBe(workspace.id);

    // Create session and verify auth session workspace lookup
    const sessionToken = `ses_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [sessionToken, user.id, expiresAt]
    );

    const lookupRes = await lookupWorkspaceBySessionToken(pool, sessionToken);
    expect(lookupRes).not.toBeNull();
    expect(lookupRes?.workspace.id).toBe(workspace.id);
    expect(lookupRes?.user.id).toBe(user.id);
  });

  it.skipIf(!testDbUrl)('strictly enforces cross-tenant project and connection isolation', async () => {
    const userAId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    const userBId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;

    const { workspace: wsA } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: userAId, name: 'Tenant A' },
      githubUserId: `gh_${Date.now()}_a`,
      workspaceName: 'Workspace A',
    });

    const { workspace: wsB } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: userBId, name: 'Tenant B' },
      githubUserId: `gh_${Date.now()}_b`,
      workspaceName: 'Workspace B',
    });

    // Tenant A creates project
    const projA = await createProject(pool, { workspaceId: wsA.id }, {
      name: 'Project Alpha',
      slug: 'project-alpha',
    });

    // Tenant A can get it
    const getProjA = await getProject(pool, { workspaceId: wsA.id }, projA.id);
    expect(getProjA?.id).toBe(projA.id);

    // Tenant B CANNOT get Tenant A's project (returns null)
    const crossProj = await getProject(pool, { workspaceId: wsB.id }, projA.id);
    expect(crossProj).toBeNull();

    // Tenant B listing projects does not include Tenant A's project
    const listB = await listProjects(pool, { workspaceId: wsB.id });
    expect(listB.find((p) => p.id === projA.id)).toBeUndefined();

    // Tenant A creates encrypted connection
    const masterKey = crypto.randomBytes(32);
    const connA = await createConnection(pool, { workspaceId: wsA.id }, {
      name: 'Liara Prod Connection',
      provider: 'liara',
    });

    const envelope = encryptCredential(
      JSON.stringify({ apiKey: 'secret-key-tenant-a' }),
      masterKey,
      { workspaceId: wsA.id, connectionId: connA.id, version: 1 }
    );

    await addCredentialVersion(pool, { workspaceId: wsA.id }, connA.id, envelope);

    // Tenant A can retrieve active credential
    const credA = await getActiveCredentialVersion(pool, { workspaceId: wsA.id }, connA.id);
    expect(credA?.ciphertext).toBe(envelope.ciphertext);

    // Tenant B cannot access Tenant A's connection or credential
    const crossConn = await getConnection(pool, { workspaceId: wsB.id }, connA.id);
    expect(crossConn).toBeNull();

    const crossCred = await getActiveCredentialVersion(pool, { workspaceId: wsB.id }, connA.id);
    expect(crossCred).toBeNull();
  });

  it.skipIf(!testDbUrl)('atomically creates run + initial event + outbox, and enforces run tenant isolation', async () => {
    const { workspace: wsA } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Run Owner A' },
      githubUserId: `gh_${Date.now()}_run_a`,
    });

    const { workspace: wsB } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Run Owner B' },
      githubUserId: `gh_${Date.now()}_run_b`,
    });

    // Atomic run creation
    const run = await createRun(pool, { workspaceId: wsA.id }, {
      type: 'demo_fixture',
      input: { mode: 'read_only' },
      initialMessage: 'Demo run created',
    });

    expect(run.status).toBe('queued');
    expect(run.workspaceId).toBe(wsA.id);

    // Verify initial event with seq 1 was created
    const events = await getRunEvents(pool, { workspaceId: wsA.id }, run.id);
    expect(events.length).toBe(1);
    expect(events[0].seq).toBe(1);
    expect(events[0].type).toBe('run_started');

    // Tenant B cannot get run or replay events
    const crossRun = await getRun(pool, { workspaceId: wsB.id }, run.id);
    expect(crossRun).toBeNull();

    const crossEvents = await getRunEvents(pool, { workspaceId: wsB.id }, run.id);
    expect(crossEvents.length).toBe(0);

    // Verify outbox was populated atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await claimOutboxBatch(client, 'worker-test-1', 100);

      const foundOutbox = claimed.find((item) => (item.payload as { runId?: string }).runId === run.id);
      expect(foundOutbox).toBeDefined();
      expect(foundOutbox?.status).toBe('claimed');

      if (foundOutbox && foundOutbox.claimedAt) {
        const ok = await markOutboxDispatched(
          client,
          foundOutbox.id,
          'worker-test-1',
          foundOutbox.claimedAt
        );
        expect(ok).toBe(true);
        const check = await client.query(`SELECT status FROM app.outbox WHERE id = $1`, [foundOutbox.id]);
        expect(check.rows[0].status).toBe('dispatched');
      }

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  it.skipIf(!testDbUrl)(
    'uncommitted batch outbox claim rollback safely leaves items pending without stranding claims',
    async () => {
      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Rollback Claim Owner' },
        githubUserId: `gh_rollback_claim_${Date.now()}`,
      });

      const run = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'demo_fixture',
      });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await claimOutboxBatch(client, 'test-rollback-worker', 100);
        const found = claimed.find((item) => (item.payload as { runId?: string }).runId === run.id);
        expect(found).toBeDefined();
        expect(found?.status).toBe('claimed');

        await client.query('ROLLBACK');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const check = await pool.query(
        `SELECT status, claimed_by, claimed_at FROM app.outbox WHERE payload->>'runId' = $1`,
        [run.id]
      );
      expect(check.rows.length).toBe(1);
      expect(check.rows[0].status).toBe('pending');
      expect(check.rows[0].claimed_by).toBeNull();
      expect(check.rows[0].claimed_at).toBeNull();

      await pool.query(`DELETE FROM app.outbox WHERE payload->>'runId' = $1`, [run.id]);
    }
  );

  it.skipIf(!testDbUrl)('cancels a run and records a monotonic run_cancelled event', async () => {
    const { workspace } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Cancel Owner' },
      githubUserId: `gh_${Date.now()}_cancel`,
    });

    const run = await createRun(pool, { workspaceId: workspace.id }, {
      type: 'demo_fixture',
    });

    const cancelled = await cancelRun(pool, { workspaceId: workspace.id }, run.id, 'User clicked stop');
    expect(cancelled?.status).toBe('cancelled');

    const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
    expect(events.length).toBe(2);
    expect(events[1].seq).toBe(2);
    expect(events[1].type).toBe('run_cancelled');
    expect(events[1].payload.reason).toBe('User clicked stop');

    await pool.query(`DELETE FROM app.outbox WHERE workspace_id = $1`, [workspace.id]);
  });
});
