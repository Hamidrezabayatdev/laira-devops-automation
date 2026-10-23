import type { NextAuthConfig } from 'next-auth';
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import {
  getDatabase,
  getDatabasePool,
  getOrCreateOwnerWorkspace,
  lookupWorkspaceByUserId,
  users,
  accounts,
  sessions,
  verificationTokens,
  type Database,
} from '@laira/db';
import { validateGitHubNumericId } from './github-provisioning';

export function isAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_GITHUB_ID &&
    process.env.AUTH_GITHUB_SECRET &&
    (process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET),
  );
}

export function getMissingAuthConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.AUTH_GITHUB_ID) missing.push('AUTH_GITHUB_ID');
  if (!process.env.AUTH_GITHUB_SECRET) missing.push('AUTH_GITHUB_SECRET');
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) missing.push('AUTH_SECRET');
  return missing;
}

export function createSafeDrizzleAdapter(db: Database): Adapter {
  const baseAdapter = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });

  return {
    ...baseAdapter,
    async linkAccount(rawAccount: AdapterAccount): Promise<void> {
      // SECURITY REQUIREMENT:
      // Strip unneeded access_token, refresh_token, and OAuth credentials
      // Sign-in requires no repository grants, no plaintext OAuth tokens stored.
      const { access_token, refresh_token, id_token, session_state, ...safeAccount } = rawAccount;
      if (baseAdapter.linkAccount) {
        await baseAdapter.linkAccount(safeAccount as AdapterAccount);
      }
    },
  };
}

function resolveDrizzleAdapter(): Adapter | undefined {
  try {
    if (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL) {
      const { db } = getDatabase();
      return createSafeDrizzleAdapter(db);
    }
  } catch {
    // Database connection pending or offline
  }
  return undefined;
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  adapter: resolveDrizzleAdapter(),
  session: {
    strategy: 'database',
  },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID ?? '',
      clientSecret: process.env.AUTH_GITHUB_SECRET ?? '',
      profile(profile) {
        const numericId = validateGitHubNumericId(String(profile.id));
        return {
          id: numericId,
          name: profile.name || profile.login,
          email: profile.email,
          image: profile.avatar_url,
          githubNumericId: numericId,
        };
      },
    }),
  ],
  events: {
    async signIn({ user, account }) {
      if (account?.provider === 'github' && account.providerAccountId && user.id) {
        const numericId = validateGitHubNumericId(account.providerAccountId);
        try {
          const pool = getDatabasePool();
          await getOrCreateOwnerWorkspace(pool, {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              image: user.image,
            },
            githubUserId: numericId,
          });
        } catch {
          // Safe static log without leaking raw error objects or credentials
          console.error('Failed to provision workspace on signIn: database operation failed');
        }
      }
    },
  },
  callbacks: {
    async session({ session, user }) {
      if (user?.id) {
        (session as any).user.id = user.id;
        try {
          const pool = getDatabasePool();
          const ws = await lookupWorkspaceByUserId(pool, user.id);
          if (ws) {
            (session as any).workspaceId = ws.id;
            (session as any).githubNumericId = ws.githubUserId;
            (session as any).role = 'owner';
          }
        } catch {
          // DB unavailable
        }
      }
      return session;
    },
  },
  pages: {
    signIn: '/',
    error: '/',
  },
};
