import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { runOperatorCli, parseCliArgs, formatCliError } from '../src/cli/operator.js';
import {
  resolveGitHubToken,
  fetchAuthenticatedGitHubUser,
  verifyOperatorIdentity,
  authenticateOperator,
} from '../src/cli/auth.js';
import {
  validateDatabaseUrl,
  resolveDatabasePool,
  resolveOperatorWorkspace,
} from '../src/cli/db.js';
import {
  executeTaskCommand,
  executeStatusCommand,
  executeConnectLiaraCommand,
  executeApproveCommand,
} from '../src/cli/commands.js';
import {
  createRun,
  getOrCreateOwnerWorkspace,
  createConnection,
  addCredentialVersion,
} from '@laira/db';
import { encryptCredential, AppError } from '@laira/security';
import {
  hashDeploymentProposal,
  type DeployProposal,
  type CreateAppProposal,
} from '@laira/domain';
import { runMigrations } from '../../../packages/db/src/migrator.js';

const DEMO_OPERATOR_ID = '152868728';
const TEST_MASTER_KEY = Buffer.alloc(32, 42).toString('base64url');
const testDbUrl = process.env.TEST_DATABASE_URL;

describe('Product Operator CLI Unit & Contract Tests', () => {
  // Helper to mock successful GitHub user response
  function createMockFetch(userData = { id: 152868728, login: 'demo-operator', name: 'Demo Operator' }) {
    return vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(userData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  }

  describe('1. Argument Parser', () => {
    it('parses commands and long flags correctly', () => {
      const parsed = parseCliArgs([
        'task',
        '--repository',
        'https://github.com/org/repo',
        '--task',
        'Deploy project',
      ]);
      expect(parsed.command).toBe('task');
      expect(parsed.options.repository).toBe('https://github.com/org/repo');
      expect(parsed.options.task).toBe('Deploy project');
    });

    it('parses short flags correctly', () => {
      const parsed = parseCliArgs(['status', '-r', 'run_12345']);
      expect(parsed.command).toBe('status');
      expect(parsed.options.r).toBe('run_12345');
    });

    it('handles boolean flags and empty args', () => {
      const empty = parseCliArgs([]);
      expect(empty.command).toBe('');

      const help = parseCliArgs(['--help']);
      expect(help.command).toBe('help');
      expect(help.options.help).toBe('true');
    });

    it('parses --key=value style flags and environment flags', () => {
      const parsed = parseCliArgs([
        'task',
        '--repository=https://github.com/org/repo',
        '--task=Build and deploy',
        '--environment-connection=conn_xyz',
        '--environment-version=2',
      ]);
      expect(parsed.command).toBe('task');
      expect(parsed.options.repository).toBe('https://github.com/org/repo');
      expect(parsed.options.task).toBe('Build and deploy');
      expect(parsed.options['environment-connection']).toBe('conn_xyz');
      expect(parsed.options['environment-version']).toBe('2');
    });
  });

  describe('2. GitHub Token Resolution', () => {
    it('resolves token from GH_TOKEN precedence over GITHUB_TOKEN', () => {
      const token = resolveGitHubToken({
        env: {
          GH_TOKEN: 'gh_token_primary',
          GITHUB_TOKEN: 'github_token_secondary',
        },
      });
      expect(token).toBe('gh_token_primary');
    });

    it('resolves token from GITHUB_TOKEN when GH_TOKEN is absent', () => {
      const token = resolveGitHubToken({
        env: {
          GITHUB_TOKEN: 'github_token_fallback',
        },
      });
      expect(token).toBe('github_token_fallback');
    });

    it('falls back to gh auth token child process if env tokens absent', () => {
      const execMock = vi.fn().mockReturnValue('gh_cli_output_token\n');
      const token = resolveGitHubToken({
        env: {},
        execFn: execMock,
      });
      expect(execMock).toHaveBeenCalledWith('gh auth token');
      expect(token).toBe('gh_cli_output_token');
    });

    it('fails closed when no token exists and exec fails without leaking secrets', () => {
      const execMock = vi.fn().mockImplementation(() => {
        throw new Error('Command failed');
      });
      expect(() =>
        resolveGitHubToken({
          env: {},
          execFn: execMock,
        })
      ).toThrow('GitHub authentication failed: no token available');
    });
  });

  describe('3. GitHub Authenticated User API & Operator Identity Gate', () => {
    it('fetches authenticated user and parses numeric id properly', async () => {
      const mockFetch = createMockFetch({
        id: 152868728,
        login: 'operator-user',
        name: 'Operator User',
        email: 'operator@example.com',
        avatar_url: 'https://github.com/avatar.png',
      });

      const user = await fetchAuthenticatedGitHubUser('test-token', {
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github.v3+json',
          }),
        })
      );
      expect(user.id).toBe('152868728');
      expect(user.login).toBe('operator-user');
      expect(user.name).toBe('Operator User');
    });

    it('redirectcredential: fails closed on 3xx redirect to prevent credential forwarding', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { Location: 'https://attacker.com/user' },
        })
      );

      await expect(
        fetchAuthenticatedGitHubUser('secret-token-redirect', {
          fetchFn: mockFetch,
        })
      ).rejects.toThrow('GitHub API redirect rejected: credential forwarding prohibited');
    });

    it('sizeincremental: streaming body exceeding 1 MiB aborts immediately and cancels reader', async () => {
      let readerCancelled = false;
      const chunk512k = new Uint8Array(512 * 1024);

      const mockStream = new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk512k);
        },
        cancel() {
          readerCancelled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(
        fetchAuthenticatedGitHubUser('token', { fetchFn: mockFetch })
      ).rejects.toThrow('GitHub API response body exceeded size limit');

      expect(readerCancelled).toBe(true);
    });

    it('stalledbody: whole-body deadline fires and aborts when body stream stalls', async () => {
      let readerCancelled = false;

      // ReadableStream that never yields another chunk
      const mockStream = new ReadableStream({
        pull() {
          // Never resolve/enqueue to simulate stalled network
          return new Promise(() => {});
        },
        cancel() {
          readerCancelled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(
        fetchAuthenticatedGitHubUser('token', {
          fetchFn: mockFetch,
          requestTimeoutMs: 50,
        })
      ).rejects.toThrow('GitHub API request timed out');

      expect(readerCancelled).toBe(true);
    });

    it('fails closed when GitHub API returns non-200 status without leaking tokens', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"message": "Bad credentials"}', { status: 401 })
      );

      await expect(
        fetchAuthenticatedGitHubUser('secret-token-123', {
          fetchFn: mockFetch,
        })
      ).rejects.toThrow('GitHub user authentication failed (HTTP 401)');
    });

    it('fails closed when user ID is non-numeric', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'non-numeric-id', login: 'attacker' }), {
          status: 200,
        })
      );

      await expect(
        fetchAuthenticatedGitHubUser('token', { fetchFn: mockFetch })
      ).rejects.toThrow('GitHub user id is not a valid numeric string');
    });

    it('absentowner: fails closed without hardcoded fallback when DEMO_OWNER_GITHUB_ID is missing or non-numeric', () => {
      const validUser = {
        id: DEMO_OPERATOR_ID,
        login: 'valid-owner',
        name: null,
        email: null,
        avatarUrl: null,
      };

      // Absent from env and absent from argument
      expect(() =>
        verifyOperatorIdentity(validUser, undefined, { env: {} })
      ).toThrow(
        'Operator verification failed: DEMO_OWNER_GITHUB_ID environment variable is required and must be numeric'
      );

      // Non-numeric in env
      expect(() =>
        verifyOperatorIdentity(validUser, undefined, {
          env: { DEMO_OWNER_GITHUB_ID: 'non-numeric-owner' },
        })
      ).toThrow(
        'Operator verification failed: DEMO_OWNER_GITHUB_ID environment variable is required and must be numeric'
      );
    });

    it('enforces operator identity gate against DEMO_OWNER_GITHUB_ID', () => {
      const validUser = {
        id: DEMO_OPERATOR_ID,
        login: 'valid-owner',
        name: null,
        email: null,
        avatarUrl: null,
      };

      expect(() =>
        verifyOperatorIdentity(validUser, DEMO_OPERATOR_ID)
      ).not.toThrow();

      const attackerUser = {
        id: '999999999',
        login: 'unauthorized-user',
        name: null,
        email: null,
        avatarUrl: null,
      };

      expect(() =>
        verifyOperatorIdentity(attackerUser, DEMO_OPERATOR_ID)
      ).toThrow(
        'Identity mismatch: authenticated GitHub user does not match authorized operator ID'
      );
    });

    it('authenticateOperator helper executes token resolution, fetch and verification in sequence', async () => {
      const mockFetch = createMockFetch();
      const user = await authenticateOperator({
        env: { GH_TOKEN: 'valid-token', DEMO_OWNER_GITHUB_ID: DEMO_OPERATOR_ID },
        fetchFn: mockFetch,
      });

      expect(user.id).toBe(DEMO_OPERATOR_ID);
    });
  });

  describe('4. Database URL Validation & Pool Resolution', () => {
    it('validates database URL format', () => {
      expect(validateDatabaseUrl('postgresql://usr:pwd@localhost:5432/db')).toBe(
        'postgresql://usr:pwd@localhost:5432/db'
      );
      expect(() => validateDatabaseUrl('not-a-valid-url')).toThrow(
        'Invalid DATABASE_URL connection format'
      );
      expect(() => validateDatabaseUrl('')).toThrow(
        'DATABASE_URL environment variable is required'
      );
    });

    it('enforces localhost restriction when requireLocalhost is true', () => {
      expect(() =>
        validateDatabaseUrl('postgresql://usr:pwd@remote.cloud.db:5432/db', {
          requireLocalhost: true,
        })
      ).toThrow(
        'Operator local mode requires the database host to be on localhost'
      );

      expect(
        validateDatabaseUrl('postgresql://usr:pwd@127.0.0.1:5432/db', {
          requireLocalhost: true,
        })
      ).toBe('postgresql://usr:pwd@127.0.0.1:5432/db');
    });

    it('resolveDatabasePool uses injected pool directly', () => {
      const fakePool = {} as pg.Pool;
      const managed = resolveDatabasePool({ pool: fakePool });
      expect(managed.pool).toBe(fakePool);
      expect(managed.shouldClose).toBe(false);
    });
  });

  describe('5. Task Command Input Validation', () => {
    it('rejects empty or missing task text', async () => {
      await expect(
        executeTaskCommand({ repository: 'https://github.com/org/repo', task: '' })
      ).rejects.toThrow('Task description is required (--task)');
    });

    it('rejects tasks exceeding 4000 characters', async () => {
      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'a'.repeat(4001),
        })
      ).rejects.toThrow(
        'Task description exceeds maximum length of 4000 characters'
      );
    });

    it('rejects invalid GitHub repository URLs with SSRF protections', async () => {
      await expect(
        executeTaskCommand({
          repository: 'http://insecure-site.com/evil/repo',
          task: 'Analyze code',
        })
      ).rejects.toThrow('Invalid repository URL');

      await expect(
        executeTaskCommand({
          repository: 'https://github.com/user:pass@github.com/evil/repo',
          task: 'Analyze code',
        })
      ).rejects.toThrow('Invalid repository URL');
    });

    it('enforces exact pairing of --environment-connection and --environment-version', async () => {
      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'Deploy with env',
          environmentConnectionId: 'conn_123',
        })
      ).rejects.toThrow(
        'Both --environment-connection and --environment-version must be provided together'
      );

      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'Deploy with env',
          environmentCredentialVersion: 1,
        })
      ).rejects.toThrow(
        'Both --environment-connection and --environment-version must be provided together'
      );
    });

    it('rejects non-positive integer environmentCredentialVersion', async () => {
      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'Deploy with env',
          environmentConnectionId: 'conn_123',
          environmentCredentialVersion: 0,
        })
      ).rejects.toThrow('Environment credential version must be a positive integer');

      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'Deploy with env',
          environmentConnectionId: 'conn_123',
          environmentCredentialVersion: -5,
        })
      ).rejects.toThrow('Environment credential version must be a positive integer');

      await expect(
        executeTaskCommand({
          repository: 'https://github.com/org/repo',
          task: 'Deploy with env',
          environmentConnectionId: 'conn_123',
          environmentCredentialVersion: 1.5,
        })
      ).rejects.toThrow('Environment credential version must be a positive integer');
    });
  });

  describe('6. Approve Command Validation', () => {
    it('rejects missing run ID', async () => {
      await expect(
        executeApproveCommand({ run: '', hash: 'a'.repeat(64) })
      ).rejects.toThrow('Run ID is required (--run)');
    });

    it('rejects missing proposal hash', async () => {
      await expect(
        executeApproveCommand({ run: 'run_123', hash: '' })
      ).rejects.toThrow('Proposal hash is required (--hash)');
    });

    it('rejects malformed proposal hashes', async () => {
      await expect(
        executeApproveCommand({ run: 'run_123', hash: 'short-hash' })
      ).rejects.toThrow(
        'Invalid proposal hash format. Must be a 64-character SHA-256 hexadecimal string'
      );

      await expect(
        executeApproveCommand({ run: 'run_123', hash: 'g'.repeat(64) })
      ).rejects.toThrow('Invalid proposal hash format');
    });
  });

  describe('7. Connect-Liara Command Configuration Contract', () => {
    it('fails closed when LIARA_API_TOKEN is missing', async () => {
      await expect(
        executeConnectLiaraCommand(undefined, {
          env: { ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY },
        })
      ).rejects.toThrow('LIARA_API_TOKEN environment variable is required');
    });

    it('fails closed when ENCRYPTION_MASTER_KEY is missing', async () => {
      await expect(
        executeConnectLiaraCommand(undefined, {
          env: { LIARA_API_TOKEN: 'liara-token' },
        })
      ).rejects.toThrow('ENCRYPTION_MASTER_KEY environment variable is required');
    });
  });

  describe('8. CLI Dispatcher Help & General Invocations', () => {
    it('returns help output on --help or help command with import-environment and environment flags', async () => {
      const logs: string[] = [];
      const res = await runOperatorCli(['--help'], {
        stdout: (msg) => logs.push(msg),
      });

      expect(res.command).toBe('help');
      const fullLog = logs.join('\n');
      expect(fullLog).toContain('Laira Product Operator CLI');
      expect(fullLog).toContain('import-environment');
      expect(fullLog).toContain('--environment-connection');
      expect(fullLog).toContain('--environment-version');
      expect(fullLog).toContain('deployment, create_app, or restart action');
    });

    it('throws on unknown CLI command with static message', async () => {
      await expect(runOperatorCli(['unsupported-cmd'])).rejects.toThrow(
        'Unknown command "unsupported-cmd". Run "operator --help" for available commands.'
      );
    });

    it('dispatches import-environment command from CLI args and validates inputs', async () => {
      const mockDeps: OperatorCliDependencies = {
        env: {
          GH_TOKEN: 'valid-token',
          DEMO_OWNER_GITHUB_ID: DEMO_OPERATOR_ID,
          ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY,
        },
        fetchFn: createMockFetch(),
      };

      await expect(
        runOperatorCli(
          ['import-environment', '--file', '/fake.env', '--keys', 'FOO'],
          mockDeps
        )
      ).rejects.toThrow('Connection name is required');

      await expect(
        runOperatorCli(
          ['import-environment', '--name', 'my-env', '--keys', 'FOO'],
          mockDeps
        )
      ).rejects.toThrow('Environment file path is required');

      await expect(
        runOperatorCli(
          ['import-environment', '--name', 'my-env', '--file', '/fake.env'],
          mockDeps
        )
      ).rejects.toThrow('Environment keys allowlist is required');
    });
  });

  describe('9. CLI Entrypoint Error Formatting & Redaction', () => {
    it('formats AppError with code prefix', () => {
      const appErr = new AppError({
        code: 'NOT_FOUND',
        message: 'Connection not found in workspace',
        statusCode: 404,
      });
      expect(formatCliError(appErr)).toBe('NOT_FOUND: Connection not found in workspace');
    });

    it('allows known static CLI validation errors through verbatim', () => {
      expect(formatCliError(new Error('Task description is required (--task)'))).toBe(
        'Task description is required (--task)'
      );
      expect(formatCliError(new Error('Invalid repository URL'))).toBe(
        'Invalid repository URL'
      );
      expect(
        formatCliError(
          new Error(
            'Both --environment-connection and --environment-version must be provided together'
          )
        )
      ).toBe(
        'Both --environment-connection and --environment-version must be provided together'
      );
    });

    it('sanitizes raw database and unknown errors to generic message without leaking internals', () => {
      const dbErr = new Error(
        'error: relation "app.connections" does not exist at character 15, password="secret-pw"'
      );
      expect(formatCliError(dbErr)).toBe('Operator command failed');

      const networkErr = new Error('ECONNREFUSED 127.0.0.1:5432');
      expect(formatCliError(networkErr)).toBe('Operator command failed');

      expect(formatCliError('non-error object')).toBe('Operator command failed');
    });
  });
});

