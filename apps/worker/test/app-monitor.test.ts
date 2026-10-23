import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  validateMonitorAppSlug,
  validateMonitorHealthPath,
  validateMonitorInterval,
  registerAppMonitor,
  getAppMonitor,
  getAppMonitorByTarget,
  listAppMonitors,
  pauseAppMonitor,
  resumeAppMonitor,
  claimDueMonitors,
  recordMonitorCheckResult,
  getOpenIncidentForMonitor,
  listMonitorIncidents,
  type AppMonitor,
  type AppMonitorIncident,
  type WorkspaceScope,
} from '@laira/db';
import {
  performHttpHealthProbe,
  verifyProviderAppState,
  executeDeterministicMonitorCheck,
  AppMonitorService,
} from '../src/app-monitor.js';
import { executeMonitorCommand } from '../src/cli/monitor.js';
import { runMigrations } from '../../../packages/db/src/migrator.js';
import { getOrCreateOwnerWorkspace, createConnection, addCredentialVersion } from '@laira/db';
import { encryptCredential } from '@laira/security';

const DEMO_OPERATOR_ID = '152868728';
const TEST_MASTER_KEY = Buffer.alloc(32, 42).toString('base64url');
const testDbUrl = process.env.TEST_DATABASE_URL;

describe('App Monitor Unit & Contract Tests', () => {
  describe('1. Input & Route Validation', () => {
    it('validates and normalizes valid app slugs', () => {
      expect(validateMonitorAppSlug('my-test-app')).toBe('my-test-app');
      expect(validateMonitorAppSlug('APP-123')).toBe('app-123');
      expect(validateMonitorAppSlug('app_name_01')).toBe('app_name_01');
    });

    it('rejects invalid app slugs (spaces, invalid characters, empty, arbitrary URLs)', () => {
      expect(() => validateMonitorAppSlug('')).toThrow();
      expect(() => validateMonitorAppSlug('   ')).toThrow();
      expect(() => validateMonitorAppSlug('my app')).toThrow();
      expect(() => validateMonitorAppSlug('app/path')).toThrow();
      expect(() => validateMonitorAppSlug('https://evil.com')).toThrow();
      expect(() => validateMonitorAppSlug('app@123')).toThrow();
      expect(() => validateMonitorAppSlug('a'.repeat(65))).toThrow();
    });

    it('validates health paths strictly to "/" or "/api/health"', () => {
      expect(validateMonitorHealthPath('/')).toBe('/');
      expect(validateMonitorHealthPath('/api/health')).toBe('/api/health');
      expect(validateMonitorHealthPath(undefined)).toBe('/');
      expect(validateMonitorHealthPath('')).toBe('/');

      expect(() => validateMonitorHealthPath('/admin')).toThrow();
      expect(() => validateMonitorHealthPath('/healthz')).toThrow();
      expect(() => validateMonitorHealthPath('/metrics')).toThrow();
      expect(() => validateMonitorHealthPath('https://evil.com')).toThrow();
    });

    it('validates and clamps check interval (60s min, 3600s max)', () => {
      expect(validateMonitorInterval(60)).toBe(60);
      expect(validateMonitorInterval(300)).toBe(300);
      expect(validateMonitorInterval(3600)).toBe(3600);
      expect(validateMonitorInterval(undefined)).toBe(60);

      expect(() => validateMonitorInterval(10)).toThrow();
      expect(() => validateMonitorInterval(59)).toThrow();
      expect(() => validateMonitorInterval(3601)).toThrow();
      expect(() => validateMonitorInterval(100.5)).toThrow();
    });
  });

  describe('2. Fixed Deterministic HTTP Health Probe', () => {
    it('probes the fixed https://${slug}.liara.run${path} endpoint and returns ok on 2xx', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        requestedUrl = url;
        return Promise.resolve(
          new Response('OK', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        );
      });

      const res = await performHttpHealthProbe('test-app', '/api/health', {
        fetchFn: mockFetch as any,
      });

      expect(requestedUrl).toBe('https://test-app.liara.run/api/health');
      expect(res.ok).toBe(true);
      expect(res.httpStatus).toBe(200);
    });

    it('manual redirect: rejects 3xx redirects as unhealthy and cancels response body', async () => {
      let bodyCancelled = false;
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('redirect'));
          controller.close();
        },
        cancel() {
          bodyCancelled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          status: 302,
          headers: { Location: 'https://evil.com' },
        })
      );

      const res = await performHttpHealthProbe('test-app', '/', {
        fetchFn: mockFetch as any,
      });

      expect(res.ok).toBe(false);
      expect(res.httpStatus).toBe(302);
      expect(bodyCancelled).toBe(true);
    });

    it('treats 4xx and 5xx HTTP responses as unhealthy', async () => {
      const mockFetch404 = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
      const res404 = await performHttpHealthProbe('test-app', '/', { fetchFn: mockFetch404 as any });
      expect(res404.ok).toBe(false);
      expect(res404.httpStatus).toBe(404);

      const mockFetch500 = vi.fn().mockResolvedValue(new Response('Internal Error', { status: 500 }));
      const res500 = await performHttpHealthProbe('test-app', '/', { fetchFn: mockFetch500 as any });
      expect(res500.ok).toBe(false);
      expect(res500.httpStatus).toBe(500);
    });

    it('cancels response body immediately to prevent resource leakage on large responses', async () => {
      let bodyCancelled = false;
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Hello'));
        },
        cancel() {
          bodyCancelled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          status: 200,
        })
      );

      const res = await performHttpHealthProbe('test-app', '/', { fetchFn: mockFetch as any });
      expect(res.ok).toBe(true);
      expect(bodyCancelled).toBe(true);
    });

    it('handles network connection error without crashing, returning ok: false, httpStatus: null', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      const res = await performHttpHealthProbe('test-app', '/', { fetchFn: mockFetch as any });
      expect(res.ok).toBe(false);
      expect(res.httpStatus).toBeNull();
    });

    it('enforces whole-request timeout on stalled connections', async () => {
      const mockFetch = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));

      const res = await performHttpHealthProbe('test-app', '/', {
        fetchFn: mockFetch as any,
        timeoutMs: 50,
      });
      expect(res.ok).toBe(false);
      expect(res.httpStatus).toBeNull();
    });
  });

  describe('3. Monitor Execution & Pause Behavior', () => {
    it('paused monitor does not dispatch any HTTP request ("no HTTPrequests ifpaused")', async () => {
      const mockFetch = vi.fn();
      const fakeMonitor: AppMonitor = {
        id: 'mon_test_1',
        workspaceId: 'ws_test',
        connectionId: 'conn_test',
        appSlug: 'test-app',
        healthPath: '/',
        intervalSeconds: 60,
        isActive: false, // PAUSED
        nextCheckAt: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastStatus: 'paused',
        lastCheckedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const fakePool: any = { query: vi.fn() };

      const outcome = await executeDeterministicMonitorCheck(fakePool, fakeMonitor, {
        fetchFn: mockFetch as any,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(fakePool.query).not.toHaveBeenCalled();
      expect(outcome.monitor.lastStatus).toBe('paused');
      expect(outcome.probeResult.ok).toBe(false);
    });
  });

  describe('4. Consecutive Failure, Incident Coalescence & Recovery Logic', () => {
    function createMockDbClient() {
      let monitorRow: any = {
        id: 'mon_123',
        workspace_id: 'ws_abc',
        connection_id: 'conn_1',
        app_slug: 'demo-app',
        health_path: '/',
        interval_seconds: 60,
        is_active: true,
        next_check_at: new Date('2026-10-23T12:00:00Z'),
        consecutive_failures: 0,
        consecutive_successes: 0,
        last_status: 'unknown',
        last_checked_at: null,
        claim_token: 'valid_token',
        lease_expires_at: new Date('2026-10-23T12:05:00Z'),
        created_at: new Date(),
        updated_at: new Date(),
      };

      let openIncidentRow: any = null;

      const mockClient: any = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();

          if (normalized.includes('SELECT * FROM app.app_monitors WHERE id = $1 AND claim_token = $2')) {
            const tokenParam = params?.[1];
            const nowParam = params?.[2] ?? new Date();
            const leaseExpired = monitorRow.lease_expires_at && monitorRow.lease_expires_at < nowParam;
            if (tokenParam === monitorRow.claim_token && !leaseExpired) {
              return Promise.resolve({ rows: [{ ...monitorRow }] });
            }
            return Promise.resolve({ rows: [] });
          }

          if (normalized.includes('SELECT * FROM app.app_monitor_incidents WHERE monitor_id = $1 AND status = \'open\'')) {
            if (openIncidentRow && openIncidentRow.status === 'open') {
              return Promise.resolve({ rows: [{ ...openIncidentRow }] });
            }
            return Promise.resolve({ rows: [] });
          }

          if (normalized.includes('INSERT INTO app.app_monitor_incidents')) {
            openIncidentRow = {
              id: params?.[0],
              workspace_id: params?.[1],
              monitor_id: params?.[2],
              status: 'open',
              failure_count: params?.[3],
              evidence: JSON.parse(params?.[4]),
              opened_at: params?.[5],
              last_failed_at: params?.[5],
              resolved_at: null,
            };
            return Promise.resolve({ rows: [{ ...openIncidentRow }] });
          }

          if (normalized.includes('UPDATE app.app_monitor_incidents SET failure_count = $1')) {
            openIncidentRow.failure_count = params?.[0];
            openIncidentRow.last_failed_at = params?.[1];
            openIncidentRow.evidence = JSON.parse(params?.[2]);
            return Promise.resolve({ rows: [{ ...openIncidentRow }] });
          }

          if (normalized.includes('UPDATE app.app_monitor_incidents SET status = \'resolved\'')) {
            openIncidentRow.status = 'resolved';
            openIncidentRow.resolved_at = params?.[0];
            openIncidentRow.evidence = JSON.parse(params?.[1]);
            const resolved = { ...openIncidentRow };
            openIncidentRow = null;
            return Promise.resolve({ rows: [resolved] });
          }

          if (normalized.includes('UPDATE app.app_monitors SET consecutive_failures = $1')) {
            monitorRow.consecutive_failures = params?.[0];
            monitorRow.consecutive_successes = params?.[1];
            monitorRow.last_status = params?.[2];
            monitorRow.last_checked_at = params?.[3];
            monitorRow.next_check_at = params?.[4];
            monitorRow.claim_token = null;
            monitorRow.lease_expires_at = null;
            return Promise.resolve({ rows: [{ ...monitorRow }] });
          }

          return Promise.resolve({ rows: [] });
        }),
      };

      return {
        client: mockClient,
        getMonitor: () => monitorRow,
        getIncident: () => openIncidentRow,
      };
    }

    it('does NOT open incident on 1st or 2nd consecutive failure; opens ONE incident on 3rd failure', async () => {
      const { client, getMonitor, getIncident } = createMockDbClient();
      const now = new Date('2026-10-23T12:00:00Z');

      // Failure 1
      const res1 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'valid_token',
        now,
        httpStatus: 502,
        probeOk: false,
        providerState: 'http_502',
      });
      expect(res1.incidentAction).toBe('none');
      expect(res1.incident).toBeNull();
      expect(getMonitor().consecutive_failures).toBe(1);
      expect(getMonitor().last_status).toBe('degraded');

      // Reset claim for check 2
      getMonitor().claim_token = 'token_2';

      // Failure 2
      const res2 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'token_2',
        now,
        httpStatus: 502,
        probeOk: false,
        providerState: 'http_502',
      });
      expect(res2.incidentAction).toBe('none');
      expect(res2.incident).toBeNull();
      expect(getMonitor().consecutive_failures).toBe(2);

      // Reset claim for check 3
      getMonitor().claim_token = 'token_3';

      // Failure 3 -> OPENS incident!
      const res3 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'token_3',
        now,
        httpStatus: 502,
        probeOk: false,
        providerState: 'http_502',
      });
      expect(res3.incidentAction).toBe('opened');
      expect(res3.incident).not.toBeNull();
      expect(res3.incident?.status).toBe('open');
      expect(res3.incident?.failureCount).toBe(3);
      expect(res3.incident?.evidence.httpStatus).toBe(502);
      expect(res3.incident?.evidence.probeKind).toBe('http');

      // Reset claim for check 4
      getMonitor().claim_token = 'token_4';

      // Failure 4 -> UPDATES existing incident without opening a new one
      const res4 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'token_4',
        now,
        httpStatus: 502,
        probeOk: false,
        providerState: 'http_502',
      });
      expect(res4.incidentAction).toBe('updated');
      expect(res4.incident?.id).toBe(res3.incident?.id);
      expect(res4.incident?.failureCount).toBe(4);
    });

    it('truthful recovery: 3 successes with unconfirmed provider stays recovering; confirmed provider resolves incident', async () => {
      const { client, getMonitor, getIncident } = createMockDbClient();
      const now = new Date('2026-10-23T12:00:00Z');

      // Setup monitor with 2 failures so 3rd failure opens an incident
      getMonitor().consecutive_failures = 2;
      getMonitor().claim_token = 'tok_1';
      await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'tok_1',
        now,
        httpStatus: 500,
        probeOk: false,
        providerState: 'http_500',
      });
      expect(getIncident()?.status).toBe('open');

      // Success 1: monitor status becomes 'recovering', incident remains open
      getMonitor().claim_token = 'tok_s1';
      const s1 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'tok_s1',
        now,
        httpStatus: 200,
        probeOk: true,
        providerState: 'http_ok',
      });
      expect(s1.incidentAction).toBe('none');
      expect(s1.monitor?.lastStatus).toBe('recovering');
      expect(getIncident()?.status).toBe('open');

      // Success 2: stays recovering
      getMonitor().claim_token = 'tok_s2';
      const s2 = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'tok_s2',
        now,
        httpStatus: 200,
        probeOk: true,
        providerState: 'http_ok',
      });
      expect(s2.incidentAction).toBe('none');
      expect(s2.monitor?.lastStatus).toBe('recovering');

      // Success 3 BUT provider recovery NOT confirmed -> stays recovering truthful
      getMonitor().claim_token = 'tok_s3_unconfirmed';
      const s3Unconfirmed = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'tok_s3_unconfirmed',
        now,
        httpStatus: 200,
        probeOk: true,
        providerState: 'unconfirmed',
        providerConfirmedRecovery: false,
      });
      expect(s3Unconfirmed.incidentAction).toBe('none');
      expect(s3Unconfirmed.monitor?.lastStatus).toBe('recovering');
      expect(getIncident()?.status).toBe('open');

      // Success 4 WITH provider recovery confirmed -> resolves incident!
      getMonitor().claim_token = 'tok_s4_confirmed';
      const s4Confirmed = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'tok_s4_confirmed',
        now,
        httpStatus: 200,
        probeOk: true,
        providerState: 'ready',
        providerConfirmedRecovery: true,
      });
      expect(s4Confirmed.incidentAction).toBe('resolved');
      expect(s4Confirmed.monitor?.lastStatus).toBe('healthy');
      expect(s4Confirmed.incident?.status).toBe('resolved');
      expect(s4Confirmed.incident?.resolvedAt).not.toBeNull();
    });

    it('lease write fencing: drops stale check results with invalid or expired claim token', async () => {
      const { client, getMonitor } = createMockDbClient();
      getMonitor().claim_token = 'active_token_123';

      // Attempt write with wrong token
      const staleRes = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'stale_token_xyz',
        now: new Date(),
        httpStatus: 200,
        probeOk: true,
        providerState: 'http_ok',
      });

      expect(staleRes.monitor).toBeNull();
      expect(staleRes.incidentAction).toBe('none');
    });

    it('static evidence safety: never leaks bodies, env tokens or api keys in evidence', async () => {
      const { client, getMonitor } = createMockDbClient();
      getMonitor().claim_token = 'sec_tok';
      getMonitor().consecutive_failures = 2;

      const res = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'sec_tok',
        now: new Date(),
        httpStatus: 500,
        probeOk: false,
        providerState: 'http_error',
      });

      const evidence = res.incident?.evidence as any;
      expect(evidence).toBeDefined();
      expect(Object.keys(evidence).sort()).toEqual(
        ['checkedAt', 'httpStatus', 'probeKind', 'providerState'].sort()
      );
      expect(evidence.probeKind).toBe('http');
      expect(evidence.httpStatus).toBe(500);
      expect(evidence.providerState).toBe('http_error');
      expect(evidence.body).toBeUndefined();
      expect(evidence.token).toBeUndefined();
      expect(evidence.apiKey).toBeUndefined();
    });

    it('stale expiry reject: rejects check result if lease has expired', async () => {
      const { client, getMonitor } = createMockDbClient();
      getMonitor().claim_token = 'expired_tok';
      // Set lease to expired in past
      getMonitor().lease_expires_at = new Date('2020-01-01T00:00:00Z');

      const outcome = await recordMonitorCheckResult(client, {
        monitorId: 'mon_123',
        claimToken: 'expired_tok',
        testLeaseExpiryNow: new Date('2026-10-23T12:00:00Z'),
        httpStatus: 200,
        probeOk: true,
        providerState: 'http_ok',
      });

      expect(outcome.monitor).toBeNull();
      expect(outcome.incidentAction).toBe('none');
    });
  });

  describe('5. CLI executeMonitorCommand Unit Tests', () => {
    function createMockDeps(overrides?: any) {
      const mockClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.includes('SELECT * FROM app.users WHERE id = $1')) {
            return Promise.resolve({ rows: [{ id: DEMO_OPERATOR_ID }] });
          }
          if (normalized.includes('SELECT * FROM app.workspaces WHERE github_user_id = $1')) {
            return Promise.resolve({
              rows: [{ id: 'ws_demo', github_user_id: DEMO_OPERATOR_ID, owner_user_id: DEMO_OPERATOR_ID }],
            });
          }
          if (normalized.includes('BEGIN') || normalized.includes('COMMIT') || normalized.includes('ROLLBACK')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };

      const mockPool: any = {
        query: mockClient.query,
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('api.github.com/user')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 152868728,
                login: 'demo-operator',
                name: 'Demo Operator',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        return Promise.resolve(new Response('OK', { status: 200 }));
      });

      return {
        pool: mockPool,
        fetchFn: mockFetch,
        env: {
          GH_TOKEN: 'gh_test_token',
          DEMO_OWNER_GITHUB_ID: DEMO_OPERATOR_ID,
          DATABASE_URL: 'postgres://localhost/test_db',
        },
        stdout: vi.fn(),
        ...overrides,
      };
    }

    it('requires action argument and fails closed on unknown actions', async () => {
      const deps = createMockDeps();
      await expect(
        executeMonitorCommand({ action: undefined as any }, deps)
      ).rejects.toThrow('Action is required');

      await expect(
        executeMonitorCommand({ action: 'unknown' as any }, deps)
      ).rejects.toThrow('Unknown action');
    });

    it('requires connectionId and appSlug for registration', async () => {
      const deps = createMockDeps();

      await expect(
        executeMonitorCommand({ action: 'register', appId: 'my-app' }, deps)
      ).rejects.toThrow('connectionId is required for registration');

      await expect(
        executeMonitorCommand({ action: 'register', connectionId: 'conn_1' }, deps)
      ).rejects.toThrow('appId or appSlug is required for registration');
    });

    it('CLI safe monitor DTO excludes claimToken and leaseExpiresAt in all responses', async () => {
      const deps = createMockDeps();
      const mockMonitor: AppMonitor = {
        id: 'mon_test',
        workspaceId: 'ws_demo',
        connectionId: 'conn_1',
        appSlug: 'my-app',
        healthPath: '/',
        intervalSeconds: 60,
        isActive: true,
        nextCheckAt: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastStatus: 'healthy',
        lastCheckedAt: new Date(),
        claimToken: 'SECRET_CLAIM_TOKEN',
        leaseExpiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      deps.pool.query.mockImplementation((sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.includes('SELECT * FROM app.users WHERE id = $1')) {
          return Promise.resolve({ rows: [{ id: DEMO_OPERATOR_ID }] });
        }
        if (normalized.includes('SELECT * FROM app.workspaces WHERE github_user_id = $1')) {
          return Promise.resolve({
            rows: [{ id: 'ws_demo', github_user_id: DEMO_OPERATOR_ID, owner_user_id: DEMO_OPERATOR_ID }],
          });
        }
        if (normalized.includes('SELECT * FROM app.connections')) {
          return Promise.resolve({ rows: [{ id: 'conn_1', workspace_id: 'ws_demo', provider: 'liara', status: 'active', active_version: 1 }] });
        }
        if (normalized.includes('INSERT INTO app.app_monitors') || normalized.includes('SELECT * FROM app.app_monitors')) {
          return Promise.resolve({ rows: [{
            id: mockMonitor.id,
            workspace_id: mockMonitor.workspaceId,
            connection_id: mockMonitor.connectionId,
            app_slug: mockMonitor.appSlug,
            health_path: mockMonitor.healthPath,
            interval_seconds: mockMonitor.intervalSeconds,
            is_active: mockMonitor.isActive,
            next_check_at: mockMonitor.nextCheckAt,
            consecutive_failures: mockMonitor.consecutiveFailures,
            consecutive_successes: mockMonitor.consecutiveSuccesses,
            last_status: mockMonitor.lastStatus,
            last_checked_at: mockMonitor.lastCheckedAt,
            claim_token: 'SECRET_CLAIM_TOKEN',
            lease_expires_at: new Date(),
            created_at: mockMonitor.createdAt,
            updated_at: mockMonitor.updatedAt,
          }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const regResult = await executeMonitorCommand({ action: 'register', connectionId: 'conn_1', appId: 'my-app' }, deps);
      expect(regResult.monitor).toBeDefined();
      expect((regResult.monitor as any).claimToken).toBeUndefined();
      expect((regResult.monitor as any).leaseExpiresAt).toBeUndefined();
    });
  });

  describe('6. Provider Verification & Recovery Contracts', () => {
    const validMasterKey = Buffer.alloc(32, 7).toString('base64url');

    function createMockAdapterDeps(adapterOverrides: Partial<any> = {}) {
      const mockAdapter: any = {
        getAppDetail: vi.fn().mockResolvedValue({
          internalId: 'app_1',
          projectId: 'my-app',
          currentReleaseId: 'rel_current',
          status: 'running',
          type: 'node',
          plan: 'standard',
          scale: 1,
          createdAt: '2026-01-01T00:00:00Z',
          envKeys: [],
          hasEnvs: false,
        }),
        getReleaseDetail: vi.fn().mockResolvedValue({
          id: 'rel_current',
          projectId: 'my-app',
          state: 'READY',
          createdAt: '2026-01-02T12:00:00Z',
        }),
        ...adapterOverrides,
      };

      const encryptedEnvelope = encryptCredential(
        Buffer.from(JSON.stringify({ apiKey: 'liara-token-secret' }), 'utf8'),
        validMasterKey,
        { workspaceId: 'ws_test', connectionId: 'conn_test', version: '1', keyVersion: 1 }
      );

      const mockPool: any = {
        query: vi.fn().mockImplementation((sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.includes('SELECT * FROM app.connections')) {
            return Promise.resolve({
              rows: [{ id: 'conn_test', workspace_id: 'ws_test', provider: 'liara', status: 'active', active_version: 1 }],
            });
          }
          if (normalized.includes('SELECT * FROM app.connection_credential_versions')) {
            return Promise.resolve({
              rows: [{
                id: 'cred_1',
                workspace_id: 'ws_test',
                connection_id: 'conn_test',
                version: 1,
                algorithm: encryptedEnvelope.algorithm,
                ciphertext: encryptedEnvelope.ciphertext,
                iv: encryptedEnvelope.iv,
                tag: encryptedEnvelope.tag,
                key_version: encryptedEnvelope.keyVersion,
              }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      return {
        pool: mockPool,
        masterKey: validMasterKey,
        createLiaraAdapter: () => mockAdapter,
        adapter: mockAdapter,
      };
    }

    it('missing explicit current release identity => confirmedRecovery: false and providerState: unconfirmed', async () => {
      const deps = createMockAdapterDeps({
        getAppDetail: vi.fn().mockResolvedValue({
          internalId: 'app_1',
          projectId: 'my-app',
          // NO currentReleaseId
          status: 'running',
        }),
      });

      const res = await verifyProviderAppState(deps.pool, 'ws_test', 'conn_test', 'my-app', deps);
      expect(res.confirmedRecovery).toBe(false);
      expect(res.providerState).toBe('unconfirmed');
    });

    it('explicit current release FAILED => confirmedRecovery: false', async () => {
      const deps = createMockAdapterDeps({
        getAppDetail: vi.fn().mockResolvedValue({
          internalId: 'app_1',
          projectId: 'my-app',
          currentReleaseId: 'rel_failed',
          status: 'running',
        }),
        getReleaseDetail: vi.fn().mockResolvedValue({
          id: 'rel_failed',
          projectId: 'my-app',
          state: 'FAILED',
        }),
      });

      const res = await verifyProviderAppState(deps.pool, 'ws_test', 'conn_test', 'my-app', deps);
      expect(res.confirmedRecovery).toBe(false);
      expect(res.providerState).toBe('failed');
      expect(deps.adapter.getReleaseDetail).toHaveBeenCalledWith('my-app', 'rel_failed');
    });

    it('provider wrong / missing metadata => confirmedRecovery: false', async () => {
      const deps = createMockAdapterDeps({
        getAppDetail: vi.fn().mockResolvedValue({
          projectId: 'different-app-name', // Mismatched ID
        }),
      });

      const res = await verifyProviderAppState(deps.pool, 'ws_test', 'conn_test', 'my-app', deps);
      expect(res.confirmedRecovery).toBe(false);
      expect(res.providerState).toBe('unconfirmed');
    });

    it('canary provider state absent: never interpolates canary IDs or tokens into providerState', async () => {
      const CANARY_ID = 'CANARY_SECRET_RELEASE_ID_99999';
      const deps = createMockAdapterDeps({
        getAppDetail: vi.fn().mockResolvedValue({
          internalId: 'app_1',
          projectId: 'my-app',
          currentReleaseId: CANARY_ID,
          status: 'running',
        }),
        getReleaseDetail: vi.fn().mockResolvedValue({
          id: CANARY_ID,
          projectId: 'my-app',
          state: 'READY',
        }),
      });

      const res = await verifyProviderAppState(deps.pool, 'ws_test', 'conn_test', 'my-app', deps);
      expect(res.confirmedRecovery).toBe(true);
      expect(res.providerState).toBe('ready'); // Strictly static enum, never release_ready:${id}
      expect(res.providerState).not.toContain(CANARY_ID);
    });

    it('validates exact algorithm and keyVersion before decrypt', async () => {
      const deps = createMockAdapterDeps();
      // Tamper algorithm
      deps.pool.query.mockImplementation((sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.includes('SELECT * FROM app.connections')) {
          return Promise.resolve({
            rows: [{ id: 'conn_test', workspace_id: 'ws_test', provider: 'liara', status: 'active', active_version: 1 }],
          });
        }
        if (normalized.includes('SELECT * FROM app.connection_credential_versions')) {
          return Promise.resolve({
            rows: [{
              id: 'cred_1',
              workspace_id: 'ws_test',
              connection_id: 'conn_test',
              version: 1,
              algorithm: 'unsupported-algo',
              ciphertext: 'abc',
              iv: 'def',
              tag: 'ghi',
              key_version: 1,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await verifyProviderAppState(deps.pool, 'ws_test', 'conn_test', 'my-app', deps);
      expect(res.confirmedRecovery).toBe(false);
      expect(res.providerState).toBe('unconfirmed');
    });
  });

  describe('7. Concurrency & Pre-Dispatch Claim Lease Contracts', () => {
    it('concurrent manual/worker regression: exclusive lease allows only ONE HTTP request', async () => {
      let httpRequestsCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        httpRequestsCount++;
        return Promise.resolve(new Response('OK', { status: 200 }));
      });

      let leaseHeld = false;
      const mockPool: any = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.includes('UPDATE app.app_monitors SET claim_token = $1')) {
            if (leaseHeld) {
              return Promise.resolve({ rows: [] }); // Lease already acquired by another worker
            }
            leaseHeld = true;
            return Promise.resolve({ rows: [{ id: 'mon_conc', is_active: true, claim_token: params?.[0] }] });
          }
          if (normalized.includes('SELECT 1 FROM app.app_monitors WHERE id = $1 AND claim_token = $2')) {
            return Promise.resolve({ rows: [{ ok: 1 }] });
          }
          if (normalized.includes('SELECT * FROM app.app_monitors WHERE id = $1 AND claim_token = $2')) {
            return Promise.resolve({ rows: [{ id: 'mon_conc', is_active: true, claim_token: params?.[1] }] });
          }
          if (normalized.includes('UPDATE app.app_monitors SET consecutive_failures = $1')) {
            return Promise.resolve({ rows: [{ id: 'mon_conc', last_status: 'healthy' }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const monitor: AppMonitor = {
        id: 'mon_conc',
        workspaceId: 'ws_conc',
        connectionId: 'conn_conc',
        appSlug: 'conc-app',
        healthPath: '/',
        intervalSeconds: 60,
        isActive: true,
        nextCheckAt: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastStatus: 'unknown',
        lastCheckedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Two concurrent calls attempting to execute check on same monitor
      const [call1, call2] = await Promise.all([
        executeDeterministicMonitorCheck(mockPool, monitor, { fetchFn: mockFetch as any }),
        executeDeterministicMonitorCheck(mockPool, monitor, { fetchFn: mockFetch as any }),
      ]);

      // Exactly ONE HTTP probe dispatched because second call failed to acquire exclusive lease
      expect(httpRequestsCount).toBe(1);
    });

    it('paused stale snapshot => zero HTTP (revalidate active claim before network)', async () => {
      let httpDispatched = false;
      const mockFetch = vi.fn().mockImplementation(() => {
        httpDispatched = true;
        return Promise.resolve(new Response('OK', { status: 200 }));
      });

      const mockPool: any = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.includes('UPDATE app.app_monitors SET claim_token = $1')) {
            return Promise.resolve({ rows: [{ id: 'mon_paused', is_active: true, claim_token: params?.[0] }] });
          }
          if (normalized.includes('SELECT 1 FROM app.app_monitors WHERE id = $1 AND claim_token = $2')) {
            // Monitor was paused while lease was acquired (revalidation fails)
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const monitor: AppMonitor = {
        id: 'mon_paused',
        workspaceId: 'ws_p',
        connectionId: 'conn_p',
        appSlug: 'pause-race-app',
        healthPath: '/',
        intervalSeconds: 60,
        isActive: true, // Initial in-memory snapshot was active
        nextCheckAt: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastStatus: 'unknown',
        lastCheckedAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await executeDeterministicMonitorCheck(mockPool, monitor, { fetchFn: mockFetch as any });

      expect(httpDispatched).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

describe('App Monitor Database Integration Tests (isolated DB)', () => {
  let pool: pg.Pool;
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    if (!testDbUrl) return;

    pool = new pg.Pool({ connectionString: testDbUrl });

    // Run migrations including 0004
    await runMigrations(pool);

    // Provision owner workspace
    const { workspace } = await getOrCreateOwnerWorkspace(pool, {
      user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
      githubUserId: DEMO_OPERATOR_ID,
    });
    workspaceId = workspace.id;

    // Create Liara connection
    const conn = await createConnection(pool, { workspaceId }, {
      name: 'Integration Liara Conn',
      provider: 'liara',
    });
    connectionId = conn.id;

    // Add encrypted credential version
    const ciphertextBuf = Buffer.from('encrypted_payload');
    await addCredentialVersion(pool, { workspaceId }, connectionId, {
      algorithm: 'aes-256-gcm',
      ciphertext: ciphertextBuf.toString('base64'),
      iv: Buffer.alloc(12, 1).toString('base64'),
      tag: Buffer.alloc(16, 2).toString('base64'),
      keyVersion: 1,
      workspaceId,
      connectionId,
      version: '1',
    });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end().catch(() => {});
    }
  });

  it.skipIf(!testDbUrl)('idempotently registers monitor with composite (workspace_id, connection_id, app_slug) constraint', async () => {
    const scope: WorkspaceScope = { workspaceId };

    const mon1 = await registerAppMonitor(pool, scope, {
      connectionId,
      appSlug: 'integration-app',
      healthPath: '/api/health',
      intervalSeconds: 60,
    });

    expect(mon1.appSlug).toBe('integration-app');
    expect(mon1.healthPath).toBe('/api/health');
    expect(mon1.intervalSeconds).toBe(60);
    expect(mon1.isActive).toBe(true);

    // Second registration with same target updates interval and returns same row ID
    const mon2 = await registerAppMonitor(pool, scope, {
      connectionId,
      appSlug: 'integration-app',
      healthPath: '/',
      intervalSeconds: 120,
    });

    expect(mon2.id).toBe(mon1.id);
    expect(mon2.healthPath).toBe('/');
    expect(mon2.intervalSeconds).toBe(120);
  });

  it.skipIf(!testDbUrl)('pauses and resumes monitor; pause survives worker restart', async () => {
    const scope: WorkspaceScope = { workspaceId };
    const mon = await registerAppMonitor(pool, scope, {
      connectionId,
      appSlug: 'pause-test-app',
    });

    const paused = await pauseAppMonitor(pool, scope, mon.id);
    expect(paused?.isActive).toBe(false);
    expect(paused?.lastStatus).toBe('paused');

    // Simulate worker restart reading from DB
    const loaded = await getAppMonitor(pool, scope, mon.id);
    expect(loaded?.isActive).toBe(false);
    expect(loaded?.lastStatus).toBe('paused');

    // Due monitors claim skips paused monitors
    const due = await claimDueMonitors(pool, { now: new Date(Date.now() + 100000) });
    expect(due.some((m) => m.id === mon.id)).toBe(false);

    // Resuming reactivates monitor
    const resumed = await resumeAppMonitor(pool, scope, mon.id);
    expect(resumed?.isActive).toBe(true);
  });

  it.skipIf(!testDbUrl)('atomically claims due monitors with FOR UPDATE SKIP LOCKED and enforces lease expiry', async () => {
    const scope: WorkspaceScope = { workspaceId };
    const mon = await registerAppMonitor(pool, scope, {
      connectionId,
      appSlug: 'claim-test-app',
      intervalSeconds: 60,
    });

    // Make due immediately
    await pool.query('UPDATE app.app_monitors SET next_check_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [mon.id]);

    const claimed = await claimDueMonitors(pool, { now: new Date(), leaseTimeoutSeconds: 120 });
    const match = claimed.find((m) => m.id === mon.id);
    expect(match).toBeDefined();
    expect(match?.claimToken).not.toBeNull();
    expect(match?.leaseExpiresAt).not.toBeNull();

    // Concurrent claim while lease is active should skip this monitor
    const concurrentClaim = await claimDueMonitors(pool, { now: new Date(), leaseTimeoutSeconds: 120 });
    expect(concurrentClaim.some((m) => m.id === mon.id)).toBe(false);
  });

  it.skipIf(!testDbUrl)('enforces database-level constraint: exactly ONE open incident per monitor', async () => {
    const scope: WorkspaceScope = { workspaceId };
    const mon = await registerAppMonitor(pool, scope, {
      connectionId,
      appSlug: 'incident-unique-app',
    });

    const incId1 = `inc_${crypto.randomUUID().replace(/-/g, '')}`;
    const evidence = { httpStatus: 503, probeKind: 'http', providerState: 'http_503', checkedAt: new Date().toISOString() };

    await pool.query(
      `INSERT INTO app.app_monitor_incidents (id, workspace_id, monitor_id, status, failure_count, evidence, opened_at, last_failed_at)
       VALUES ($1, $2, $3, 'open', 3, $4, NOW(), NOW())`,
      [incId1, workspaceId, mon.id, JSON.stringify(evidence)]
    );

    // Attempting to insert a second 'open' incident for the same monitor violates partial unique index
    const incId2 = `inc_${crypto.randomUUID().replace(/-/g, '')}`;
    await expect(
      pool.query(
        `INSERT INTO app.app_monitor_incidents (id, workspace_id, monitor_id, status, failure_count, evidence, opened_at, last_failed_at)
         VALUES ($1, $2, $3, 'open', 3, $4, NOW(), NOW())`,
        [incId2, workspaceId, mon.id, JSON.stringify(evidence)]
      )
    ).rejects.toThrow();
  });
});
