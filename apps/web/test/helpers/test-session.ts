import crypto from 'node:crypto';
import { validateGitHubNumericId } from '@/lib/auth/github-provisioning';
import { dbAdapter } from '@/lib/db/adapter-bridge';

/**
 * Test-only helper to provision a verified test session in the database session repository.
 * Strictly verifies the numeric GitHub ID and registers a valid database session.
 * Placed in test-only directory so runtime source cannot be bypassed.
 */
export async function createTestSession(params: {
  githubNumericId: string;
  userId?: string;
  userName?: string;
  workspaceName?: string;
  expiresInMs?: number;
}): Promise<{
  sessionToken: string;
  workspaceId: string;
  headers: Record<string, string>;
}> {
  const validatedNumericId = validateGitHubNumericId(params.githubNumericId);
  const sessionToken = `test_ses_${crypto.randomUUID().replace(/-/g, '')}`;
  const userId = params.userId || `usr_${validatedNumericId}`;
  const expires = new Date(Date.now() + (params.expiresInMs || 86400000));

  const { workspaceId } = await dbAdapter.createSession({
    sessionToken,
    userId,
    expires,
    githubNumericId: validatedNumericId,
    userName: params.userName,
    workspaceName: params.workspaceName,
  });

  return {
    sessionToken,
    workspaceId,
    headers: {
      cookie: `authjs.session-token=${sessionToken}`,
      authorization: `Bearer ${sessionToken}`,
    },
  };
}
