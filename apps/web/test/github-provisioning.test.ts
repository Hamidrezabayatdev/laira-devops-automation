import { describe, it, expect } from 'vitest';
import {
  provisionOwnerWorkspace,
  validateGitHubNumericId,
  isConfiguredDemoOwner,
  GitHubNumericIdSchema,
} from '@/lib/auth/github-provisioning';

describe('GitHub Owner Workspace Provisioning', () => {
  it('accepts valid numeric GitHub IDs and provisions exactly one owner workspace', () => {
    const numericId = '152868728';
    const workspace = provisionOwnerWorkspace(numericId);

    expect(workspace.workspaceId).toBe('ws_gh_152868728');
    expect(workspace.githubNumericId).toBe('152868728');
    expect(workspace.role).toBe('owner');
    expect(workspace.provisionedAt).toBeDefined();
  });

  it('accepts numeric numbers and converts to string', () => {
    const workspace = provisionOwnerWorkspace(987654321);
    expect(workspace.workspaceId).toBe('ws_gh_987654321');
    expect(workspace.githubNumericId).toBe('987654321');
  });

  it('rejects usernames, emails, or non-numeric strings', () => {
    expect(() => provisionOwnerWorkspace('octocat')).toThrow(/invalid GitHub numeric ID/);
    expect(() => provisionOwnerWorkspace('user@example.com')).toThrow(/invalid GitHub numeric ID/);
    expect(() => provisionOwnerWorkspace('gh-12345')).toThrow(/invalid GitHub numeric ID/);
    expect(() => provisionOwnerWorkspace('')).toThrow(/invalid GitHub numeric ID/);
  });

  it('identifies the configured demo owner correctly', () => {
    expect(isConfiguredDemoOwner('152868728')).toBe(true);
    expect(isConfiguredDemoOwner('999999999')).toBe(false);
  });

  it('validates strictly with Zod GitHubNumericIdSchema', () => {
    expect(validateGitHubNumericId('152868728')).toBe('152868728');
    expect(() => validateGitHubNumericId('invalid')).toThrow();
    expect(GitHubNumericIdSchema.safeParse('152868728').success).toBe(true);
    expect(GitHubNumericIdSchema.safeParse('user-id').success).toBe(false);
    expect(GitHubNumericIdSchema.safeParse('1528a68728').success).toBe(false);
  });
});
