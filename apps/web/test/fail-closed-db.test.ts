import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET as listRunsRoute, POST as createRunRoute } from '@/app/api/runs/route';
import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';

describe('Database Fail-Closed Architecture', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails closed with 503 when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;

    // 1. Session resolution fails closed with 503
    const authReq = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        authorization: 'Bearer any_session_token',
      },
    });
    const authResult = await resolveAuthenticatedWorkspace(authReq);
    expect(authResult.authenticated).toBe(false);
    expect(authResult.status).toBe(503);
    expect(authResult.error).toContain('سرویس پایگاه‌داده در دسترس نیست');

    // 2. GET /api/runs route fails closed with 503
    const getRes = await listRunsRoute(authReq);
    expect(getRes.status).toBe(503);
    const getData = await getRes.json();
    expect(getData.error).toContain('سرویس پایگاه‌داده در دسترس نیست');

    // 3. POST /api/runs route fails closed with 503
    const postReq = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer any_session_token',
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ title: 'تست فیل‌کلوز' }),
    });
    const postRes = await createRunRoute(postReq);
    expect(postRes.status).toBe(503);
    const postData = await postRes.json();
    expect(postData.error).toContain('سرویس پایگاه‌داده در دسترس نیست');
  });
});
