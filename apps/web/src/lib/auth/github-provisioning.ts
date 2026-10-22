import { z } from 'zod';

export const GitHubNumericIdSchema = z
  .string()
  .regex(/^\d+$/, 'GitHub provider account ID must be purely numeric');

export interface ProvisionedWorkspace {
  workspaceId: string;
  githubNumericId: string;
  role: 'owner';
  provisionedAt: string;
  name: string;
}

export function validateGitHubNumericId(rawNumericId: string | number): string {
  const numericId = String(rawNumericId).trim();
  const parseResult = GitHubNumericIdSchema.safeParse(numericId);

  if (!parseResult.success) {
    throw new Error(
      `Cannot provision workspace: invalid GitHub numeric ID '${numericId}'. Must be a verified numeric string.`,
    );
  }
  return numericId;
}

/**
 * Automatically provision exactly one owner workspace based ONLY on the verified
 * GitHub provider numeric ID.
 *
 * Usernames, display names, and emails are mutable and unverified for tenant ownership;
 * only the immutable numeric ID from the GitHub OAuth token is used.
 */
export function provisionOwnerWorkspace(rawNumericId: string | number): ProvisionedWorkspace {
  const numericId = validateGitHubNumericId(rawNumericId);

  const workspaceId = `ws_gh_${numericId}`;

  return {
    workspaceId,
    githubNumericId: numericId,
    role: 'owner',
    provisionedAt: new Date().toISOString(),
    name: `فضای کاری ${numericId}`,
  };
}

/**
 * Helper to assert whether a session or user is the designated demo owner.
 * Explicitly matches the configured demo owner GitHub numeric ID from docs/env.
 */
export function isConfiguredDemoOwner(githubNumericId: string): boolean {
  const demoOwnerId = process.env.DEMO_OWNER_GITHUB_ID || '152868728';
  return githubNumericId === demoOwnerId;
}
