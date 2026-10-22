import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST as createRunRoute } from '@/app/api/runs/route';
import { dbAdapter } from '@/lib/db/adapter-bridge';

describe('POST /api/runs Strict Bounded Body & Content-Type Validation', () => {
  const mockWorkspaceId = 'ws_mock_test_1';

  const mockLookupResult = {
    sessionToken: 'mock_session_token_1',
    userId: 'usr_mock_1',
    workspaceId: mockWorkspaceId,
    user: {
      id: 'usr_mock_1',
      name: 'Test Dev',
      email: 'dev@liara.ir',
      githubNumericId: '152868728',
    },
    workspace: {
      id: mockWorkspaceId,
      name: 'Test Workspace',
      ownerUserId: 'usr_mock_1',
      githubUserId: '152868728',
    },
  };

  const defaultHeaders = {
    authorization: 'Bearer mock_session_token_1',
    origin: 'http://localhost:3000',
    'content-type': 'application/json',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
  });

  it('rejects requests without application/json content-type with 415', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer mock_session_token_1',
        origin: 'http://localhost:3000',
        'content-type': 'text/plain',
      },
      body: 'title=test',
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(415);
    const data = await res.json();
    expect(data.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects content-type that only contains application/json as substring with 415', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer mock_session_token_1',
        origin: 'http://localhost:3000',
        'content-type': 'text/application/json',
      },
      body: JSON.stringify({ title: 'test' }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(415);
  });

  it('accepts exact application/json with optional parameters like charset', async () => {
    vi.spyOn(dbAdapter, 'createRun').mockResolvedValue({
      id: 'run_123',
      runId: 'run_123',
      workspaceId: mockWorkspaceId,
      title: 'Valid Run',
      type: 'demo_fixture',
      state: 'queued',
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: {
        ...defaultHeaders,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ title: 'Valid Run' }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(202);
  });

  it('rejects empty body with 400', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: '',
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('INVALID_REQUEST_BODY');
  });

  it('rejects malformed JSON syntax with 400', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: '{"title": "incomplete',
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('MALFORMED_JSON');
  });

  it('rejects JSON null literal without crashing', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: 'null',
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects JSON array with 400', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: '[{"title": "test"}]',
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects payload exceeding 16KiB size limit with 413', async () => {
    const largeTitle = 'x'.repeat(17 * 1024);
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ title: largeTitle }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects title longer than 200 characters with 400', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('TITLE_TOO_LONG');
  });

  it('rejects non-allowed run type with 400', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ type: 'unsupported_arbitrary_type' }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('INVALID_RUN_TYPE');
  });

  it('strips secret-bearing metadata fields to prevent secret echoing', async () => {
    let capturedInput: any = null;
    vi.spyOn(dbAdapter, 'createRun').mockImplementation(async (_ws, input) => {
      capturedInput = input;
      return {
        id: 'run_123',
        runId: 'run_123',
        workspaceId: mockWorkspaceId,
        title: input?.title || 'test',
        type: input?.type || 'demo_fixture',
        state: 'queued',
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any;
    });

    const req = new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        title: 'Safe Run',
        type: 'demo_fixture',
        metadata: {
          initiator: 'dashboard_console',
          api_key: 'ghp_secret_token_value',
          user_password: 'supersecretpassword',
          safe_counter: 42,
          is_active: true,
        },
      }),
    });

    const res = await createRunRoute(req);
    expect(res.status).toBe(202);
    expect(capturedInput).toBeDefined();
    // Verify secret fields were stripped from metadata
    expect(capturedInput.metadata.api_key).toBeUndefined();
    expect(capturedInput.metadata.user_password).toBeUndefined();
    // Verify legitimate fixture fields were retained
    expect(capturedInput.metadata.initiator).toBe('dashboard_console');
    expect(capturedInput.metadata.safe_counter).toBe(42);
    expect(capturedInput.metadata.is_active).toBe(true);
  });
});
