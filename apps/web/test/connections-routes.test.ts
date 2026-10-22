import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { GET as getConnectionsRoute, POST as createConnectionRoute } from '@/app/api/connections/route';
import { dbAdapter } from '@/lib/db/adapter-bridge';
import * as securityModule from '@laira/security';
import { decryptCredential } from '@laira/security';
import path from 'node:path';
import { createTestSession } from './helpers/test-session';

const VALID_MASTER_KEY = crypto.randomBytes(32).toString('base64');
const originalEnv = process.env;

describe('Connections API Routes - Unit & MockDB Suite', () => {
  const mockWorkspaceId = 'ws_mock_conn_test_1';
  const mockLookupResult = {
    sessionToken: 'mock_session_token_conn_1',
    userId: 'usr_mock_1',
    workspaceId: mockWorkspaceId,
    user: {
      id: 'usr_mock_1',
      name: 'Owner Dev',
      email: 'owner@liara.ir',
      githubNumericId: '152868728',
    },
    workspace: {
      id: mockWorkspaceId,
      name: 'Test Connections Workspace',
      ownerUserId: 'usr_mock_1',
      githubUserId: '152868728',
    },
  };

  const defaultHeaders = {
    authorization: 'Bearer mock_session_token_conn_1',
    origin: 'http://localhost:3000',
    'content-type': 'application/json',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      AUTH_URL: 'http://localhost:3000',
      ENCRYPTION_MASTER_KEY: VALID_MASTER_KEY,
    };
    vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  describe('Authentication & Authorization', () => {
    it('GET /api/connections returns 401 when no session token is provided', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'GET',
      });
      const res = await getConnectionsRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.code).toBe('UNAUTHORIZED');
    });

    it('POST /api/connections returns 401 when session lookup returns null', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(null);
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست اتصال',
          apiKey: 'test-key',
        }),
      });
      const res = await createConnectionRoute(req);
      expect(res.status).toBe(401);
    });
  });

  describe('Same-Origin & CSRF Protection', () => {
    it('POST /api/connections blocks cross-site Sec-Fetch-Site with 403', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'sec-fetch-site': 'cross-site',
          origin: 'https://evil-attacker.com',
        },
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست',
          apiKey: 'secret',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.code).toBe('ORIGIN_MISMATCH');
    });

    it('POST /api/connections blocks requests missing both Origin and Referer with 403', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: {
          authorization: defaultHeaders.authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست',
          apiKey: 'secret',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(403);
    });
  });

  describe('Server Master Encryption Key Policy', () => {
    it('returns 503 static error when ENCRYPTION_MASTER_KEY is not configured', async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;

      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست اتصال',
          apiKey: 'secret-key-123',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('ENCRYPTION_KEY_UNAVAILABLE');
    });

    it('returns 503 static error when ENCRYPTION_MASTER_KEY is invalid/malformed', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'invalid-short-key';

      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست اتصال',
          apiKey: 'secret-key-123',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('ENCRYPTION_KEY_INVALID');
    });
  });

  describe('Content-Type & Body Bounded Payload (8 KiB)', () => {
    it('returns 415 when Content-Type is text/plain', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'content-type': 'text/plain',
        },
        body: 'provider=liara&apiKey=secret',
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(415);
      const data = await res.json();
      expect(data.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 413 when Content-Length exceeds 8 KiB (8192 bytes)', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'content-length': '9000',
        },
        body: JSON.stringify({
          provider: 'liara',
          name: 'حجم بالا',
          apiKey: 'x'.repeat(4000),
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('returns 400 when body is malformed JSON', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: '{ malformed json',
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('MALFORMED_JSON');
    });
  });

  describe('Schema Validation & Disallow Extra Keys', () => {
    it('returns 400 when extra keys (e.g. teamId, url) are passed', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'اتصال با فیلد اضافه',
          apiKey: 'secret-token',
          teamId: 'team-1234',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('EXTRA_KEYS_DISALLOWED');
    });

    it('returns 400 when provider is not liara or boxapi', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'aws',
          name: 'ارائه‌دهنده نامعتبر',
          apiKey: 'secret-token',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_PROVIDER');
    });

    it('returns 400 when name is missing or exceeds 80 characters', async () => {
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'a'.repeat(81),
          apiKey: 'secret-token',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_NAME');
    });

    it('returns 400 when apiKey is empty or exceeds 4096 characters', async () => {
      const reqEmpty = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'کلید خالی',
          apiKey: '   ',
        }),
      });

      const resEmpty = await createConnectionRoute(reqEmpty);
      expect(resEmpty.status).toBe(400);
      const dataEmpty = await resEmpty.json();
      expect(dataEmpty.code).toBe('INVALID_API_KEY');

      const reqTooLong = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'کلید طولانی',
          apiKey: 'a'.repeat(4097),
        }),
      });

      const resTooLong = await createConnectionRoute(reqTooLong);
      expect(resTooLong.status).toBe(400);
      const dataTooLong = await resTooLong.json();
      expect(dataTooLong.code).toBe('INVALID_API_KEY');
    });
  });

  describe('Atomic Transaction, Encrypt AAD, and Response Absence', () => {
    it.each(['liara', 'boxapi'] as const)('atomically saves a bare %s credential and dispatches the submitted key without leakage', async (provider) => {
      const executedQueries: string[] = [];
      let insertedEnvelope: any = null;

      const mockClient = {
        query: vi.fn().mockImplementation((queryText: string, params?: any[]) => {
          executedQueries.push(queryText.trim());
          if (queryText.includes('INSERT INTO app.connections')) {
            return Promise.resolve({
              rows: [
                {
                  id: params?.[0],
                  workspace_id: params?.[1],
                  name: params?.[2],
                  provider: params?.[3],
                  status: 'active',
                  active_version: 1,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
            });
          }
          if (queryText.includes('SELECT * FROM app.connections')) {
            return Promise.resolve({
              rows: [
                {
                  id: params?.[0],
                  workspace_id: params?.[1],
                  name: 'حساب تست لیارا',
                  provider: 'liara',
                  status: 'active',
                  active_version: 1,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
            });
          }
          if (queryText.includes('INSERT INTO app.connection_credential_versions')) {
            insertedEnvelope = {
              id: params?.[0],
              workspaceId: params?.[1],
              connectionId: params?.[2],
              version: params?.[3],
              algorithm: params?.[4],
              ciphertext: params?.[5],
              iv: params?.[6],
              tag: params?.[7],
              keyVersion: params?.[8],
            };
            return Promise.resolve({
              rows: [{ ...insertedEnvelope, created_at: new Date() }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn(),
      };
      vi.spyOn(dbAdapter, 'getPool').mockReturnValue(mockPool as any);

      const secretToken = 'liara_live_super_secret_token_abcdef123456';
      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider,
          name: 'حساب تست لیارا',
          apiKey: `  ${secretToken}  `,
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(201);

      const data = await res.json();
      // Returns 201 with truthful configured_unverified status
      expect(data.id).toMatch(/^conn_/);
      expect(data.provider).toBe(provider);
      expect(data.status).toBe('configured_unverified');

      // Response Absence: strictly does NOT return ciphertext, tag, iv, or raw apiKey
      expect(data.apiKey).toBeUndefined();
      expect(data.ciphertext).toBeUndefined();
      expect(data.tag).toBeUndefined();
      expect(data.iv).toBeUndefined();
      expect(data.token).toBeUndefined();

      // Transaction atomicity verification
      expect(executedQueries).toContain('BEGIN');
      expect(executedQueries).toContain('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);

      // Verify AAD Encryption: Envelope stored in DB must decrypt with the exact workspace+connection context
      expect(insertedEnvelope).not.toBeNull();
      expect(insertedEnvelope.algorithm).toBe('aes-256-gcm');
      expect(insertedEnvelope.workspaceId).toBe(mockWorkspaceId);
      expect(insertedEnvelope.connectionId).toBe(data.id);
      expect(insertedEnvelope.version).toBe(1);

      // Successfully decrypts with matching context
      const decryptedBuf = decryptCredential(
        insertedEnvelope,
        VALID_MASTER_KEY,
        {
          workspaceId: mockWorkspaceId,
          connectionId: data.id,
          version: 1,
        },
      );
      const rawKey = decryptedBuf.toString('utf8');
      expect(rawKey).toBe(secretToken);

      // Exercise the API-produced plaintext through the actual compiled clients.
      const { LiaraClient, BoxApiClient } = await import(
        path.resolve(__dirname, '../../../packages/providers/dist/index.js')
      );
      let interceptedAuthHeader: string | null = null;
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        interceptedAuthHeader = new Headers(init?.headers).get('Authorization');
        return Response.json(provider === 'liara' ? { projects: [] } : {
          id: 'fixture-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
      if (provider === 'liara') {
        await new LiaraClient({ apiKey: rawKey, fetchFn: mockFetch }).listProjects();
      } else {
        await new BoxApiClient({ apiKey: rawKey, workspaceId: mockWorkspaceId,
          ownerId: 'fixture-owner', fetchFn: mockFetch }).chat({
          runId: 'fixture-credential-boundary', messages: [{ role: 'user', content: 'fixture' }],
        });
      }
      expect(interceptedAuthHeader).toBe(`Bearer ${secretToken}`);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Cross-tenant attacker tampering fails AAD decryption
      expect(() => {
        decryptCredential(
          insertedEnvelope,
          VALID_MASTER_KEY,
          {
            workspaceId: 'ws_foreign_attacker',
            connectionId: data.id,
            version: 1,
          },
        );
      }).toThrow();
    });

    it('returns static 503 when database pool.connect fails without leaking connection diagnostics', async () => {
      const mockPool = {
        connect: vi.fn().mockRejectedValue(new Error('password authentication failed for user "laira" on 127.0.0.1:55433')),
      };
      vi.spyOn(dbAdapter, 'getPool').mockReturnValue(mockPool as any);

      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست خطا اتصال',
          apiKey: 'secret-token-123',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('DB_UNAVAILABLE');
      // Verify no raw database credentials, host, or password diagnostics are leaked
      const rawBody = JSON.stringify(data);
      expect(rawBody).not.toContain('password authentication failed');
      expect(rawBody).not.toContain('55433');
      expect(rawBody).not.toContain('127.0.0.1');
    });

    it('returns static 500 when encryption throws unexpectedly without leaking crypto internals', async () => {
      vi.spyOn(securityModule, 'encryptCredential').mockImplementation(() => {
        throw new Error('OpenSSL internal cipher allocation failed with private buffer');
      });

      const req = new Request('http://localhost:3000/api/connections', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          provider: 'liara',
          name: 'تست خطای رمزنگاری',
          apiKey: 'secret-token-123',
        }),
      });

      const res = await createConnectionRoute(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.code).toBe('ENCRYPTION_FAILED');
      // Verify no raw exception internals are leaked
      const rawBody = JSON.stringify(data);
      expect(rawBody).not.toContain('OpenSSL');
      expect(rawBody).not.toContain('allocation failed');
    });

    it('GET /api/connections returns safe projections without secrets', async () => {
      const mockPool = {
        query: vi.fn().mockImplementation((queryText: string) => {
          if (queryText.includes('SELECT * FROM app.connections')) {
            return Promise.resolve({
              rows: [
                {
                  id: 'conn_test_abc',
                  workspace_id: mockWorkspaceId,
                  name: 'اتصال لیارا پروداکشن',
                  provider: 'liara',
                  status: 'configured_unverified',
                  active_version: 1,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };
      vi.spyOn(dbAdapter, 'getPool').mockReturnValue(mockPool as any);

      const req = new Request('http://localhost:3000/api/connections', {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getConnectionsRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.connections)).toBe(true);
      expect(data.connections).toHaveLength(1);

      const conn = data.connections[0];
      expect(conn.id).toBe('conn_test_abc');
      expect(conn.name).toBe('اتصال لیارا پروداکشن');
      expect(conn.provider).toBe('liara');
      expect(conn.status).toBe('configured_unverified');

      // Response Absence check
      expect(conn.apiKey).toBeUndefined();
      expect(conn.ciphertext).toBeUndefined();
      expect(conn.iv).toBeUndefined();
      expect(conn.tag).toBeUndefined();
      expect(conn.token).toBeUndefined();
    });
  });
});

// Guarded Real Postgres Integration Test Suite
// Strictly requires isolated TEST_DATABASE_URL. Never operates against unverified production DATABASE_URL alone.
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)('Guarded Real Postgres Connections Route Suite', () => {
  const createdConnectionIds: string[] = [];
  const createdSessionTokens: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      AUTH_URL: 'http://localhost:3000',
      ENCRYPTION_MASTER_KEY: VALID_MASTER_KEY,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  afterAll(async () => {
    if (hasTestDb && (createdConnectionIds.length > 0 || createdSessionTokens.length > 0)) {
      try {
        const pool = dbAdapter.getPool();
        for (const connId of createdConnectionIds) {
          await pool.query('DELETE FROM app.connections WHERE id = $1', [connId]);
        }
        for (const sesToken of createdSessionTokens) {
          await pool.query('DELETE FROM app.sessions WHERE session_token = $1', [sesToken]);
        }
      } catch {
        // Safe ignore during teardown
      }
    }
  });

  it('strictly enforces workspace isolation: Tenant A connection is never visible to Tenant B', async () => {
    const sessionA = await createTestSession({ githubNumericId: '152868728' });
    const sessionB = await createTestSession({ githubNumericId: '987654321' });
    createdSessionTokens.push(sessionA.sessionToken, sessionB.sessionToken);

    // 1. Tenant A creates a connection
    const postReqA = new Request('http://localhost:3000/api/connections', {
      method: 'POST',
      headers: {
        ...sessionA.headers,
        'Content-Type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        provider: 'liara',
        name: 'اتصال تستی تننت آ',
        apiKey: 'secret_token_tenant_a',
      }),
    });

    const postResA = await createConnectionRoute(postReqA);
    expect(postResA.status).toBe(201);
    const postDataA = await postResA.json();
    expect(postDataA.id).toMatch(/^conn_/);
    createdConnectionIds.push(postDataA.id);

    // 2. Tenant A GETs connections -> finds the connection
    const getReqA = new Request('http://localhost:3000/api/connections', {
      method: 'GET',
      headers: sessionA.headers,
    });
    const getResA = await getConnectionsRoute(getReqA);
    expect(getResA.status).toBe(200);
    const dataA = await getResA.json();
    const connA = dataA.connections.find((c: any) => c.id === postDataA.id);
    expect(connA).toBeDefined();
    expect(connA.status).toBe('configured_unverified');

    // 3. Tenant B GETs connections -> strictly cannot see Tenant A's connection
    const getReqB = new Request('http://localhost:3000/api/connections', {
      method: 'GET',
      headers: sessionB.headers,
    });
    const getResB = await getConnectionsRoute(getReqB);
    expect(getResB.status).toBe(200);
    const dataB = await getResB.json();
    const crossTenantConn = dataB.connections.find((c: any) => c.id === postDataA.id);
    expect(crossTenantConn).toBeUndefined();
  });

  it('persists bare trimmed API key string in database credential envelope and verifies provider transport', async () => {
    const session = await createTestSession({ githubNumericId: '152868730' });
    createdSessionTokens.push(session.sessionToken);

    const secretApiKey = 'live_secret_key_real_db_regression_abc987654';
    // 1. Genuine API serialization boundary: POST route creates encrypted credential
    const postReq = new Request('http://localhost:3000/api/connections', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        provider: 'liara',
        name: 'اتصال رگرسیون دیتابیس واقعی',
        apiKey: `  ${secretApiKey}  `, // extra spaces to verify trimming
      }),
    });

    const postRes = await createConnectionRoute(postReq);
    expect(postRes.status).toBe(201);
    const postData = await postRes.json();
    expect(postData.id).toMatch(/^conn_/);
    createdConnectionIds.push(postData.id);

    // Verify response does not leak secret or ciphertext
    expect(postData.apiKey).toBeUndefined();
    expect(postData.ciphertext).toBeUndefined();
    expect(JSON.stringify(postData)).not.toContain(secretApiKey);

    // 2. Query persisted credential envelope directly from real DB
    const pool = dbAdapter.getPool();
    const { rows } = await pool.query(
      `SELECT id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version
       FROM app.connection_credential_versions
       WHERE connection_id = $1 AND workspace_id = $2
       ORDER BY version DESC LIMIT 1`,
      [postData.id, session.workspaceId],
    );
    expect(rows.length).toBe(1);
    const row = rows[0];

    const envelope = {
      id: row.id,
      workspaceId: row.workspace_id,
      connectionId: row.connection_id,
      version: row.version,
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
      keyVersion: row.key_version,
    };

    // 3. Decrypt using security and assert bare key string equals submitted trimmed key (NOT JSON)
    const decryptedBuf = decryptCredential(
      envelope,
      VALID_MASTER_KEY,
      {
        workspaceId: session.workspaceId,
        connectionId: postData.id,
        version: row.version,
      },
    );
    const decryptedKey = decryptedBuf.toString('utf8');
    expect(decryptedKey).toBe(secretApiKey);
    // Strict assertion: must NOT be JSON envelope
    expect(() => JSON.parse(decryptedKey)).toThrow();

    // 4. Provider transport assertion: construct Liara client with decrypted key, intercept fetch, assert exact Authorization
    const providersModule = await import(
      path.resolve(__dirname, '../../../packages/providers/dist/index.js')
    );
    const { LiaraClient } = providersModule;

    let interceptedAuthHeader: string | null = null;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      interceptedAuthHeader = headers.get('Authorization');
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new LiaraClient({
      apiKey: decryptedKey,
      fetchFn: mockFetch,
    });
    await client.listProjects();

    expect(interceptedAuthHeader).toBe(`Bearer ${secretApiKey}`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