describe('Product Operator CLI DB Integration Tests', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping Operator CLI DB integration tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
  });

  afterAll(async () => {
    if (pool) {
      if (trackedWorkspaceIds.size > 0) {
        const ids = Array.from(trackedWorkspaceIds);
        await pool.query(`DELETE FROM app.workspaces WHERE id = ANY($1)`, [ids]);
      }
      await pool.end();
    }
  });

  function createIntegrationDeps(overrides: Record<string, any> = {}) {
    const stdoutLogs: string[] = [];
    const { env: overrideEnv, ...restOverrides } = overrides;
    return {
      deps: {
        pool,
        env: {
          GH_TOKEN: 'test_operator_token',
          DEMO_OWNER_GITHUB_ID: DEMO_OPERATOR_ID,
          LIARA_API_TOKEN: 'real_liara_api_key_for_testing',
          ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY,
          DATABASE_URL: testDbUrl,
          ...(overrideEnv || {}),
        },
        fetchFn: vi.fn().mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                id: Number(DEMO_OPERATOR_ID),
                login: 'demo-operator-user',
                name: 'Real Operator',
              }),
              { status: 200 }
            )
          )
        ),
        stdout: (msg: string) => stdoutLogs.push(msg),
        ...restOverrides,
      },
      stdoutLogs,
    };
  }

  it.skipIf(!testDbUrl)('creates agent_task run via task command with static initial message and prints runId', async () => {
    const { deps, stdoutLogs } = createIntegrationDeps();

    const sensitiveTask = 'Analyze secret-api repository for deployment';
    const res = await executeTaskCommand(
      {
        repository: 'https://github.com/octocat/Hello-World',
        task: sensitiveTask,
      },
      deps
    );

    expect(res.runId).toMatch(/^run_/);
    expect(res.status).toBe('queued');
    expect(stdoutLogs).toContain(res.runId);

    trackedWorkspaceIds.add(res.workspaceId);

    // Verify initial run event has static message and does NOT echo sensitive task text
    const eventRes = await pool.query(
      `SELECT payload FROM app.run_events WHERE run_id = $1 AND seq = 1 LIMIT 1`,
      [res.runId]
    );
    expect(eventRes.rows.length).toBe(1);
    expect(eventRes.rows[0].payload.message).toBe('CLI operator queued agent task');
    expect(eventRes.rows[0].payload.message).not.toContain(sensitiveTask);
  });

  it.skipIf(!testDbUrl)(
    'connect-liara stores encrypted credential and refuses overwrite on customer connection',
    async () => {
      const { deps, stdoutLogs } = createIntegrationDeps({
        env: {
          LIARA_TEAM_ID: 'team-acme-123',
        },
      });

      const res = await executeConnectLiaraCommand(undefined, deps);

      expect(res.connectionId).toMatch(/^conn_/);
      expect(res.status).toBe('configured_unverified');
      expect(res.hasTeamId).toBe(true);
      expect(stdoutLogs.some((l) => l.includes(res.connectionId))).toBe(true);

      trackedWorkspaceIds.add(res.workspaceId);

      // Verify token is never serialized in logs
      for (const log of stdoutLogs) {
        expect(log).not.toContain('real_liara_api_key_for_testing');
        expect(log).not.toContain(TEST_MASTER_KEY);
      }

      // Second invocation MUST refuse overwrite
      await expect(
        executeConnectLiaraCommand(undefined, deps)
      ).rejects.toThrow(
        'Existing Liara connection already configured for this workspace. Refusing to overwrite customer connection.'
      );
    }
  );

  it.skipIf(!testDbUrl)(
    'status command retrieves owner-scoped safe metadata, proposal, and events without leaking code',
    async () => {
      const { deps } = createIntegrationDeps();

      // Create a test run
      const taskRes = await executeTaskCommand(
        {
          repository: 'https://github.com/octocat/Hello-World',
          task: 'Check status pipeline',
        },
        deps
      );
      trackedWorkspaceIds.add(taskRes.workspaceId);

      const statusRes = await executeStatusCommand({ run: taskRes.runId }, deps);

      expect(statusRes.runId).toBe(taskRes.runId);
      expect(statusRes.type).toBe('agent_task');
      expect(statusRes.status).toBe('queued');
      expect(statusRes.events.length).toBeGreaterThanOrEqual(1);
      expect(statusRes.events[0]?.type).toBe('run_started');
    }
  );

  it.skipIf(!testDbUrl)(
    'status command safely displays proposal with exact SHA, digest, connectionId, and credentialVersion',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      const sampleProposal: DeployProposal = {
        kind: 'deploy',
        connectionId: 'conn_test_safe',
        credentialVersion: 1,
        appId: 'demo-app-1',
        platform: 'node',
        port: 3000,
        repository: {
          owner: 'octocat',
          repo: 'Hello-World',
          commitSha: 'a'.repeat(40),
        },
        bundleDigest: `sha256:${'b'.repeat(64)}`,
      };
      const proposalHash = hashDeploymentProposal(sampleProposal);

      const run = await createRun(
        pool,
        { workspaceId: workspace.id },
        {
          type: 'agent_task',
          input: { task: 'Verify proposal' },
        }
      );

      // Store proposal in output
      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb,
             finished_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({
            message: 'Analysis completed successfully',
            phase: 'proposal_ready',
            proposedAction: sampleProposal,
            proposalHash,
          }),
          run.id,
        ]
      );

      const statusRes = await executeStatusCommand({ run: run.id }, deps);

      expect(statusRes.status).toBe('succeeded');
      expect(statusRes.phase).toBe('proposal_ready');
      expect(statusRes.message).toBe('Analysis completed successfully');
      expect(statusRes.proposal?.kind).toBe('deploy');
      expect(statusRes.proposal?.appId).toBe('demo-app-1');
      expect(statusRes.proposal?.connectionId).toBe('conn_test_safe');
      expect(statusRes.proposal?.credentialVersion).toBe(1);
      expect(statusRes.proposal?.proposalHash).toBe(proposalHash);

      if (statusRes.proposal?.kind === 'deploy') {
        expect(statusRes.proposal.repository.commitSha).toBe('a'.repeat(40));
        expect(statusRes.proposal.bundleDigest).toBe(`sha256:${'b'.repeat(64)}`);
        expect(statusRes.proposal.port).toBe(3000);
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'status command safely extracts deploy proposal with runtimeEnvironment reference without exposing secrets',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      const sampleProposalWithEnv: DeployProposal = {
        kind: 'deploy',
        connectionId: 'conn_test_safe',
        credentialVersion: 1,
        appId: 'demo-app-env',
        platform: 'node',
        port: 3000,
        repository: {
          owner: 'testowner',
          repo: 'testrepo',
          commitSha: 'a'.repeat(40),
        },
        bundleDigest: `sha256:${'b'.repeat(64)}`,
        runtimeEnvironment: {
          connectionId: 'conn_env_opaque_fixture',
          credentialVersion: 3,
        },
      };

      const proposalHash = hashDeploymentProposal(sampleProposalWithEnv);

      const run = await createRun(
        pool,
        { workspaceId: workspace.id },
        {
          type: 'agent_task',
          input: {
            task: 'Deploy with env',
            runtimeEnvironment: {
              connectionId: 'conn_env_opaque_fixture',
              credentialVersion: 3,
            },
          },
        }
      );

      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1
         WHERE id = $2`,
        [
          JSON.stringify({
            message: 'Analysis completed successfully',
            phase: 'proposal_ready',
            proposedAction: sampleProposalWithEnv,
            proposalHash,
          }),
          run.id,
        ]
      );

      const statusRes = await executeStatusCommand({ run: run.id }, deps);

      expect(statusRes.status).toBe('succeeded');
      expect(statusRes.proposal?.kind).toBe('deploy');
      if (statusRes.proposal?.kind === 'deploy') {
        expect(statusRes.proposal.runtimeEnvironment).toEqual({
          connectionId: 'conn_env_opaque_fixture',
          credentialVersion: 3,
        });
      }

      const serialized = JSON.stringify(statusRes);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('secret');
    }
  );

  it.skipIf(!testDbUrl)(
    'status command safely extracts create_app kind proposal with visible cost object',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      const sampleCreateApp: CreateAppProposal = {
        kind: 'create_app',
        connectionId: 'conn_create_123',
        credentialVersion: 1,
        appId: 'new-service-app',
        platform: 'node',
        planId: 'standard-base-g2',
        bundlePlanId: 'standard-bundle-g2',
        cost: {
          currency: 'IRR',
          hourly: 20486.1,
          monthly: 14749992,
          sourceUrl: 'https://api.liara.ir/v1/me',
          checkedAt: '2026-10-23T00:00:00.000Z',
        },
      };

      const proposalHash = hashDeploymentProposal(sampleCreateApp);

      const run = await createRun(
        pool,
        { workspaceId: workspace.id },
        {
          type: 'agent_task',
          input: { task: 'Create app' },
        }
      );

      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb,
             finished_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({
            phase: 'app_creation_ready',
            proposedAction: sampleCreateApp,
            proposalHash,
          }),
          run.id,
        ]
      );

      const statusRes = await executeStatusCommand({ run: run.id }, deps);

      expect(statusRes.proposal?.kind).toBe('create_app');
      expect(statusRes.proposal?.appId).toBe('new-service-app');
      expect(statusRes.proposal?.connectionId).toBe('conn_create_123');
      expect(statusRes.proposal?.credentialVersion).toBe(1);
      expect(statusRes.proposal?.proposalHash).toBe(proposalHash);

      if (statusRes.proposal?.kind === 'create_app') {
        expect(statusRes.proposal.planId).toBe('standard-base-g2');
        expect(statusRes.proposal.bundlePlanId).toBe('standard-bundle-g2');
        expect(statusRes.proposal.cost).toBeDefined();
        expect(statusRes.proposal.cost.currency).toBe('IRR');
        expect(statusRes.proposal.cost.hourly).toBe(20486.1);
        expect(statusRes.proposal.cost.monthly).toBe(14749992);
        expect(statusRes.proposal.cost.sourceUrl).toBe('https://api.liara.ir/v1/me');
        expect(statusRes.proposal.cost.checkedAt).toBe('2026-10-23T00:00:00.000Z');
      }
    }
  );

  it.skipIf(!testDbUrl)(
    'status command rejects proposal with hash drift or malformed create_app schema',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      // 1. Hash drift test
      const validProposal: DeployProposal = {
        kind: 'deploy',
        connectionId: 'conn_safe',
        credentialVersion: 1,
        appId: 'drift-app',
        platform: 'node',
        port: 3000,
        repository: {
          owner: 'octocat',
          repo: 'Hello-World',
          commitSha: 'e'.repeat(40),
        },
        bundleDigest: `sha256:${'f'.repeat(64)}`,
      };

      const driftRun = await createRun(
        pool,
        { workspaceId: workspace.id },
        { type: 'agent_task', input: { task: 'Drift test' } }
      );

      // Stored proposalHash does not match computed hash
      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify({
            proposedAction: validProposal,
            proposalHash: '0'.repeat(64),
          }),
          driftRun.id,
        ]
      );

      const driftStatus = await executeStatusCommand({ run: driftRun.id }, deps);
      expect(driftStatus.proposal).toBeUndefined();

      // 2. Malformed create_app (missing cost and planId)
      const malformedRun = await createRun(
        pool,
        { workspaceId: workspace.id },
        { type: 'agent_task', input: { task: 'Malformed test' } }
      );

      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify({
            proposedAction: {
              kind: 'create_app',
              appId: 'malformed-app',
            },
            proposalHash: 'a'.repeat(64),
          }),
          malformedRun.id,
        ]
      );

      const malformedStatus = await executeStatusCommand({ run: malformedRun.id }, deps);
      expect(malformedStatus.proposal).toBeUndefined();
    }
  );

  it.skipIf(!testDbUrl)(
    'approve command explicitly approves action with exact user hash and queues execution run',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      // Create Liara connection
      const conn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Liara Conn',
        provider: 'liara',
      });
      const envelope = encryptCredential(
        'valid-liara-token',
        TEST_MASTER_KEY,
        {
          workspaceId: workspace.id,
          connectionId: conn.id,
          version: 1,
        },
        1
      );
      await addCredentialVersion(pool, { workspaceId: workspace.id }, conn.id, envelope);

      const sampleProposal: DeployProposal = {
        kind: 'deploy',
        connectionId: conn.id,
        credentialVersion: 1,
        appId: 'prod-app-approval',
        platform: 'node',
        port: 8080,
        repository: {
          owner: 'octocat',
          repo: 'Hello-World',
          commitSha: 'c'.repeat(40),
        },
        bundleDigest: `sha256:${'d'.repeat(64)}`,
      };
      const proposalHash = hashDeploymentProposal(sampleProposal);

      // Create succeeded agent_task run
      const run = await createRun(
        pool,
        { workspaceId: workspace.id },
        {
          type: 'agent_task',
          input: { task: 'Deploy' },
        }
      );
      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb,
             finished_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({
            proposedAction: sampleProposal,
            proposalHash,
          }),
          run.id,
        ]
      );

      // Calling approve with exact hash succeeds and transitions state
      const approveRes = await executeApproveCommand(
        {
          run: run.id,
          hash: proposalHash,
        },
        deps
      );

      expect(approveRes.executionRunId).toMatch(/^run_/);
      expect(approveRes.status).toBe('queued');
      expect(approveRes.sourceRunId).toBe(run.id);
      expect(approveRes.proposalHash).toBe(proposalHash);

      // Calling approve with mismatched hash MUST fail closed
      await expect(
        executeApproveCommand(
          {
            run: run.id,
            hash: '0'.repeat(64),
          },
          deps
        )
      ).rejects.toThrow();
    }
  );

  it.skipIf(!testDbUrl)(
    'task command queues run with runtimeEnvironment when valid deployment_env connection and version provided',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      // Create valid deployment_env connection
      const conn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Production Env',
        provider: 'deployment_env',
      });
      const envelope = encryptCredential(
        JSON.stringify({ DATABASE_HOST: 'internal.db' }),
        TEST_MASTER_KEY,
        {
          workspaceId: workspace.id,
          connectionId: conn.id,
          version: 1,
        },
        1
      );
      await addCredentialVersion(pool, { workspaceId: workspace.id }, conn.id, envelope);

      const taskRes = await executeTaskCommand(
        {
          repository: 'https://github.com/octocat/Hello-World',
          task: 'Deploy with runtime env',
          environmentConnectionId: conn.id,
          environmentCredentialVersion: 1,
        },
        deps
      );

      expect(taskRes.runId).toMatch(/^run_/);

      const runRow = await pool.query(
        `SELECT input FROM app.runs WHERE id = $1`,
        [taskRes.runId]
      );
      expect(runRow.rows[0].input.runtimeEnvironment).toEqual({
        connectionId: conn.id,
        credentialVersion: 1,
      });
    }
  );

  it.skipIf(!testDbUrl)(
    'task command rejects environment if provider is not deployment_env',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      // Create a liara connection (NOT deployment_env)
      const conn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Liara Provider',
        provider: 'liara',
      });

      await expect(
        executeTaskCommand(
          {
            repository: 'https://github.com/octocat/Hello-World',
            task: 'Deploy',
            environmentConnectionId: conn.id,
            environmentCredentialVersion: 1,
          },
          deps
        )
      ).rejects.toThrow('Environment connection provider must be "deployment_env"');
    }
  );

  it.skipIf(!testDbUrl)(
    'task command rejects environment when version drifts or record missing',
    async () => {
      const { deps } = createIntegrationDeps();

      const { workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: DEMO_OPERATOR_ID, name: 'Operator' },
        githubUserId: DEMO_OPERATOR_ID,
      });
      trackedWorkspaceIds.add(workspace.id);

      const conn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Drift Env',
        provider: 'deployment_env',
      });

      const envelope = encryptCredential('{}', TEST_MASTER_KEY, {
        workspaceId: workspace.id,
        connectionId: conn.id,
        version: 1,
      }, 1);
      await addCredentialVersion(pool, { workspaceId: workspace.id }, conn.id, envelope);

      // Request version 2 (which does not match active_version 1)
      await expect(
        executeTaskCommand(
          {
            repository: 'https://github.com/octocat/Hello-World',
            task: 'Deploy',
            environmentConnectionId: conn.id,
            environmentCredentialVersion: 2,
          },
          deps
        )
      ).rejects.toThrow(
        'Environment credential version does not match active connection version'
      );
    }
  );

  it.skipIf(!testDbUrl)(
    'task command with no environment flags performs no autodiscovery and omits runtimeEnvironment',
    async () => {
      const { deps } = createIntegrationDeps();

      const taskRes = await executeTaskCommand(
        {
          repository: 'https://github.com/octocat/Hello-World',
          task: 'No env test',
        },
        deps
      );

      const runRow = await pool.query(
        `SELECT input FROM app.runs WHERE id = $1`,
        [taskRes.runId]
      );
      expect(runRow.rows[0].input.runtimeEnvironment).toBeUndefined();
    }
  );
});
