import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET as authStatusRoute } from '@/app/api/auth/status/route';
import { isAuthConfigured, getMissingAuthConfig } from '@/lib/auth/status';
import { createTestSession } from './helpers/test-session';

describe('Auth Configuration & Status Endpoints', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports missing configuration when required auth envs are absent', () => {
    delete process.env.AUTH_GITHUB_ID;
    delete process.env.AUTH_GITHUB_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;

    expect(isAuthConfigured()).toBe(false);
    const missing = getMissingAuthConfig();
    expect(missing).toContain('AUTH_GITHUB_ID');
    expect(missing).toContain('AUTH_GITHUB_SECRET');
    expect(missing).toContain('AUTH_SECRET');
  });

  it('reports configured when all required env vars are present', () => {
    process.env.AUTH_GITHUB_ID = 'test-client-id';
    process.env.AUTH_GITHUB_SECRET = 'test-client-secret';
    process.env.AUTH_SECRET = 'test-auth-secret';

    expect(isAuthConfigured()).toBe(true);
    expect(getMissingAuthConfig()).toEqual([]);
  });

  it('GET /api/auth/status returns public-safe config info without exposing secrets', async () => {
    process.env.AUTH_GITHUB_ID = 'test-client-id';
    delete process.env.AUTH_GITHUB_SECRET;
    process.env.AUTH_SECRET = 'super-secret-key-12345';

    const req = new Request('http://localhost:3000/api/auth/status', { method: 'GET' });
    const res = await authStatusRoute(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.configured).toBe(false);
    expect(data.missingConfig).toEqual(['AUTH_GITHUB_SECRET']);
    // Secret values must NOT be present in output
    const rawString = JSON.stringify(data);
    expect(rawString).not.toContain('super-secret-key-12345');
    expect(rawString).not.toContain('test-client-id');
    expect(data.authenticated).toBe(false);
  });

  const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

  it.skipIf(!hasDb)('GET /api/auth/status returns user info when valid session is present', async () => {
    const session = await createTestSession({
      githubNumericId: '152868728',
      userName: 'مالک سیستم',
    });

    const req = new Request('http://localhost:3000/api/auth/status', {
      method: 'GET',
      headers: session.headers,
    });
    const res = await authStatusRoute(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.authenticated).toBe(true);
    expect(data.user).toBeDefined();
    expect(data.user.githubNumericId).toBe('152868728');
    expect(data.user.workspaceId).toBe(session.workspaceId);
    expect(data.user.role).toBe('owner');
  });
});
