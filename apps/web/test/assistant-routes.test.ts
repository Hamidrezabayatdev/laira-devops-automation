import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST as createAssistantTaskRoute } from '@/app/api/assistant/route';
import { GET as getAssistantTaskRoute } from '@/app/api/assistant/[id]/route';
import { dbAdapter } from '@/lib/db/adapter-bridge';
import {
  setAssistantDbAdapter,
  hashDeploymentProposal,
  type AssistantDbAdapter,
  type DeploymentProposal,
} from '@/lib/agent-contract';

describe('Assistant API Routes & Contract Validation', () => {
  const mockWorkspaceId = 'ws_mock_tenant_1';
  const mockForeignWorkspaceId = 'ws_mock_tenant_foreign';

  const mockUserSession = {
    sessionToken: 'mock_session_token_1',
    userId: 'usr_mock_1',
    workspaceId: mockWorkspaceId,
    user: {
      id: 'usr_mock_1',
      name: 'Test DevOps Engineer',
      email: 'devops@liara.ir',
      githubNumericId: '152868728',
    },
    workspace: {
      id: mockWorkspaceId,
      name: 'Test Tenant Workspace',
      ownerUserId: 'usr_mock_1',
      githubUserId: '152868728',
    },
  };

  const defaultHeaders = {
    authorization: 'Bearer mock_session_token_1',
    origin: 'http://localhost:3000',
    host: 'localhost:3000',
    'content-type': 'application/json',
  };

  // In-memory fake DB adapter
  const fakeStore: {
    runs: Record<string, any>;
    events: Record<string, any[]>;
  } = {
    runs: {},
    events: {},
  };

  const fakeDbAdapter: AssistantDbAdapter = {
    async createAgentRun(workspaceId, input) {
      const runId = `run_agent_${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date();
      const run = {
        id: runId,
        workspaceId,
        type: 'agent_task',
        status: 'queued',
        input: {
          task: input.task,
          ...(input.repository ? { repository: input.repository } : {}),
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          ...(input.runtimeEnvironment ? { runtimeEnvironment: input.runtimeEnvironment } : {}),
        },
        output: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      };

      fakeStore.runs[runId] = run;
      fakeStore.events[runId] = [
        {
          id: `evt_1_${runId}`,
          workspaceId,
          runId,
          seq: 1,
          type: 'run_started',
          payload: {
            step: 'init',
            message: `Agent task queued: ${input.task.slice(0, 50)}`,
          },
          createdAt: now,
        },
      ];

      return {
        id: runId,
        status: 'queued',
        createdAt: now,
      };
    },

    async getAgentRun(workspaceId, runId) {
      const run = fakeStore.runs[runId];
      if (!run || run.workspaceId !== workspaceId) {
        return null;
      }
      return run;
    },

    async getAgentRunEvents(workspaceId, runId) {
      const run = fakeStore.runs[runId];
      if (!run || run.workspaceId !== workspaceId) {
        return [];
      }
      return fakeStore.events[runId] || [];
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    fakeDbAdapter.validateConnection = vi.fn().mockResolvedValue({ valid: true });
    fakeDbAdapter.validateRuntimeEnvironment = vi.fn().mockResolvedValue({ valid: true });
    setAssistantDbAdapter(fakeDbAdapter);
    fakeStore.runs = {};
    fakeStore.events = {};
    vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(
      mockUserSession as any,
    );
  });

  // -------------------------------------------------------------------------
  // 1. Authentication & Scope Checks
  // -------------------------------------------------------------------------
  describe('Authentication & Workspace Scoping', () => {
    it('returns 401 when request lacks authorization', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ task: 'بررسی سلامت سرویس' }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when session token is invalid or expired', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(null);

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          authorization: 'Bearer expired_or_fake_token',
        },
        body: JSON.stringify({ task: 'بررسی سلامت سرویس' }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(401);
    });

    it('GET /api/assistant/[id] returns 404 for foreign workspace run', async () => {
      const foreignRun = {
        id: 'run_foreign_123',
        workspaceId: mockForeignWorkspaceId,
        type: 'agent_task',
        status: 'queued',
        input: { task: 'وظیفه دیگران' },
        output: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };
      fakeStore.runs[foreignRun.id] = foreignRun;

      const req = new Request(`http://localhost:3000/api/assistant/${foreignRun.id}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: foreignRun.id }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.code).toBe('RUN_NOT_FOUND');
    });

    it('GET /api/assistant/[id] rejects non-assistant run types (e.g. demo_fixture) with 404', async () => {
      const otherRun = {
        id: 'run_fixture_999',
        workspaceId: mockWorkspaceId,
        type: 'demo_fixture',
        status: 'succeeded',
        input: { title: 'سناریو آزمایشی' },
        output: { fixture: true },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: new Date(),
      };
      fakeStore.runs[otherRun.id] = otherRun;

      const req = new Request(`http://localhost:3000/api/assistant/${otherRun.id}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: otherRun.id }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.code).toBe('RUN_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // 2. CSRF & Origin Verification
  // -------------------------------------------------------------------------
  describe('Origin & CSRF Protection', () => {
    it('returns 403 on untrusted or cross-origin POST', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          origin: 'https://evil-attacker.com',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ task: 'حمله جعل درخواست' }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.code).toBe('ORIGIN_MISMATCH');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Content-Type and Input Validation
  // -------------------------------------------------------------------------
  describe('Payload & Task Input Validation', () => {
    it('rejects unsupported media type with 415', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'content-type': 'text/plain',
        },
        body: 'task=بررسی',
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(415);
      const data = await res.json();
      expect(data.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects payload larger than 16 KiB with 413', async () => {
      const largeTask = 'a'.repeat(17 * 1024);
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'content-length': String(largeTask.length),
        },
        body: JSON.stringify({ task: largeTask }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects malformed JSON syntax with 400', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: '{"task": "broken',
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('MALFORMED_JSON');
    });

    it('rejects missing or empty task with 400 INVALID_TASK', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({ task: '   ' }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_TASK');
    });

    it('rejects task longer than 4000 characters with 400 TASK_TOO_LONG', async () => {
      const longTask = 'x'.repeat(4001);
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({ task: longTask }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('TASK_TOO_LONG');
    });

    it('rejects caller-supplied authority keys with 400 UNAUTHORIZED_FIELD', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی لاگ‌ها',
          workspaceId: 'ws_hacked_injected',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('UNAUTHORIZED_FIELD');
    });

    it('rejects repository owner "." or ".." path traversal with 400 INVALID_REPOSITORY', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'استقرار پروژه',
          repository: {
            owner: '..',
            repo: 'my-app',
          },
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_REPOSITORY');
    });

    it('rejects repository ref with control characters or length > 200 with 400 INVALID_REPOSITORY', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'استقرار پروژه',
          repository: {
            owner: 'org',
            repo: 'app',
            ref: 'feature\x00corrupt',
          },
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_REPOSITORY');
    });

    it('rejects non-https or non-github repository URL with 400 INVALID_REPOSITORY', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'استقرار پروژه',
          repository: 'http://insecure-github.com/owner/repo',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_REPOSITORY');
    });

    it('rejects invalid connectionId format with 400 INVALID_CONNECTION_ID_FORMAT', async () => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت برنامه',
          connectionId: 'conn; DROP TABLE users;--',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_CONNECTION_ID_FORMAT');
    });

    it.each([
      ['string version', '1'],
      ['string with garbage', '1garbage'],
      ['fractional float', 1.5],
      ['null', null],
      ['object', { version: 1 }],
      ['zero', 0],
      ['negative', -1],
    ])('rejects runtimeEnvironment when credentialVersion is %s', async (_, invalidVersion) => {
      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت برنامه',
          runtimeEnvironment: {
            connectionId: 'conn_env_1',
            credentialVersion: invalidVersion,
          },
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_CREDENTIAL_VERSION');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Live Queue Contract & 202 Accepted
  // -------------------------------------------------------------------------
  describe('202 Accepted & Live Queue Creation Contract', () => {
    it('creates agent_task run and returns 202 Accepted without arbitrary metadata', async () => {
      const createSpy = vi.spyOn(fakeDbAdapter, 'createAgentRun');

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'لطفاً وضعیت دیتابیس و لاگ‌های خطا را بررسی کنید',
          repository: 'https://github.com/my-org/my-app/tree/staging',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(202);

      const data = await res.json();
      expect(data.runId).toMatch(/^run_agent_/);
      expect(data.status).toBe('queued');
      expect(data.task).toBe('لطفاً وضعیت دیتابیس و لاگ‌های خطا را بررسی کنید');
      expect(data.repository).toEqual({
        owner: 'my-org',
        repo: 'my-app',
        ref: 'staging',
      });

      expect(createSpy).toHaveBeenCalledWith(mockWorkspaceId, {
        task: 'لطفاً وضعیت دیتابیس و لاگ‌های خطا را بررسی کنید',
        repository: {
          owner: 'my-org',
          repo: 'my-app',
          ref: 'staging',
        },
      });
    });

    it('accepts explicit connectionId and runtimeEnvironment and performs owner precheck', async () => {
      fakeDbAdapter.validateConnection = vi.fn().mockResolvedValue({ valid: true });
      fakeDbAdapter.validateRuntimeEnvironment = vi.fn().mockResolvedValue({ valid: true });
      const createSpy = vi.spyOn(fakeDbAdapter, 'createAgentRun');

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت برنامه‌های لیارا',
          connectionId: 'conn_liara_123',
          runtimeEnvironment: {
            connectionId: 'conn_env_456',
            credentialVersion: 2,
          },
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(202);

      const data = await res.json();
      expect(data.connectionId).toBe('conn_liara_123');
      expect(data.runtimeEnvironment).toEqual({
        connectionId: 'conn_env_456',
        credentialVersion: 2,
      });

      expect(fakeDbAdapter.validateConnection).toHaveBeenCalledWith(mockWorkspaceId, 'conn_liara_123');
      expect(fakeDbAdapter.validateRuntimeEnvironment).toHaveBeenCalledWith(mockWorkspaceId, {
        connectionId: 'conn_env_456',
        credentialVersion: 2,
      });
      expect(createSpy).toHaveBeenCalledWith(mockWorkspaceId, {
        task: 'بررسی وضعیت برنامه‌های لیارا',
        connectionId: 'conn_liara_123',
        runtimeEnvironment: {
          connectionId: 'conn_env_456',
          credentialVersion: 2,
        },
      });
    });

    it('rejects task with 400 when connectionId fails owner-scoped precheck', async () => {
      fakeDbAdapter.validateConnection = vi.fn().mockResolvedValue({
        valid: false,
        error: 'اتصال مورد نظر در فضای کاری یافت نشد',
        code: 'CONNECTION_NOT_FOUND',
      });

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت',
          connectionId: 'conn_other_workspace',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('CONNECTION_NOT_FOUND');
    });

    it('fails closed with 503 VALIDATION_UNAVAILABLE when connectionId is provided but adapter lacks validateConnection', async () => {
      fakeDbAdapter.validateConnection = undefined;

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت',
          connectionId: 'conn_liara_123',
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('VALIDATION_UNAVAILABLE');
    });

    it('fails closed with 503 VALIDATION_UNAVAILABLE when runtimeEnvironment is provided but adapter lacks validateRuntimeEnvironment', async () => {
      fakeDbAdapter.validateRuntimeEnvironment = undefined;

      const req = new Request('http://localhost:3000/api/assistant', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          task: 'بررسی وضعیت',
          runtimeEnvironment: {
            connectionId: 'conn_env_123',
            credentialVersion: 1,
          },
        }),
      });

      const res = await createAssistantTaskRoute(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('VALIDATION_UNAVAILABLE');
    });
  });

  // -------------------------------------------------------------------------
  // 5. GET /api/assistant/[id] & Strict Domain Proposal Verification
  // -------------------------------------------------------------------------
  describe('GET /api/assistant/[id] Details & Domain Canonical Proposal Hash', () => {
    it('returns run status, progress events, and message', async () => {
      const runId = 'run_agent_query_1';
      fakeStore.runs[runId] = {
        id: runId,
        workspaceId: mockWorkspaceId,
        type: 'agent_task',
        status: 'running',
        input: { task: 'بررسی پیکربندی' },
        output: { message: 'در حال بررسی منابع سرور' },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      fakeStore.events[runId] = [
        {
          id: 'evt_1',
          workspaceId: mockWorkspaceId,
          runId,
          seq: 1,
          type: 'tool_call',
          payload: { step: 'inspect_liara', message: 'بررسی پروژه‌های فعال' },
          createdAt: new Date(),
        },
      ];

      const req = new Request(`http://localhost:3000/api/assistant/${runId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: runId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('running');
      expect(data.output?.message).toBe('در حال بررسی منابع سرور');
      expect(data.progress).toHaveLength(1);
      expect(data.progress[0].step).toBe('inspect_liara');
      expect(data.progress[0].message).toBe('بررسی پروژه‌های فعال');
    });

    it('returns connectionId and runtimeEnvironment metadata on GET /api/assistant/[id]', async () => {
      const runId = 'run_agent_conn_query';
      fakeStore.runs[runId] = {
        id: runId,
        workspaceId: mockWorkspaceId,
        type: 'agent_task',
        status: 'queued',
        input: {
          task: 'بررسی پروژه‌ها',
          connectionId: 'conn_liara_test',
          runtimeEnvironment: {
            connectionId: 'conn_env_test',
            credentialVersion: 3,
          },
        },
        output: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      const req = new Request(`http://localhost:3000/api/assistant/${runId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: runId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.connectionId).toBe('conn_liara_test');
      expect(data.runtimeEnvironment).toEqual({
        connectionId: 'conn_env_test',
        credentialVersion: 3,
      });
    });

    it('returns verified proposedAction and proposalHash when hash matches strict domain schema', async () => {
      const runId = 'run_agent_proposal_valid';
      const validProposal: DeploymentProposal = {
        kind: 'deploy',
        connectionId: 'conn_test_1',
        credentialVersion: 1,
        appId: 'my-web-app',
        platform: 'node',
        port: 3000,
        repository: {
          owner: 'liara-org',
          repo: 'sample-app',
          commitSha: 'a1b2c3d4e5f6071829304a1b2c3d4e5f60718293',
        },
        bundleDigest: 'sha256:11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
      };

      const validHash = hashDeploymentProposal(validProposal);

      fakeStore.runs[runId] = {
        id: runId,
        workspaceId: mockWorkspaceId,
        type: 'agent_task',
        status: 'waiting_approval',
        input: { task: 'استقرار برنامه وب' },
        output: {
          message: 'برنامه آماده استقرار است. لطفاً تأیید فرمایید.',
          proposedAction: validProposal,
          proposalHash: validHash,
        },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      const req = new Request(`http://localhost:3000/api/assistant/${runId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: runId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.output?.proposedAction).toEqual(validProposal);
      expect(data.output?.proposalHash).toBe(validHash);
    });

    it('strips proposedAction when proposalHash is forged or mismatched', async () => {
      const runId = 'run_agent_proposal_forged';
      const validProposal: DeploymentProposal = {
        kind: 'restart',
        connectionId: 'conn_test_2',
        credentialVersion: 2,
        appId: 'my-cache-app',
      };

      fakeStore.runs[runId] = {
        id: runId,
        workspaceId: mockWorkspaceId,
        type: 'agent_task',
        status: 'waiting_approval',
        input: { task: 'راه‌اندازی مجدد' },
        output: {
          message: 'نیاز به ری‌استارت',
          proposedAction: validProposal,
          proposalHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      const req = new Request(`http://localhost:3000/api/assistant/${runId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: runId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.output?.proposedAction).toBeUndefined();
      expect(data.output?.proposalHash).toBeUndefined();
      expect(data.output?.message).toBe('نیاز به ری‌استارت');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Approval Switch & Agent Action Execution Polling Contract
  // -------------------------------------------------------------------------
  describe('Approval Switch Execution Run (agent_action) Contract', () => {
    it('GET /api/assistant/[id] returns verificationPhase and status for approved agent_action run', async () => {
      const execRunId = 'run_action_exec_123';
      fakeStore.runs[execRunId] = {
        id: execRunId,
        workspaceId: mockWorkspaceId,
        type: 'agent_action',
        status: 'running',
        input: { sourceRunId: 'run_task_src_1' },
        output: {
          phase: 'verifying_deployment',
          verificationPhase: 'verifying_health',
          message: 'در حال بررسی سلامت کانتینر مستقر شده...',
        },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      const req = new Request(`http://localhost:3000/api/assistant/${execRunId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: execRunId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.runId).toBe(execRunId);
      expect(data.type).toBe('agent_action');
      expect(data.status).toBe('running');
      expect(data.verificationPhase).toBe('verifying_health');
      expect(data.output?.message).toBe('در حال بررسی سلامت کانتینر مستقر شده...');
    });

    it('honestly represents outcome_unknown status for agent_action run', async () => {
      const execRunId = 'run_action_exec_unknown';
      fakeStore.runs[execRunId] = {
        id: execRunId,
        workspaceId: mockWorkspaceId,
        type: 'agent_action',
        status: 'outcome_unknown',
        input: { sourceRunId: 'run_task_src_1' },
        output: {
          outcomeUnknown: true,
          message: 'پادها راه‌اندازی شدند اما در مهلت مقرر پاسخ ندادند.',
        },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: new Date(),
      };

      const req = new Request(`http://localhost:3000/api/assistant/${execRunId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: execRunId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('outcome_unknown');
      expect(data.output?.outcomeUnknown).toBe(true);
    });

    it('handles waiting_external status with accepted_observed_healthy phase and allowlisted metadata without claiming completion', async () => {
      const execRunId = 'run_action_exec_waiting_ext';
      fakeStore.runs[execRunId] = {
        id: execRunId,
        workspaceId: mockWorkspaceId,
        type: 'agent_action',
        status: 'waiting_external',
        input: { sourceRunId: 'run_task_src_restart' },
        output: {
          phase: 'accepted_observed_healthy',
          message: 'درخواست راه‌اندازی مجدد پذیرفته شد و سلامت مشاهده شد.',
          releaseId: 'rel_restart_abc123',
          httpStatus: 200,
          providerState: 'healthy',
          // Malicious or internal properties that must be stripped
          secretApiKey: 'should_not_leak',
          internalConnectionSecret: 'top_secret',
        },
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      };

      const req = new Request(`http://localhost:3000/api/assistant/${execRunId}`, {
        method: 'GET',
        headers: defaultHeaders,
      });

      const res = await getAssistantTaskRoute(req, {
        params: Promise.resolve({ id: execRunId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.runId).toBe(execRunId);
      expect(data.type).toBe('agent_action');
      expect(data.status).toBe('waiting_external');
      expect(data.verificationPhase).toBe('accepted_observed_healthy');
      expect(data.output?.phase).toBe('accepted_observed_healthy');
      expect(data.output?.releaseId).toBe('rel_restart_abc123');
      expect(data.output?.httpStatus).toBe(200);
      expect(data.output?.providerState).toBe('healthy');
      expect(data.output?.message).toBe('درخواست راه‌اندازی مجدد پذیرفته شد و سلامت مشاهده شد.');
      // Must NOT be verified/completed
      expect(data.output?.verified).toBeUndefined();
      expect(data.status).not.toBe('succeeded');
      // Must NOT leak arbitrary properties
      expect((data.output as any).secretApiKey).toBeUndefined();
      expect((data.output as any).internalConnectionSecret).toBeUndefined();
    });
  });
});
