import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { getDatabasePool, getOrCreateOwnerWorkspace, lookupWorkspaceByGitHubId } from '@laira/db';
import { GET as authStatusRoute } from '@/app/api/auth/status/route';
import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

describe('Web Session Resolution & Identity Reconciliation', () => {
  it.skipIf(!hasDb)(
    'reconciles preseeded workspace when OAuth user refreshes browser',
    async () => {
      const pool = getDatabasePool();
      const githubId = String(Math.floor(81000000 + Math.random() * 9000000));
      const cliUserId = `usr_cli_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const oauthUserId = `usr_web_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // 1. CLI preseed created workspace with local user (no app.accounts)
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: cliUserId, name: 'CLI Local Preseed' },
        githubUserId: githubId,
        workspaceName: 'CLI Seed Workspace',
      });
      expect(seedWs.ownerUserId).toBe(cliUserId);

      // 2. User finished OAuth: NextAuth inserted app.users, app.accounts, and app.sessions
      await pool.query(
        `INSERT INTO app.users (id, name, email, created_at, updated_at) VALUES ($1, 'Actual OAuth User', $2, NOW(), NOW())`,
        [oauthUserId, `oauth-${githubId}@example.com`]
      );
      await pool.query(
        `INSERT INTO app.accounts (user_id, type, provider, provider_account_id, created_at, updated_at)
         VALUES ($1, 'oauth', 'github', $2, NOW(), NOW())`,
        [oauthUserId, githubId]
      );
      const sessionToken = `test_ses_reconcile_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW())`,
        [sessionToken, oauthUserId]
      );

      // 3. User refreshes browser without repeating OAuth (GET /api/auth/status)
      const req = new Request('http://localhost:3000/api/auth/status', {
        method: 'GET',
        headers: {
          cookie: `authjs.session-token=${sessionToken}`,
          authorization: `Bearer ${sessionToken}`,
        },
      });

      const res = await authStatusRoute(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.authenticated).toBe(true);
      expect(data.user).toBeDefined();
      expect(data.user.githubNumericId).toBe(githubId);
      expect(data.user.workspaceId).toBe(seedWs.id);
      expect(data.user.role).toBe('owner');

      // 4. Also verify direct session resolution
      const resolution = await resolveAuthenticatedWorkspace(req);
      expect(resolution.authenticated).toBe(true);
      expect(resolution.user?.workspaceId).toBe(seedWs.id);
      expect(resolution.user?.id).toBe(oauthUserId);

      // 5. DB verify: workspace owner is now the verified OAuth user
      const updatedWs = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(updatedWs?.ownerUserId).toBe(oauthUserId);
      expect(updatedWs?.id).toBe(seedWs.id);
    }
  );

  it.skipIf(!hasDb)(
    'rejects reconciliation if session user has no verified GitHub account proof',
    async () => {
      const pool = getDatabasePool();
      const githubId = String(Math.floor(82000000 + Math.random() * 9000000));
      const legitUserId = `usr_legit_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const rogueUserId = `usr_rogue_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      // Seed legitimate workspace
      const { workspace: seedWs } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: legitUserId, name: 'Legit Owner' },
        githubUserId: githubId,
      });
      expect(seedWs.id).toBeDefined();

      // Rogue user has session but NO app.accounts row
      await pool.query(
        `INSERT INTO app.users (id, name, created_at, updated_at) VALUES ($1, 'Rogue User', NOW(), NOW())`,
        [rogueUserId]
      );
      const rogueSessionToken = `test_ses_rogue_${crypto.randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW())`,
        [rogueSessionToken, rogueUserId]
      );

      const req = new Request('http://localhost:3000/api/auth/status', {
        method: 'GET',
        headers: {
          cookie: `authjs.session-token=${rogueSessionToken}`,
        },
      });

      const res = await authStatusRoute(req);
      const data = await res.json();
      expect(data.authenticated).toBe(false);

      // Workspace owner is unchanged
      const ws = await lookupWorkspaceByGitHubId(pool, githubId);
      expect(ws?.ownerUserId).toBe(legitUserId);
    }
  );
});
