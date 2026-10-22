import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  createRun,
  getRun,
  getRunEvents,
  getOrCreateOwnerWorkspace,
  createConnection,
  addCredentialVersion,
  claimRunForExecution,
  FencingError,
} from '@laira/db';
import { encryptCredential } from '@laira/security';
import { runMigrations } from '../../../packages/db/src/migrator.js';
import {
  executeAgentTaskRun,
  WorkspaceBusyError,
  type AgentRunner,
} from '../src/handlers/agent-task.js';
import {
  hashDeploymentProposal,
  DeployProposalSchema,
  RestartProposalSchema,
  type DeployProposal,
} from '@laira/domain';
import type { AgentTool, RunDevOpsAgentOptions } from '@laira/agent/types';

const testDbUrl = process.env.TEST_DATABASE_URL;
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7); // 32 bytes valid key

describe('Agent Task Handler & Tools Unit & Integration Tests', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    if (!testDbUrl) {
      console.warn('Skipping Agent Task DB integration tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
  });

  afterEach(async () => {
    if (pool && trackedWorkspaceIds.size > 0) {
      const ids = Array.from(trackedWorkspaceIds);
      await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
    }
  });

  afterAll(async () => {
    if (pool) {
      if (trackedWorkspaceIds.size > 0) {
        const ids = Array.from(trackedWorkspaceIds);
        await pool.query(`DELETE FROM app.outbox WHERE workspace_id = ANY($1)`, [ids]);
      }
      await pool.end();
    }
  });

  // --- 1. Pure Unit / Contract Verification ---

  describe('Contract and Proposal Validation', () => {
    it('generates canonical SHA-256 hash for deploy proposal', () => {
      const proposal: DeployProposal = {
        kind: 'deploy',
        connectionId: 'conn_test123',
        credentialVersion: 1,
        appId: 'test-app',
        platform: 'node',
        port: 3000,
        repository: {
          owner: 'testowner',
          repo: 'testrepo',
          commitSha: 'a'.repeat(40),
        },
        bundleDigest: `sha256:${'b'.repeat(64)}`,
      };

      const parsed = DeployProposalSchema.parse(proposal);
      expect(parsed.kind).toBe('deploy');

      const hash = hashDeploymentProposal(parsed);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      // Recomputing hash on equivalent object must be identical
      const rehash = hashDeploymentProposal({ ...parsed });
      expect(rehash).toBe(hash);
    });

    it('rejects invalid deploy proposal schema (missing commitSha, invalid port)', () => {
      const invalidProposal = {
        kind: 'deploy',
        connectionId: 'conn_1',
        credentialVersion: 1,
        appId: 'app',
        platform: 'node',
        port: -1, // invalid negative port
        repository: {
          owner: 'owner',
          repo: 'repo',
          commitSha: 'not-40-hex',
        },
        bundleDigest: 'invalid-digest',
      };

      expect(() => DeployProposalSchema.parse(invalidProposal)).toThrow();
    });

    it('validates restart proposal schema', () => {
      const restart = {
        kind: 'restart' as const,
        connectionId: 'conn_restart1',
        credentialVersion: 2,
        appId: 'my-service',
      };

      const parsed = RestartProposalSchema.parse(restart);
      expect(parsed.kind).toBe('restart');
      const hash = hashDeploymentProposal(parsed);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // --- 2. Injected Mock Harness Tests (Runs without live DB) ---

  describe('Harness Execution & Lifecycle Unit Tests (No live DB required)', () => {
    it('fails closed when run is not resolvable from DB', async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
        connect: async () => ({
          query: async () => ({ rows: [{ acquired: true }] }),
          release: () => {},
        }),
      } as unknown as pg.Pool;

      await expect(
        executeAgentTaskRun(mockPool, 'worker-1', 'nonexistent-run')
      ).rejects.toThrow('Run nonexistent-run cannot be resolved from database');
    });

    it('releases lockClient and cleans up active workspace set when advisory lock is busy', async () => {
      let clientReleased = false;
      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: false }] }; // busy
          }
          return { rows: [] };
        },
        release: () => {
          clientReleased = true;
        },
      };

      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes('FROM app.runs')) {
            return {
              rows: [
                {
                  id: 'run-busy-1',
                  workspace_id: 'ws-busy-1',
                  status: 'queued',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          return { rows: [] };
        },
        connect: async () => mockClient,
      } as unknown as pg.Pool;

      await expect(
        executeAgentTaskRun(mockPool, 'worker-1', 'run-busy-1')
      ).rejects.toThrow(WorkspaceBusyError);

      expect(clientReleased).toBe(true);

      // Verify that workspace set was cleaned up and second attempt can still try
      let secondClientReleased = false;
      const secondClient = {
        query: async () => ({ rows: [{ acquired: false }] }),
        release: () => {
          secondClientReleased = true;
        },
      };
      (mockPool as any).connect = async () => secondClient;

      await expect(
        executeAgentTaskRun(mockPool, 'worker-1', 'run-busy-1')
      ).rejects.toThrow(WorkspaceBusyError);
      expect(secondClientReleased).toBe(true);
    });

    it('does NOT terminate active fresh running task on another worker (throws FencingError, no outcome_unknown)', async () => {
      let outcomeUnknownExecuted = false;
      let runnerCalled = false;

      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rows: [] };
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes('FROM app.runs WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 'run-fresh-active-1',
                  workspace_id: 'ws-fresh-1',
                  status: 'running',
                  claimed_by: 'worker-other-active',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes('UPDATE app.runs') && sql.includes('claimed_by = $1')) {
            // Fresh active lease on other worker -> claim fails (returns empty rows)
            return { rows: [] };
          }
          if (sql.includes("status = 'outcome_unknown'")) {
            outcomeUnknownExecuted = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
        connect: async () => mockClient,
      } as unknown as pg.Pool;

      const mockRunner: AgentRunner = async () => {
        runnerCalled = true;
        return {
          message: 'Should never run',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callsCount: 0 },
          toolTrace: [],
        };
      };

      await expect(
        executeAgentTaskRun(mockPool, 'worker-new', 'run-fresh-active-1', 30, {
          runner: mockRunner,
        })
      ).rejects.toThrow(FencingError);

      expect(outcomeUnknownExecuted).toBe(false); // Active healthy worker is NOT killed!
      expect(runnerCalled).toBe(false);
    });

    it('marks recovered stale running task as outcome_unknown ONLY after claim takeover without model replay', async () => {
      let outcomeUnknownFenced = false;
      let runnerCalled = false;
      let isClaimed = false;

      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rows: [] };
          return { rows: [] };
        },
        release: () => {},
      };

      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes('FROM app.runs WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 'run-stale-1',
                  workspace_id: 'ws-stale-1',
                  status: outcomeUnknownFenced ? 'outcome_unknown' : 'running',
                  claimed_by: isClaimed ? 'worker-takeover' : 'worker-crashed',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes('UPDATE app.runs') && sql.includes('claimed_by = $1')) {
            // Stale expired lease taken over successfully
            isClaimed = true;
            return {
              rows: [
                {
                  id: 'run-stale-1',
                  workspace_id: 'ws-stale-1',
                  status: 'running',
                  claimed_by: 'worker-takeover',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (
            sql.includes("status = 'outcome_unknown'") &&
            sql.includes('claimed_by = $2') &&
            sql.includes('workspace_id = $3')
          ) {
            outcomeUnknownFenced = true;
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO app.run_events')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        connect: async () => mockClient,
      } as unknown as pg.Pool;

      const mockRunner: AgentRunner = async () => {
        runnerCalled = true;
        return {
          message: 'Should never run',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callsCount: 0 },
          toolTrace: [],
        };
      };

      const result = await executeAgentTaskRun(mockPool, 'worker-takeover', 'run-stale-1', 30, {
        runner: mockRunner,
      });

      expect(isClaimed).toBe(true);
      expect(outcomeUnknownFenced).toBe(true);
      expect(runnerCalled).toBe(false); // Model token spending blocked
      expect(result.run.status).toBe('outcome_unknown');
    });

    it('rethrows pre-claim database error without calling failRun on unclaimed run', async () => {
      let failRunCalled = false;

      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes('FROM app.runs WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 'run-preclaim-err',
                  workspace_id: 'ws-preclaim',
                  status: 'queued',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes("status = 'failed'")) {
            failRunCalled = true;
            return { rows: [] };
          }
          return { rows: [] };
        },
        connect: async () => {
          throw new Error('Database connection pool exhausted');
        },
      } as unknown as pg.Pool;

      await expect(
        executeAgentTaskRun(mockPool, 'worker-1', 'run-preclaim-err', 30)
      ).rejects.toThrow('Database connection pool exhausted');

      expect(failRunCalled).toBe(false); // Unclaimed run is NOT falsely marked failed
    });

    it('passes abort signal and captures BOX_MODEL configuration for model client', async () => {
      let runnerOptions: RunDevOpsAgentOptions | null = null;

      const origBoxKey = process.env.BOX_API_KEY;
      const origDemoOwner = process.env.DEMO_OWNER_GITHUB_ID;
      const origBoxModel = process.env.BOX_MODEL;

      process.env.BOX_API_KEY = 'sk-mock-demo-key-valid';
      process.env.DEMO_OWNER_GITHUB_ID = 'gh-test-owner';
      process.env.BOX_MODEL = 'openai/gpt-5.4-mini';

      try {
        let isClaimed = false;

        const queryHandler = async (sql: string, params?: any[]) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rows: [] };
          if (sql.includes('FROM app.runs WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 'run-model-cfg',
                  workspace_id: 'ws-model-cfg',
                  status: isClaimed ? 'running' : 'queued',
                  claimed_by: isClaimed ? 'worker-test' : null,
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes('UPDATE app.runs') && sql.includes('claimed_by = $1')) {
            isClaimed = true;
            return {
              rows: [
                {
                  id: 'run-model-cfg',
                  workspace_id: 'ws-model-cfg',
                  status: 'running',
                  claimed_by: 'worker-test',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes('UPDATE app.runs') && sql.includes("status = 'succeeded'")) {
            return {
              rows: [
                {
                  id: 'run-model-cfg',
                  workspace_id: 'ws-model-cfg',
                  status: 'succeeded',
                  type: 'agent_task',
                  input: {},
                  output: {},
                },
              ],
            };
          }
          if (sql.includes('UPDATE app.runs') && sql.includes('heartbeat_at = NOW()')) {
            return {
              rows: [
                {
                  id: 'run-model-cfg',
                  workspace_id: 'ws-model-cfg',
                  status: 'running',
                  claimed_by: 'worker-test',
                  type: 'agent_task',
                  input: {},
                },
              ],
            };
          }
          if (sql.includes('FROM app.workspaces')) {
            return {
              rows: [
                {
                  id: 'ws-model-cfg',
                  owner_user_id: 'usr-1',
                  github_user_id: 'gh-test-owner',
                },
              ],
            };
          }
          if (sql.includes('FROM app.connections')) {
            return { rows: [] }; // No connections -> demo key allowed
          }
          if (sql.includes('SELECT COALESCE(MAX(seq), 0) + 1')) {
            return { rows: [{ next_seq: 1 }] };
          }
          if (sql.includes('INSERT INTO app.run_events')) {
            return {
              rows: [
                {
                  id: 'evt-1',
                  run_id: 'run-model-cfg',
                  workspace_id: 'ws-model-cfg',
                  seq: 1,
                  type: 'test',
                  payload: {},
                  created_at: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        };

        const mockPool = {
          query: queryHandler,
          connect: async () => ({
            query: queryHandler,
            release: () => {},
          }),
        } as unknown as pg.Pool;

        let signalAbortedDuringExecution: boolean | null = null;

        const mockRunner: AgentRunner = async (opts) => {
          runnerOptions = opts;
          signalAbortedDuringExecution = opts.signal?.aborted ?? null;
          return {
            message: 'Analysis completed successfully',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, callsCount: 1 },
            toolTrace: [],
          };
        };

        const result = await executeAgentTaskRun(mockPool, 'worker-test', 'run-model-cfg', 30, {
          runner: mockRunner,
        });

        expect(result.run.status).toBe('succeeded');
        expect(runnerOptions).not.toBeNull();
        expect(runnerOptions!.signal).toBeDefined();
        expect(signalAbortedDuringExecution).toBe(false);
        // After execution completes, signal is safely terminated
        expect(runnerOptions!.signal?.aborted).toBe(true);

        // Verify model client configuredModel captured from process.env.BOX_MODEL
        expect(runnerOptions!.model.model).toBe('openai/gpt-5.4-mini');
        expect(runnerOptions!.model.config.configuredModel).toBe('openai/gpt-5.4-mini');
      } finally {
        if (origBoxKey) process.env.BOX_API_KEY = origBoxKey;
        else delete process.env.BOX_API_KEY;
        if (origDemoOwner) process.env.DEMO_OWNER_GITHUB_ID = origDemoOwner;
        else delete process.env.DEMO_OWNER_GITHUB_ID;
        if (origBoxModel) process.env.BOX_MODEL = origBoxModel;
        else delete process.env.BOX_MODEL;
      }
    });

    it('fails honestly with AGENT_TASK_INTERRUPTED when agentResult.interrupted is true', async () => {
      let isClaimed = false;
      let failedPayload: any = null;

      const queryHandler = async (sql: string, params?: any[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [] };
        if (sql.includes('FROM app.runs WHERE id = $1')) {
          return {
            rows: [
              {
                id: 'run-interrupted-runner',
                workspace_id: 'ws-int-runner',
                status: isClaimed ? (failedPayload ? 'failed' : 'running') : 'queued',
                claimed_by: isClaimed ? 'worker-test' : null,
                type: 'agent_task',
                input: {},
                error: failedPayload ? (typeof failedPayload === 'string' ? JSON.parse(failedPayload) : failedPayload) : null,
              },
            ],
          };
        }
        if (sql.includes('UPDATE app.runs') && sql.includes('claimed_by = $1')) {
          isClaimed = true;
          return {
            rows: [
              {
                id: 'run-interrupted-runner',
                workspace_id: 'ws-int-runner',
                status: 'running',
                claimed_by: 'worker-test',
                type: 'agent_task',
                input: {},
              },
            ],
          };
        }
        if (sql.includes('UPDATE app.runs') && sql.includes("status = 'failed'")) {
          failedPayload = params ? params[0] : null;
          return {
            rows: [
              {
                id: 'run-interrupted-runner',
                workspace_id: 'ws-int-runner',
                status: 'failed',
                type: 'agent_task',
                input: {},
                error: failedPayload,
              },
            ],
          };
        }
        if (sql.includes('FROM app.workspaces')) {
          return {
            rows: [
              {
                id: 'ws-int-runner',
                owner_user_id: 'usr-1',
                github_user_id: 'gh-test-owner',
              },
            ],
          };
        }
        if (sql.includes('FROM app.connections')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO app.run_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      };

      const mockPool = {
        query: queryHandler,
        connect: async () => ({
          query: queryHandler,
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const origBoxKey = process.env.BOX_API_KEY;
      const origDemoOwner = process.env.DEMO_OWNER_GITHUB_ID;
      process.env.BOX_API_KEY = 'sk-mock-demo-key-valid';
      process.env.DEMO_OWNER_GITHUB_ID = 'gh-test-owner';

      try {
        const interruptedRunner: AgentRunner = async () => ({
          message: 'Execution cut short by token budget',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, callsCount: 4 },
          toolTrace: [],
          interrupted: true, // Budget exhausted
        });

        const result = await executeAgentTaskRun(mockPool, 'worker-test', 'run-interrupted-runner', 30, {
          runner: interruptedRunner,
        });

        expect(result.run.status).toBe('failed');
      } finally {
        if (origBoxKey) process.env.BOX_API_KEY = origBoxKey;
        else delete process.env.BOX_API_KEY;
        if (origDemoOwner) process.env.DEMO_OWNER_GITHUB_ID = origDemoOwner;
        else delete process.env.DEMO_OWNER_GITHUB_ID;
      }
    });

    it('persists static error message on unhandled exception without echoing raw error', async () => {
      let isClaimed = false;
      let failedPayload: any = null;

      const queryHandler = async (sql: string, params?: any[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [] };
        if (sql.includes('FROM app.runs WHERE id = $1')) {
          return {
            rows: [
              {
                id: 'run-err-static',
                workspace_id: 'ws-err-static',
                status: isClaimed ? (failedPayload ? 'failed' : 'running') : 'queued',
                claimed_by: isClaimed ? 'worker-test' : null,
                type: 'agent_task',
                input: {},
                error: failedPayload ? JSON.parse(failedPayload) : null,
              },
            ],
          };
        }
        if (sql.includes('UPDATE app.runs') && sql.includes('claimed_by = $1')) {
          isClaimed = true;
          return {
            rows: [
              {
                id: 'run-err-static',
                workspace_id: 'ws-err-static',
                status: 'running',
                claimed_by: 'worker-test',
                type: 'agent_task',
                input: {},
              },
            ],
          };
        }
        if (sql.includes('UPDATE app.runs') && sql.includes("status = 'failed'")) {
          failedPayload = params ? params[0] : null;
          return {
            rows: [
              {
                id: 'run-err-static',
                workspace_id: 'ws-err-static',
                status: 'failed',
                type: 'agent_task',
                input: {},
                error: failedPayload ? JSON.parse(failedPayload) : null,
              },
            ],
          };
        }
        if (sql.includes('FROM app.workspaces')) {
          return {
            rows: [
              {
                id: 'ws-err-static',
                owner_user_id: 'usr-1',
                github_user_id: 'gh-test-owner',
              },
            ],
          };
        }
        if (sql.includes('FROM app.connections')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO app.run_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      };

      const mockPool = {
        query: queryHandler,
        connect: async () => ({
          query: queryHandler,
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const origBoxKey = process.env.BOX_API_KEY;
      const origDemoOwner = process.env.DEMO_OWNER_GITHUB_ID;
      process.env.BOX_API_KEY = 'sk-mock-demo-key-valid';
      process.env.DEMO_OWNER_GITHUB_ID = 'gh-test-owner';

      try {
        const explodingRunner: AgentRunner = async () => {
          throw new Error('Unsafe internal exception containing secret_db_uri_and_private_keys');
        };

        const result = await executeAgentTaskRun(mockPool, 'worker-test', 'run-err-static', 30, {
          runner: explodingRunner,
        });

        expect(result.run.status).toBe('failed');
        expect(result.run.error?.code).toBe('AGENT_TASK_FAILED');
        expect(result.run.error?.message).toBe('Agent task execution failed');
        expect(result.run.error?.message).not.toContain('secret_db_uri');
      } finally {
        if (origBoxKey) process.env.BOX_API_KEY = origBoxKey;
        else delete process.env.BOX_API_KEY;
        if (origDemoOwner) process.env.DEMO_OWNER_GITHUB_ID = origDemoOwner;
        else delete process.env.DEMO_OWNER_GITHUB_ID;
      }
    });
  });

  // --- 3. Database Integration Tests ---

  describe('DB Integration Tests', () => {
    it.skipIf(!testDbUrl)(
      'fails with MODEL_CONFIG_MISSING when workspace has no BoxAPI connection and no demo key',
      async () => {
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Model Test Owner' },
          githubUserId: `gh_model_${Date.now()}`,
        });
        trackedWorkspaceIds.add(workspace.id);

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Analyze repository' },
        });

        const origKey = process.env.BOX_API_KEY;
        delete process.env.BOX_API_KEY;

        try {
          const result = await executeAgentTaskRun(pool, 'worker-agent-1', run.id);
          expect(result.run.status).toBe('failed');

          const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
          expect(checkRun?.status).toBe('failed');
          expect(checkRun?.error?.code).toBe('MODEL_CONFIG_MISSING');
        } finally {
          if (origKey) process.env.BOX_API_KEY = origKey;
        }
      }
    );

    it.skipIf(!testDbUrl)(
      'fails with MODEL_ACCESS_DENIED when demo operator key is configured but workspace owner is unauthorized',
      async () => {
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Unauthorized Owner' },
          githubUserId: `gh_unauth_${Date.now()}`,
        });
        trackedWorkspaceIds.add(workspace.id);

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Analyze repository' },
        });

        const origKey = process.env.BOX_API_KEY;
        const origDemoOwner = process.env.DEMO_OWNER_GITHUB_ID;

        process.env.BOX_API_KEY = 'sk-mock-demo-key-12345';
        process.env.DEMO_OWNER_GITHUB_ID = 'gh_authorized_operator';

        try {
          const result = await executeAgentTaskRun(pool, 'worker-agent-2', run.id);
          expect(result.run.status).toBe('failed');

          const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
          expect(checkRun?.status).toBe('failed');
          expect(checkRun?.error?.code).toBe('MODEL_ACCESS_DENIED');
        } finally {
          if (origKey) process.env.BOX_API_KEY = origKey;
          else delete process.env.BOX_API_KEY;
          if (origDemoOwner) process.env.DEMO_OWNER_GITHUB_ID = origDemoOwner;
          else delete process.env.DEMO_OWNER_GITHUB_ID;
        }
      }
    );

    it.skipIf(!testDbUrl)(
      'executes agent_task successfully with injected runner, emits tool events, and stores proposal',
      async () => {
        const githubId = `gh_auth_op_${Date.now()}`;
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Authorized Owner' },
          githubUserId: githubId,
        });
        trackedWorkspaceIds.add(workspace.id);

        process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_KEY.toString('base64');
        process.env.BOX_API_KEY = 'sk-demo-key-valid';
        process.env.DEMO_OWNER_GITHUB_ID = githubId;

        // Setup active Liara connection
        const connection = await createConnection(pool, { workspaceId: workspace.id }, {
          name: 'Primary Liara',
          provider: 'liara',
        });

        const credEnvelope = encryptCredential(
          'mock-liara-api-token-xyz',
          TEST_ENCRYPTION_KEY,
          {
            workspaceId: workspace.id,
            connectionId: connection.id,
            version: '1',
            keyVersion: 1,
          }
        );

        await addCredentialVersion(pool, { workspaceId: workspace.id }, connection.id, credEnvelope);

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: {
            task: 'Inspect repo and propose deployment',
            repository: { owner: 'acme', repo: 'web-app' },
          },
        });

        // Mock deterministic runner that invokes tools
        let toolsSeen: AgentTool[] = [];
        const mockRunner: AgentRunner = async ({ tools, onEvent, signal }) => {
          expect(signal).toBeDefined();
          expect(signal?.aborted).toBe(false);

          toolsSeen = tools || [];

          // 1. Trigger inspect_repository tool
          const inspectTool = toolsSeen.find((t) => t.name === 'inspect_repository');
          expect(inspectTool).toBeDefined();

          if (onEvent) {
            await onEvent({
              type: 'tool_start',
              toolCall: { name: 'inspect_repository', id: 'call_1' },
              timestamp: Date.now(),
            });
          }

          // 2. Trigger propose_deployment tool
          const proposeTool = toolsSeen.find((t) => t.name === 'propose_deployment');
          expect(proposeTool).toBeDefined();

          const proposalResult = (await proposeTool!.execute({
            appId: 'my-production-app',
            platform: 'node',
            port: 3000,
          })) as Record<string, unknown>;

          // When repo hasn't been inspected, propose_deployment safely reports error
          expect(proposalResult.error).toBe('REPOSITORY_NOT_INSPECTED');

          if (onEvent) {
            await onEvent({
              type: 'tool_start',
              toolCall: { name: 'propose_restart', id: 'call_2' },
              timestamp: Date.now(),
            });
          }

          const restartTool = toolsSeen.find((t) => t.name === 'propose_restart');
          expect(restartTool).toBeDefined();

          const restartResult = (await restartTool!.execute({
            appId: 'my-production-app',
          })) as Record<string, unknown>;

          expect(restartResult.success).toBe(true);
          expect(restartResult.proposalHash).toBeDefined();

          return {
            message: 'Analysis completed. Restart proposal prepared for owner review.',
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
              callsCount: 1,
            },
            toolTrace: [],
          };
        };

        const result = await executeAgentTaskRun(pool, 'worker-agent-3', run.id, 30, {
          runner: mockRunner,
        });

        expect(result.run.status).toBe('succeeded');
        expect(result.eventsEmitted).toBeGreaterThanOrEqual(3);

        const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
        expect(checkRun?.status).toBe('succeeded');
        expect(checkRun?.output).toMatchObject({
          message: 'Analysis completed. Restart proposal prepared for owner review.',
          phase: 'analysis_and_proposal',
          verified: false, // Must never claim deploy success!
        });

        // Proposed action is attached
        expect(checkRun?.output?.proposedAction).toMatchObject({
          kind: 'restart',
          appId: 'my-production-app',
        });
        expect(checkRun?.output?.proposalHash).toBeDefined();

        // Check events have monotonic sequence numbers and static toolnames
        const events = await getRunEvents(pool, { workspaceId: workspace.id }, run.id);
        expect(events.length).toBeGreaterThanOrEqual(4);

        for (let i = 0; i < events.length; i++) {
          expect(events[i].seq).toBe(i + 1);
        }

        const progressEvents = events.filter((e) => e.type === 'step_progress');
        expect(progressEvents.length).toBeGreaterThanOrEqual(2);
        for (const pe of progressEvents) {
          expect([
            'inspect_repository',
            'propose_deployment',
            'propose_restart',
            'agent_step',
          ]).toContain(pe.payload.step);
        }

        const succeededEvent = events.find((e) => e.type === 'run_succeeded');
        expect(succeededEvent).toBeDefined();
      }
    );

    it.skipIf(!testDbUrl)(
      'throws WorkspaceBusyError when second run attempts to execute on same workspace',
      async () => {
        const githubId = `gh_concurrent_${Date.now()}`;
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Concurrent Owner' },
          githubUserId: githubId,
        });
        trackedWorkspaceIds.add(workspace.id);

        process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_KEY.toString('base64');
        process.env.BOX_API_KEY = 'sk-demo-key-concurrent';
        process.env.DEMO_OWNER_GITHUB_ID = githubId;

        const run1 = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'First run' },
        });

        const run2 = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Second simultaneous run' },
        });

        let releaseFirstRun!: () => void;
        const gatePromise = new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });

        const blockingRunner: AgentRunner = async () => {
          await gatePromise;
          return {
            message: 'First run completed',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, callsCount: 1 },
            toolTrace: [],
          };
        };

        // Start first run in background
        const firstRunPromise = executeAgentTaskRun(pool, 'worker-1', run1.id, 30, {
          runner: blockingRunner,
        });

        // Small yield so first run acquires advisory lock & in-process concurrency set
        await new Promise((r) => setTimeout(r, 100));

        // Attempt second run while first is active: must throw WorkspaceBusyError
        await expect(
          executeAgentTaskRun(pool, 'worker-2', run2.id, 30)
        ).rejects.toThrow(WorkspaceBusyError);

        // Run2 must NOT be marked as failed or terminal in DB (pg-boss will retry)
        const checkRun2 = await getRun(pool, { workspaceId: workspace.id }, run2.id);
        expect(checkRun2?.status).toBe('queued');

        // Unblock first run
        releaseFirstRun();
        const firstResult = await firstRunPromise;
        expect(firstResult.run.status).toBe('succeeded');
      }
    );

    it.skipIf(!testDbUrl)(
      'fails closed with BYOK_CREDENTIAL_ERROR and does not fall back to demo operator key if BYOK decryption fails',
      async () => {
        const githubId = `gh_byok_fail_${Date.now()}`;
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'BYOK Fail Owner' },
          githubUserId: githubId,
        });
        trackedWorkspaceIds.add(workspace.id);

        process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_KEY.toString('base64');
        process.env.BOX_API_KEY = 'sk-demo-key-should-never-be-used';
        process.env.DEMO_OWNER_GITHUB_ID = githubId;

        // Create boxapi connection with corrupt ciphertext
        const boxConn = await createConnection(pool, { workspaceId: workspace.id }, {
          name: 'Corrupted BoxAPI BYOK',
          provider: 'boxapi',
        });

        // Insert corrupt credential version directly
        await pool.query(
          `INSERT INTO app.connection_credential_versions (
             id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version, created_at
           ) VALUES ($1, $2, $3, $4, 'aes-256-gcm', 'invalid-corrupt-ciphertext', 'invalid-iv', 'invalid-tag', 1, NOW())`,
          [`cred_${crypto.randomUUID().replace(/-/g, '')}`, workspace.id, boxConn.id, 1]
        );

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Analyze repository' },
        });

        const result = await executeAgentTaskRun(pool, 'worker-byok-test', run.id, 30);
        expect(result.run.status).toBe('failed');

        const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
        expect(checkRun?.status).toBe('failed');
        expect(checkRun?.error?.code).toBe('BYOK_CREDENTIAL_ERROR');
      }
    );

    it.skipIf(!testDbUrl)(
      'fails closed with MODEL_ACCESS_DENIED and refuses demo fallback if workspace BoxAPI connection is disabled/revoked',
      async () => {
        const githubId = `gh_revoked_byok_${Date.now()}`;
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Revoked BYOK Owner' },
          githubUserId: githubId,
        });
        trackedWorkspaceIds.add(workspace.id);

        process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_KEY.toString('base64');
        process.env.BOX_API_KEY = 'sk-demo-key-should-never-be-used';
        process.env.DEMO_OWNER_GITHUB_ID = githubId;

        // Create boxapi connection
        const boxConn = await createConnection(pool, { workspaceId: workspace.id }, {
          name: 'Revoked BoxAPI Connection',
          provider: 'boxapi',
        });

        // Explicitly update connection status to 'revoked'
        await pool.query(
          `UPDATE app.connections SET status = 'revoked' WHERE id = $1`,
          [boxConn.id]
        );

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Analyze repository' },
        });

        const result = await executeAgentTaskRun(pool, 'worker-revoked-test', run.id, 30);
        expect(result.run.status).toBe('failed');

        const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
        expect(checkRun?.status).toBe('failed');
        expect(checkRun?.error?.code).toBe('MODEL_ACCESS_DENIED');
      }
    );

    it.skipIf(!testDbUrl)(
      'fails closed with BYOK_CREDENTIAL_ERROR if credential version key_version is not 1',
      async () => {
        const githubId = `gh_key_ver_${Date.now()}`;
        const { workspace } = await getOrCreateOwnerWorkspace(pool, {
          user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Key Version Owner' },
          githubUserId: githubId,
        });
        trackedWorkspaceIds.add(workspace.id);

        process.env.ENCRYPTION_MASTER_KEY = TEST_ENCRYPTION_KEY.toString('base64');
        process.env.BOX_API_KEY = 'sk-demo-key-should-never-be-used';
        process.env.DEMO_OWNER_GITHUB_ID = githubId;

        const boxConn = await createConnection(pool, { workspaceId: workspace.id }, {
          name: 'Unknown Key Version BoxAPI',
          provider: 'boxapi',
        });

        // Insert credential version with unknown key_version = 2
        await pool.query(
          `INSERT INTO app.connection_credential_versions (
             id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version, created_at
           ) VALUES ($1, $2, $3, $4, 'aes-256-gcm', 'ciphertext', 'iv', 'tag', 2, NOW())`,
          [`cred_${crypto.randomUUID().replace(/-/g, '')}`, workspace.id, boxConn.id, 1]
        );

        const run = await createRun(pool, { workspaceId: workspace.id }, {
          type: 'agent_task',
          input: { task: 'Analyze repository' },
        });

        const result = await executeAgentTaskRun(pool, 'worker-key-ver-test', run.id, 30);
        expect(result.run.status).toBe('failed');

        const checkRun = await getRun(pool, { workspaceId: workspace.id }, run.id);
        expect(checkRun?.status).toBe('failed');
        expect(checkRun?.error?.code).toBe('BYOK_CREDENTIAL_ERROR');
      }
    );
  });
});
