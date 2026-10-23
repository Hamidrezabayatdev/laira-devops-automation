import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { runMigrations } from '../src/migrator.js';
import {
  getOrCreateOwnerWorkspace,
  lookupWorkspaceBySessionToken,
  lookupWorkspaceByUserId,
  lookupWorkspaceByGitHubId,
  reconcileWorkspaceOwnerForUser,
} from '../src/repositories/workspace.js';
import {
  createConnection,
  getConnection,
  addCredentialVersion,
  getActiveCredentialVersion,
} from '../src/repositories/connection.js';
import { createRun, getRun } from '../src/repositories/run.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Secure General Workspace Identity Reconciliation', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping reconciliation tests: TEST_DATABASE_URL is not set.');
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

  it.skipIf(!testDbUrl)(
    'stub seed then OAuth same verified id => existing ws preserved usable, connections retained',
    async () => {
      const githubId = String(Math.floor(10000000 + Math.random() * 90000000));
      const cliUserId = `usr_cli_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // 1. CLI preseed creates local user and workspace (NO row in app.accounts)
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: cliUserId, name: 'CLI Preseed Local User' },
        githubUserId: githubId,
        workspaceName: 'Preseeded Workspace',
      });
      expect(seedWs.ownerUserId).toBe(cliUserId);
      expect(seedWs.githubUserId).toBe(githubId);

      // 2. Add connection to the preseeded workspace
      const conn = await createConnection(pool, { workspaceId: seedWs.id }, {
        name: 'Liara Production Cluster',
        provider: 'liara',
      });
      expect(conn.workspaceId).toBe(seedWs.id);

      // 3. Verified real OAuth user arrives via GitHub OAuth
      const oauthUserId = `usr_oauth_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await pool.query(
        `INSERT INTO app.users (id, name, email, created_at, updated_at)
         VALUES ($1, 'Verified GitHub Developer', $2, NOW(), NOW())`,
        [oauthUserId, `dev-${githubId}@example.com`]
      );

      // Persist verified GitHub account in app.accounts
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [oauthUserId, githubId]
      );

      // Persist active unexpired session
      const sessionToken = `ses_oauth_${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW())`,
        [sessionToken, oauthUserId]
      );

      // 4. Session resolution triggers idempotent reconciliation
      const lookup = await lookupWorkspaceBySessionToken(pool, sessionToken);
      expect(lookup).not.toBeNull();
      expect(lookup?.user.id).toBe(oauthUserId);
      // Workspace ID is preserved
      expect(lookup?.workspace.id).toBe(seedWs.id);
      // Workspace owner is bound to verified OAuth user
      expect(lookup?.workspace.ownerUserId).toBe(oauthUserId);
      expect(lookup?.workspace.githubUserId).toBe(githubId);

      // 5. Existing connection under workspace is preserved and fully accessible
      const fetchedConn = await getConnection(pool, { workspaceId: seedWs.id }, conn.id);
      expect(fetchedConn).not.toBeNull();
      expect(fetchedConn?.id).toBe(conn.id);

      // 6. Old CLI user no longer owns the workspace
      const oldOwnerWs = await lookupWorkspaceByUserId(pool, cliUserId);
      expect(oldOwnerWs).toBeNull();
    }
  );

  it.skipIf(!testDbUrl)(
    'wrong github no adopt: candidate with different github provider_account_id cannot claim workspace',
    async () => {
      const githubIdTarget = String(Math.floor(20000000 + Math.random() * 90000000));
      const githubIdCandidate = String(Math.floor(30000000 + Math.random() * 90000000));
      const originalUserId = `usr_orig_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const candidateUserId = `usr_wrong_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // Seed target workspace
      const { workspace: targetWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: originalUserId, name: 'Original Owner' },
        githubUserId: githubIdTarget,
      });

      // Create candidate user with different GitHub provider account
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Wrong GitHub User', NOW(), NOW())`,
        [candidateUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [candidateUserId, githubIdCandidate]
      );

      // Candidate tries to getOrCreateOwnerWorkspace for target GitHub ID: MUST REJECT!
      await expect(
        getOrCreateOwnerWorkspace(pool, {
          user: { id: candidateUserId },
          githubUserId: githubIdTarget,
        })
      ).rejects.toThrow('Workspace ownership mismatch');

      // Direct reconciliation attempt returns null
      const directReconcile = await reconcileWorkspaceOwnerForUser(pool, candidateUserId);
      expect(directReconcile).toBeNull();

      // Workspace in DB still owned by original user
      const dbWs = await lookupWorkspaceByGitHubId(pool, githubIdTarget);
      expect(dbWs?.ownerUserId).toBe(originalUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'conflicting old account no change: reject adoption if old owner has other OAuth accounts',
    async () => {
      const githubId = String(Math.floor(40000000 + Math.random() * 90000000));
      const oldOAuthProviderId = String(Math.floor(45000000 + Math.random() * 90000000));
      const oldOAuthUserId = `usr_old_oauth_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const newOAuthUserId = `usr_new_oauth_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // 1. Old owner created with an existing OAuth account bound (e.g. another OAuth provider / conflicting identity)
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Old Owner With OAuth', NOW(), NOW())`,
        [oldOAuthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'gitlab', $2, NOW(), NOW())`,
        [oldOAuthUserId, oldOAuthProviderId]
      );
      const { workspace: ws } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: oldOAuthUserId },
        githubUserId: githubId,
      });
      expect(ws.ownerUserId).toBe(oldOAuthUserId);

      // 2. New user arrives claiming githubId with verified GitHub OAuth account
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'New User', NOW(), NOW())`,
        [newOAuthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [newOAuthUserId, githubId]
      );

      // Attempting to adopt must be rejected with static error because old owner already has OAuth account
      await expect(
        getOrCreateOwnerWorkspace(pool, {
          user: { id: newOAuthUserId },
          githubUserId: githubId,
        })
      ).rejects.toThrow('Workspace ownership mismatch: existing owner has conflicting authenticated account');

      const dbWs = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(dbWs?.ownerUserId).toBe(oldOAuthUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'existing CLI helper without persisted OAuth account MUST NOT arbitrarily takeover',
    async () => {
      const githubId = String(Math.floor(50000000 + Math.random() * 90000000));
      const legitimateUserId = `usr_legit_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const rogueCliUserId = `usr_rogue_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // Seed workspace with legitimate user
      const { workspace: initialWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: legitimateUserId, name: 'Legitimate Owner' },
        githubUserId: githubId,
      });
      expect(initialWs.ownerUserId).toBe(legitimateUserId);

      // Same owner calling getOrCreateOwnerWorkspace is normal
      const { workspace: sameWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: legitimateUserId, name: 'Legitimate Owner' },
        githubUserId: githubId,
      });
      expect(sameWs.ownerUserId).toBe(legitimateUserId);

      // Rogue CLI helper without persisted OAuth account attempts takeover: MUST REJECT!
      await expect(
        getOrCreateOwnerWorkspace(pool, {
          user: { id: rogueCliUserId, name: 'Unauthenticated CLI' },
          githubUserId: githubId,
        })
      ).rejects.toThrow('Workspace ownership mismatch: candidate user lacks verified account proof');

      const dbWs = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(dbWs?.ownerUserId).toBe(legitimateUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'fails closed on ambiguity when candidate has multiple accounts',
    async () => {
      const githubId = String(Math.floor(60000000 + Math.random() * 90000000));
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const ambiguousUserId = `usr_ambig_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'Seed Owner' },
        githubUserId: githubId,
      });

      // User with two accounts
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Ambiguous User', NOW(), NOW())`,
        [ambiguousUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [ambiguousUserId, githubId]
      );
      const gitlabProviderId = `gl_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'gitlab', $2, NOW(), NOW())`,
        [ambiguousUserId, gitlabProviderId]
      );

      const res = await reconcileWorkspaceOwnerForUser(pool, ambiguousUserId);
      expect(res).toBeNull();

      const ws = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(ws?.ownerUserId).toBe(seedUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'concurrency: serializes concurrent reconciliation attempts with row-level locks',
    async () => {
      const githubId = String(Math.floor(70000000 + Math.random() * 90000000));
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const verifiedOAuthUserId = `usr_conc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // Seed initial workspace with unauthenticated CLI user
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'Initial Seed' },
        githubUserId: githubId,
      });

      // Insert verified OAuth user and account
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'OAuth User', NOW(), NOW())`,
        [verifiedOAuthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [verifiedOAuthUserId, githubId]
      );

      // Launch 10 concurrent requests to getOrCreateOwnerWorkspace
      const concurrentAttempts = Array.from({ length: 10 }, () =>
        getOrCreateOwnerWorkspace(pool, {
          user: { id: verifiedOAuthUserId, name: 'OAuth User' },
          githubUserId: githubId,
        })
      );

      const results = await Promise.all(concurrentAttempts);

      for (const res of results) {
        expect(res.workspace.id).toBe(seedWs.id);
        expect(res.workspace.ownerUserId).toBe(verifiedOAuthUserId);
      }

      const finalWs = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(finalWs?.id).toBe(seedWs.id);
      expect(finalWs?.ownerUserId).toBe(verifiedOAuthUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'allows user refresh without repeating OAuth flow',
    async () => {
      const githubId = String(Math.floor(80000000 + Math.random() * 90000000));
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const oauthUserId = `usr_refresh_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // 1. CLI seed created workspace
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'CLI Seed' },
        githubUserId: githubId,
      });

      // 2. User finished OAuth: account and unexpired session exist in DB
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'OAuth Refresh User', NOW(), NOW())`,
        [oauthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [oauthUserId, githubId]
      );

      const sessionToken = `ses_refresh_${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour', NOW(), NOW())`,
        [sessionToken, oauthUserId]
      );

      // 3. User refreshes browser (only sends sessionToken, no OAuth signIn event called)
      const firstLookup = await lookupWorkspaceBySessionToken(pool, sessionToken);
      expect(firstLookup).not.toBeNull();
      expect(firstLookup?.workspace.id).toBe(seedWs.id);
      expect(firstLookup?.workspace.ownerUserId).toBe(oauthUserId);

      // 4. Second refresh is idempotent
      const secondLookup = await lookupWorkspaceBySessionToken(pool, sessionToken);
      expect(secondLookup?.workspace.id).toBe(seedWs.id);
      expect(secondLookup?.workspace.ownerUserId).toBe(oauthUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'caller-owned transaction with checked-out PoolClient: explicit BEGIN / reconcile / COMMIT',
    async () => {
      const githubId = String(Math.floor(83000000 + Math.random() * 90000000));
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const oauthUserId = `usr_tx_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'Caller TX Seed' },
        githubUserId: githubId,
      });

      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Caller TX User', NOW(), NOW())`,
        [oauthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [oauthUserId, githubId]
      );

      // Checkout a PoolClient explicitly
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reconciled = await reconcileWorkspaceOwnerForUser(client, oauthUserId);
        expect(reconciled).not.toBeNull();
        expect(reconciled?.id).toBe(seedWs.id);
        expect(reconciled?.ownerUserId).toBe(oauthUserId);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const finalWs = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(finalWs?.ownerUserId).toBe(oauthUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'rejects non-numeric GitHub provider_account_id takeover proof',
    async () => {
      const githubId = `nonnumeric_${Date.now()}`;
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const candidateUserId = `usr_nonnum_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'Seed' },
        githubUserId: githubId,
      });

      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Non-numeric User', NOW(), NOW())`,
        [candidateUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [candidateUserId, githubId]
      );

      await expect(
        getOrCreateOwnerWorkspace(pool, {
          user: { id: candidateUserId },
          githubUserId: githubId,
        })
      ).rejects.toThrow('Workspace ownership mismatch: candidate user lacks verified account proof');

      const direct = await reconcileWorkspaceOwnerForUser(pool, candidateUserId);
      expect(direct).toBeNull();

      const ws = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(ws?.ownerUserId).toBe(seedUserId);
    }
  );

  it.skipIf(!testDbUrl)(
    'preserves fixture runs and encrypted credential refs with workspaceID without needing decrypt',
    async () => {
      const githubId = String(Math.floor(84000000 + Math.random() * 90000000));
      const seedUserId = `usr_seed_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const oauthUserId = `usr_preserve_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // 1. Preseed workspace with CLI user
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: seedUserId, name: 'Seed With Data' },
        githubUserId: githubId,
      });

      // 2. Create connection + credential version reference under seedWs
      const conn = await createConnection(pool, { workspaceId: seedWs.id }, {
        name: 'Encrypted Liara Reference',
        provider: 'liara',
      });

      const envelopeFixture = {
        workspaceId: seedWs.id,
        connectionId: conn.id,
        version: 1,
        keyVersion: 1,
        ciphertext: 'opaque_ciphertext_ref_preserved_without_decrypt',
        iv: 'opaque_iv_123',
        tag: 'opaque_tag_123',
        algorithm: 'aes-256-gcm' as const,
      };

      await addCredentialVersion(pool, { workspaceId: seedWs.id }, conn.id, envelopeFixture);

      // 3. Create run under seedWs
      const run = await createRun(pool, { workspaceId: seedWs.id }, {
        type: 'demo_fixture',
        input: { title: 'Preserved Run' },
        initialMessage: 'Run initialized under preseed workspace',
      });

      expect(run.workspaceId).toBe(seedWs.id);

      // 4. OAuth user arrives and claims workspace
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'OAuth Owner', NOW(), NOW())`,
        [oauthUserId]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [oauthUserId, githubId]
      );

      const reconciled = await reconcileWorkspaceOwnerForUser(pool, oauthUserId);
      expect(reconciled?.id).toBe(seedWs.id);
      expect(reconciled?.ownerUserId).toBe(oauthUserId);

      // 5. Verify run and credential version references are preserved with unchanged workspaceId
      const fetchedRun = await getRun(pool, { workspaceId: seedWs.id }, run.id);
      expect(fetchedRun).not.toBeNull();
      expect(fetchedRun?.workspaceId).toBe(seedWs.id);
      expect(fetchedRun?.id).toBe(run.id);

      const activeCred = await getActiveCredentialVersion(pool, { workspaceId: seedWs.id }, conn.id);
      expect(activeCred).not.toBeNull();
      expect(activeCred?.workspaceId).toBe(seedWs.id);
      expect(activeCred?.connectionId).toBe(conn.id);
      expect(activeCred?.ciphertext).toBe(envelopeFixture.ciphertext);
      expect(activeCred?.keyVersion).toBe(envelopeFixture.keyVersion);
    }
  );
});
