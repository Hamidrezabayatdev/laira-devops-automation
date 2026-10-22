import { describe, it, expect, beforeAll } from 'vitest';
import { POST as createRunRoute, GET as listRunsRoute } from '@/app/api/runs/route';
import { GET as getRunRoute } from '@/app/api/runs/[id]/route';
import { POST as cancelRunRoute } from '@/app/api/runs/[id]/cancel/route';
import { createTestSession } from './helpers/test-session';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('Runs API Routes End-to-End', () => {
  let authHeaders: Record<string, string>;
  let primaryWorkspaceId: string;

  beforeAll(async () => {
    const session = await createTestSession({ githubNumericId: '152868728' });
    primaryWorkspaceId = session.workspaceId;
    authHeaders = {
      ...session.headers,
      'Content-Type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
    };
  });

  it('POST /api/runs returns 202 Accepted and creates durable run', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'اجرای آزمایشی فیچر',
        type: 'demo_fixture',
        // Caller tries to inject a foreign workspaceId
        workspaceId: 'ws_hacked_injected',
      }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(202);

    const data = await res.json();
    expect(data.run).toBeDefined();
    expect(data.run.runId).toMatch(/^run_/);
    expect(data.run.state).toBe('queued');
    // Enforces session workspace, ignores caller-injected workspaceId
    expect(data.run.workspaceId).toBe(primaryWorkspaceId);
  });

  it('POST /api/runs blocks cross-origin requests with 403', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil-site.com',
        host: 'api.liara.ir',
      },
      body: JSON.stringify({ title: 'حمله CSRF' }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(403);
  });

  it('GET /api/runs lists runs for the authenticated workspace', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: authHeaders,
    });

    const res = await listRunsRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs.length).toBeGreaterThan(0);
  });

  it('GET /api/runs/[id] strictly isolates runs across workspaces', async () => {
    // 1. Create a run with user 152868728
    const createReq = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'تست ایزولاسیون' }),
    });
    const createRes = await createRunRoute(createReq);
    const { run } = await createRes.json();

    // 2. Query with the same user -> 200
    const getReqSame = new Request(`http://localhost:3000/api/runs/${run.runId}`, {
      method: 'GET',
      headers: authHeaders,
    });
    const getResSame = await getRunRoute(getReqSame, {
      params: Promise.resolve({ id: run.runId }),
    });
    expect(getResSame.status).toBe(200);

    // 3. Query with a different user (e.g. 999999999) -> 404 (not found in tenant workspace)
    const diffSession = await createTestSession({ githubNumericId: '999999999' });
    const getReqDiff = new Request(`http://localhost:3000/api/runs/${run.runId}`, {
      method: 'GET',
      headers: diffSession.headers,
    });
    const getResDiff = await getRunRoute(getReqDiff, {
      params: Promise.resolve({ id: run.runId }),
    });
    expect(getResDiff.status).toBe(404);
  });

  it('POST /api/runs/[id]/cancel cancels the run', async () => {
    // 1. Create run
    const createReq = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'اجرا برای لغو' }),
    });
    const createRes = await createRunRoute(createReq);
    const { run } = await createRes.json();

    // 2. Cancel run
    const cancelReq = new Request(`http://localhost:3000/api/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: authHeaders,
    });
    const cancelRes = await cancelRunRoute(cancelReq, {
      params: Promise.resolve({ id: run.runId }),
    });

    expect(cancelRes.status).toBe(200);
    const cancelData = await cancelRes.json();
    expect(cancelData.run.state).toBe('cancelled');
  });
});
