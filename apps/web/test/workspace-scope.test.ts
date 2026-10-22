import { describe, it, expect } from 'vitest';
import { resolveAuthenticatedWorkspace, extractSessionToken } from '@/lib/auth/session';
import { createTestSession } from './helpers/test-session';

describe('Tenant Workspace Scope & Isolation', () => {
  const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

  it('rejects unauthenticated requests without credentials', async () => {
    const req = new Request('http://localhost:3000/api/runs', { method: 'GET' });
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(false);
    expect(result.status).toBe(401);
  });

  it.skipIf(!hasDb)('rejects fake test_gh or unverified bearer tokens', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        authorization: 'Bearer fake_unregistered_session_token',
      },
    });
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(false);
    expect(result.status).toBe(401);
  });

  it('strictly rejects x-demo-mode header bypass', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        'x-demo-mode': 'true',
      },
    });
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(false);
    expect(result.status).toBe(401);
  });

  it.skipIf(!hasDb)('provisions workspace based strictly on verified token identity', async () => {
    const session = await createTestSession({ githubNumericId: '152868728' });
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: session.headers,
    });
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(true);
    expect(result.user?.workspaceId).toBe(session.workspaceId);
    expect(result.user?.githubNumericId).toBe('152868728');
    expect(result.user?.role).toBe('owner');
  });

  it.skipIf(!hasDb)('IGNORES caller-supplied x-workspace-id header and strictly enforces token workspace', async () => {
    const session = await createTestSession({ githubNumericId: '152868728' });
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        ...session.headers,
        'x-workspace-id': 'ws_victim_workspace_to_hijack',
      },
    });
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(true);
    // MUST NOT equal 'ws_victim_workspace_to_hijack'
    expect(result.user?.workspaceId).toBe(session.workspaceId);
    expect(result.user?.workspaceId).not.toBe('ws_victim_workspace_to_hijack');
  });

  it('safely handles malformed percent-encoded cookies without crashing', async () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        cookie: 'authjs.session-token=%E0%A4%A; malformed=%ZZ',
      },
    });
    // Must safely resolve without throwing URIError
    const token = extractSessionToken(req);
    expect(token).toBeNull();
    const result = await resolveAuthenticatedWorkspace(req);
    expect(result.authenticated).toBe(false);
    expect(result.status).toBe(401);
  });

  it('enforces secure cookie precedence: __Secure- token shadows insecure plain cookie', () => {
    const req = new Request('http://localhost:3000/api/runs', {
      method: 'GET',
      headers: {
        cookie: 'authjs.session-token=insecure_token; __Secure-authjs.session-token=trusted_secure_token',
      },
    });
    const token = extractSessionToken(req);
    expect(token).toBe('trusted_secure_token');
  });
});
