import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  getOrCreateOwnerWorkspace,
  createConnection,
  addCredentialVersion,
  createRun,
  getRun,
  getRunEvents,
  approveAgentAction,
} from '@laira/db';
import { runMigrations } from '../../../packages/db/src/migrator.js';
import { encryptCredential } from '@laira/security';
import { hashDeploymentProposal, type DeployProposal } from '@laira/domain';
import { LiaraOperationalAdapter } from '@laira/providers/liara/operational';
import { executeAgentTaskRun } from '../src/handlers/agent-task.js';
import { executeApprovedAgentActionRun } from '../src/handlers/approved-action.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

// Deterministic in-file ZIP fixture generator conforming to codeload.github.com format
interface ZipEntry {
  name: string;
  content: string | Uint8Array;
}

function createZipBuffer(entries: ZipEntry[]): Uint8Array {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const content =
      typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : Buffer.from(entry.content);

    const crc = crc32(content);
    const size = content.length;
    const isDir = entry.name.endsWith('/');
    const mode = isDir ? 0o040755 : 0o100644;
    const flags = 0x800; // Bit 11 UTF-8 flag
    const extAttrs = ((mode << 16) >>> 0) | (isDir ? 0x10 : 0);

    const local = Buffer.alloc(30 + nameBuf.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // No compression (stored)
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    content.copy(local, 30 + nameBuf.length);
    localHeaders.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(extAttrs >>> 0, 38);
    central.writeUInt32LE(offset >>> 0, 42);
    nameBuf.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localHeaders, centralBuf, eocd]));
}

function getHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return entry ? entry[1] : undefined;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (headers as Record<string, string>)[key] : undefined;
}

describe('Joined Acceptance: Full Agent DevOps Lifecycle Journey', () => {
  let pool: pg.Pool;
  const trackedWorkspaceIds = new Set<string>();
  const trackedUserIds = new Set<string>();

  const generateNumericGithubId = () => String(10000000 + Math.floor(Math.random() * 89999999));

  // Scope a random 32-byte master key per test session to avoid live keys or cross-test env leaks
  const testMasterKey = crypto.randomBytes(32);
  const testMasterKeyBase64 = testMasterKey.toString('base64');
  let prevMasterKey: string | undefined;
  let prevBoxKey: string | undefined;
  let prevDemoOwner: string | undefined;

  const cleanupDatabase = async () => {
    if (!pool) return;
    if (trackedWorkspaceIds.size > 0) {
      const wsIds = Array.from(trackedWorkspaceIds);
      await pool.query(`DELETE FROM app.workspaces WHERE id = ANY($1)`, [wsIds]).catch(() => {});
      trackedWorkspaceIds.clear();
    }
    if (trackedUserIds.size > 0) {
      const uIds = Array.from(trackedUserIds);
      await pool.query(`DELETE FROM app.users WHERE id = ANY($1)`, [uIds]).catch(() => {});
      trackedUserIds.clear();
    }
  };

  beforeAll(async () => {
    prevMasterKey = process.env.ENCRYPTION_MASTER_KEY;
    prevBoxKey = process.env.BOX_API_KEY;
    prevDemoOwner = process.env.DEMO_OWNER_GITHUB_ID;

    // Apply scoped master key; remove demo operator fallbacks to force encrypted DB credential resolution
    process.env.ENCRYPTION_MASTER_KEY = testMasterKeyBase64;
    delete process.env.BOX_API_KEY;
    delete process.env.DEMO_OWNER_GITHUB_ID;

    if (!testDbUrl) {
      console.warn('Skipping Joined Agent Journey DB acceptance tests: TEST_DATABASE_URL is not set.');
      return;
    }
    pool = new pg.Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
  });

  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    // Restore process environment cleanly
    if (prevMasterKey) process.env.ENCRYPTION_MASTER_KEY = prevMasterKey;
    else delete process.env.ENCRYPTION_MASTER_KEY;

    if (prevBoxKey) process.env.BOX_API_KEY = prevBoxKey;
    else delete process.env.BOX_API_KEY;

    if (prevDemoOwner) process.env.DEMO_OWNER_GITHUB_ID = prevDemoOwner;
    else delete process.env.DEMO_OWNER_GITHUB_ID;

    if (pool) {
      await cleanupDatabase();
      await pool.end();
    }
  });

  it.skipIf(!testDbUrl)(
    'proves complete journey: repo -> DeepAgents model tool selection -> canonical proposal -> owner DB approval -> approved execution -> READY release + HTTP 200',
    async () => {
      // 1. Provision isolated workspace and owner with canonical numeric GitHub IDs
      const githubId = generateNumericGithubId();
      const { user: ownerUser, workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'DevOps Journey Owner' },
        githubUserId: githubId,
        workspaceName: 'Journey Test Workspace',
      });
      trackedWorkspaceIds.add(workspace.id);
      trackedUserIds.add(ownerUser.id);

      // Provision a second distinct workspace for testing cross-workspace authorization denial
      const foreignGithubId = generateNumericGithubId();
      const { user: foreignUser, workspace: foreignWorkspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Foreign User' },
        githubUserId: foreignGithubId,
        workspaceName: 'Foreign Workspace',
      });
      trackedWorkspaceIds.add(foreignWorkspace.id);
      trackedUserIds.add(foreignUser.id);

      // 2. Setup workspace-owned encrypted BoxAPI (BYOK) credential
      // Note: Initial status is set to 'configured_unverified' to match the web UI connection creation contract.
      // The HTTP POST route -> encryption boundary is tested end-to-end in apps/web/test/connections-routes.test.ts;
      // this journey acceptance test does not claim full web HTTP route coverage, but exercises the worker database
      // credential resolution, decrypting bare trimmed keys and passing them directly to provider clients without JSON wrapping.
      const fictionalBoxApiKey = 'sk-test-byok-boxapi-key';
      const boxConn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Workspace BoxAPI BYOK',
        provider: 'boxapi',
      });
      await pool.query(
        `UPDATE app.connections SET status = 'configured_unverified' WHERE id = $1`,
        [boxConn.id]
      );
      const encBox = encryptCredential(fictionalBoxApiKey, testMasterKey, {
        workspaceId: workspace.id,
        connectionId: boxConn.id,
        version: '1',
        keyVersion: 1,
      });
      await addCredentialVersion(pool, { workspaceId: workspace.id }, boxConn.id, encBox);

      // 3. Setup workspace-owned encrypted Liara PaaS credential with status 'configured_unverified' (matching UI)
      const fictionalLiaraApiToken = 'test-liara-api-token-verified';
      const liaraConn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Production Liara PaaS',
        provider: 'liara',
      });
      await pool.query(
        `UPDATE app.connections SET status = 'configured_unverified' WHERE id = $1`,
        [liaraConn.id]
      );
      const encLiara = encryptCredential(fictionalLiaraApiToken, testMasterKey, {
        workspaceId: workspace.id,
        connectionId: liaraConn.id,
        version: '1',
        keyVersion: 1,
      });
      await addCredentialVersion(pool, { workspaceId: workspace.id }, liaraConn.id, encLiara);

      // 4. Prepare deterministic repository and ZIP archive fixtures
      const owner = 'sample-org';
      const repo = 'web-service';
      const commitSha = 'd3adb33f00000000000000000000000000000000';
      const zipArchiveBytes = createZipBuffer([
        {
          name: `${repo}-${commitSha}/package.json`,
          content: JSON.stringify({ name: 'web-service', version: '1.0.0', main: 'server.js' }),
        },
        {
          name: `${repo}-${commitSha}/server.js`,
          content: 'const http = require("http"); http.createServer((r,s) => s.end("OK")).listen(3000);',
        },
        {
          name: `${repo}-${commitSha}/liara.json`,
          content: JSON.stringify({ app: 'web-service', port: 3000, platform: 'node' }),
        },
      ]);

      // 5. Setup deterministic external transport interceptor
      let modelCallCount = 0;
      let uploadSourceCount = 0;
      let createReleaseCount = 0;
      let listReleasesCount = 0;
      let listProjectsCount = 0;
      let getProjectDetailCount = 0;
      let httpProbeCount = 0;
      let interceptedToolsPayload: any[] = [];
      const interceptedRequests: Array<{ method: string; url: string }> = [];

      const mockTransportFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as any).url || String(input);

        const method = (init?.method || 'GET').toUpperCase();
        interceptedRequests.push({ method, url: urlStr });

        // Route A: BoxAPI Model Chat Completions (Official OpenAI SDK baseURL https://ai.boxapi.ir/ai/v1)
        if (urlStr.includes('ai.boxapi.ir')) {
          modelCallCount++;
          // Assert Authorization header is exactly Bearer with the submitted fictional key and no JSON wrapping
          const authHeader = getHeader(init?.headers, 'authorization');
          expect(authHeader).toBe(`Bearer ${fictionalBoxApiKey}`);
          expect(authHeader).not.toContain('{');
          expect(authHeader).not.toContain('}');

          const bodyJson = JSON.parse((init?.body as string) || '{}');

          // Capture tools on first call to inspect parameter JSON schemas
          if (bodyJson.tools && Array.isArray(bodyJson.tools) && interceptedToolsPayload.length === 0) {
            interceptedToolsPayload = bodyJson.tools;
          }

          // Scripted model adaptive responses across <= 4 calls:
          // Call 1: parallel tool calls (inspect_repository + list_apps)
          if (modelCallCount === 1) {
            return new Response(
              JSON.stringify({
                id: 'chatcmpl-call-1',
                object: 'chat.completion',
                created: 1700000000,
                model: 'qwen/qwen3.7-flash',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_inspect_1',
                          type: 'function',
                          function: {
                            name: 'inspect_repository',
                            arguments: JSON.stringify({ owner, repo, ref: 'main' }),
                          },
                        },
                        {
                          id: 'call_list_apps_1',
                          type: 'function',
                          function: {
                            name: 'list_apps',
                            arguments: '{}',
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 150, completion_tokens: 45, total_tokens: 195 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Call 2: propose_deployment tool call with verified coordinates
          if (modelCallCount === 2) {
            return new Response(
              JSON.stringify({
                id: 'chatcmpl-call-2',
                object: 'chat.completion',
                created: 1700000001,
                model: 'qwen/qwen3.7-flash',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_propose_deploy_2',
                          type: 'function',
                          function: {
                            name: 'propose_deployment',
                            arguments: JSON.stringify({
                              appId: 'web-service',
                              platform: 'node',
                              port: 3000,
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 250, completion_tokens: 35, total_tokens: 285 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Call 3: final summary completion without further tool calls
          if (modelCallCount === 3) {
            return new Response(
              JSON.stringify({
                id: 'chatcmpl-call-3',
                object: 'chat.completion',
                created: 1700000002,
                model: 'qwen/qwen3.7-flash',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: 'Repository web-service inspected. Deployment proposal prepared and awaiting owner review.',
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 320, completion_tokens: 25, total_tokens: 345 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          throw new Error(`Unexpected excess model call (${modelCallCount}) exceeding planned turns`);
        }

        // Route B: GitHub API Commit Resolution
        if (urlStr.includes('api.github.com/repos/sample-org/web-service/commits/')) {
          return new Response(JSON.stringify({ sha: commitSha }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Route C: GitHub Codeload ZIP archive
        if (urlStr.includes(`codeload.github.com/sample-org/web-service/zip/${commitSha}`)) {
          return new Response(zipArchiveBytes, {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          });
        }

        // Route D: Liara API List Applications (GET /v1/projects)
        if (urlStr.includes('api.liara.ir') || urlStr.includes('api.iran.liara.ir')) {
          const authHeader = getHeader(init?.headers, 'authorization');
          expect(authHeader).toBe(`Bearer ${fictionalLiaraApiToken}`);
          expect(authHeader).not.toContain('{');
          expect(authHeader).not.toContain('}');
        }

        if (urlStr.endsWith('/v1/projects') && method === 'GET') {
          listProjectsCount++;
          return new Response(
            JSON.stringify({
              projects: [
                {
                  _id: 'liara_app_1',
                  project_id: 'web-service',
                  type: 'node',
                  status: 'created',
                  scale: 1,
                  planID: 'standard',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Route E: Liara API Get Application Detail (GET /v1/projects/:appId)
        if (urlStr.includes('/v1/projects/web-service') && !urlStr.includes('/releases') && !urlStr.includes('/sources') && method === 'GET') {
          getProjectDetailCount++;
          return new Response(
            JSON.stringify({
              project: {
                _id: 'liara_app_1',
                project_id: 'web-service',
                type: 'node',
                status: 'created',
                scale: 1,
                port: 3000,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Route F: Liara API Upload Source (POST /v2/projects/:slug/sources)
        if (urlStr.includes('/v2/projects/web-service/sources') && method === 'POST') {
          uploadSourceCount++;
          return new Response(
            JSON.stringify({
              sourceID: 'src_journey_valid_01',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Route G: Liara API Create Release (POST /v2/projects/:slug/releases)
        if (urlStr.includes('/v2/projects/web-service/releases') && method === 'POST') {
          createReleaseCount++;
          return new Response(
            JSON.stringify({
              releaseID: 'rel_journey_ready_99',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Route H: Liara API List / Detail Releases (GET /v1/projects/:slug/releases)
        if (urlStr.includes('/v1/projects/web-service/releases') && method === 'GET') {
          listReleasesCount++;
          return new Response(
            JSON.stringify([
              {
                _id: 'rel_journey_ready_99',
                id: 'rel_journey_ready_99',
                state: 'READY',
                status: 'READY',
                type: 'node',
                port: 3000,
                createdAt: new Date().toISOString(),
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Route I: Fixed-Origin HTTP Health Probe (GET https://${appId}.liara.run/)
        if (urlStr === 'https://web-service.liara.run/' && method === 'GET') {
          httpProbeCount++;
          return new Response('Health OK 200', { status: 200 });
        }

        // Strict SSRF and offline safety: any unmapped route MUST fail closed immediately
        throw new Error(`Unexpected network transport access blocked: ${method} ${urlStr}`);
      };

      // 6. Create Agent Task Run in Database
      const agentRun = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'agent_task',
        input: {
          task: 'Analyze repository sample-org/web-service and propose deployment',
          repository: { owner, repo, ref: 'main' },
        },
      });

      // 7. Execute Agent Task Run using default runtime (DeepAgents + BoxApiClient)
      // options.runner is deliberately omitted so actual runDevOpsAgent is loaded!
      const agentTaskResult = await executeAgentTaskRun(pool, 'worker-journey-01', agentRun.id, 30, {
        fetchImpl: mockTransportFetch,
      });

      // Verify Agent Task Run completed successfully
      expect(agentTaskResult.run.status).toBe('succeeded');
      expect(agentTaskResult.proposedAction).toBeDefined();
      expect(agentTaskResult.proposalHash).toBeDefined();

      const verifiedAgentRun = await getRun(pool, { workspaceId: workspace.id }, agentRun.id);
      expect(verifiedAgentRun?.status).toBe('succeeded');
      expect(verifiedAgentRun?.output).toMatchObject({
        phase: 'analysis_and_proposal',
        verified: false, // Agent proposal phase MUST NEVER claim deploy success
      });

      const proposedAction = verifiedAgentRun?.output?.proposedAction as DeployProposal;
      expect(proposedAction).toBeDefined();
      expect(proposedAction.kind).toBe('deploy');
      expect(proposedAction.appId).toBe('web-service');
      expect(proposedAction.platform).toBe('node');
      expect(proposedAction.port).toBe(3000);
      expect(proposedAction.repository.commitSha).toBe(commitSha); // Exact commit frozen
      expect(proposedAction.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/); // Real computed hash

      const canonicalProposalHash = verifiedAgentRun?.output?.proposalHash as string;
      expect(canonicalProposalHash).toBe(hashDeploymentProposal(proposedAction));

      // Assert parameter JSON schema was preserved into model tool definitions
      expect(interceptedToolsPayload.length).toBeGreaterThan(0);
      const proposeDeployDef = interceptedToolsPayload.find((t: any) => t.function?.name === 'propose_deployment');
      expect(proposeDeployDef).toBeDefined();
      expect(proposeDeployDef.function.parameters.required).toContain('appId');
      expect(proposeDeployDef.function.parameters.required).toContain('port');
      expect(proposeDeployDef.function.parameters.required).toContain('platform');

      // CRITICAL ASSERTION: ZERO mutations occurred before owner approval
      expect(uploadSourceCount).toBe(0);
      expect(createReleaseCount).toBe(0);

      // Verify events emitted during analysis phase
      const agentEvents = await getRunEvents(pool, { workspaceId: workspace.id }, agentRun.id);
      const eventTypes = agentEvents.map((e) => e.type);
      expect(eventTypes).toContain('run_succeeded');
      expect(eventTypes).toContain('step_completed');

      // 8. Owner Approval via DB
      // 8a. Test: Wrong workspace approval must fail closed
      await expect(
        approveAgentAction(
          pool,
          { workspaceId: foreignWorkspace.id },
          {
            sourceRunId: agentRun.id,
            proposalHash: canonicalProposalHash,
            ownerId: foreignUser.id,
          }
        )
      ).rejects.toThrow();

      // Verify 0 execution runs created in foreign workspace
      const foreignRuns = await pool.query(
        `SELECT id FROM app.runs WHERE workspace_id = $1 AND type = 'agent_action'`,
        [foreignWorkspace.id]
      );
      expect(foreignRuns.rows.length).toBe(0);

      // 8b. Valid approval by direct workspace owner
      const actionRun = await approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        {
          sourceRunId: agentRun.id,
          proposalHash: canonicalProposalHash,
          ownerId: ownerUser.id,
        }
      );

      expect(actionRun).toBeDefined();
      expect(actionRun.type).toBe('agent_action');
      expect(actionRun.status).toBe('queued');
      expect(actionRun.workspaceId).toBe(workspace.id);

      // 8c. Idempotency test: Repeat approval returns identical execution run without duplicate outbox records
      const repeatActionRun = await approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        {
          sourceRunId: agentRun.id,
          proposalHash: canonicalProposalHash,
          ownerId: ownerUser.id,
        }
      );
      expect(repeatActionRun.id).toBe(actionRun.id);

      const outboxEntries = await pool.query(
        `SELECT id FROM app.outbox WHERE workspace_id = $1 AND topic = 'run.dispatched' AND payload->>'runId' = $2`,
        [workspace.id, actionRun.id]
      );
      expect(outboxEntries.rows.length).toBe(1);

      // 9. Execute Approved Action Run via executeApprovedAgentActionRun
      const executionResult = await executeApprovedAgentActionRun(
        pool,
        'worker-journey-executor',
        actionRun.id,
        30,
        {
          httpFetch: mockTransportFetch,
          createLiaraAdapter: (cfg) => new LiaraOperationalAdapter({ ...cfg, fetchFn: mockTransportFetch }),
          sleep: async () => {}, // Zero-ms sleep for bounded polling in test
          encryptionMasterKey: testMasterKeyBase64,
        }
      );

      // Verify approved execution completed and verified healthy (not aborted with credential_changed_after_upload)
      expect(executionResult.phase).not.toBe('credential_changed_after_upload');
      expect(executionResult.run.status).toBe('succeeded');
      expect(executionResult.phase).toBe('verified');
      expect(executionResult.output).toMatchObject({
        phase: 'verified',
        verification: {
          releaseId: 'rel_journey_ready_99',
          providerState: 'READY',
          httpStatus: 200,
        },
      });
      expect(typeof (executionResult.output as any).message).toBe('string');
      expect((executionResult.output as any).message.length).toBeGreaterThan(0);

      // Assertions on external mutations: exactly ONE upload and exactly ONE release after approval
      expect(uploadSourceCount).toBe(1);
      expect(createReleaseCount).toBe(1);
      expect(listReleasesCount).toBeGreaterThanOrEqual(1);
      expect(httpProbeCount).toBe(1);

      // Assert no unmapped/external network requests escaped
      expect(interceptedRequests.length).toBeGreaterThan(0);
      const allowedPrefixes = [
        'https://ai.boxapi.ir',
        'https://api.github.com',
        'https://codeload.github.com',
        'https://api.liara.ir',
        'https://api.iran.liara.ir',
        'https://web-service.liara.run/',
      ];
      const disallowedRequests = interceptedRequests.filter(
        (req) => !allowedPrefixes.some((prefix) => req.url.startsWith(prefix))
      );
      expect(disallowedRequests).toEqual([]);

      // 10. Repeated executor call: must NOT re-send mutations
      const repeatedExecution = await executeApprovedAgentActionRun(
        pool,
        'worker-journey-executor',
        actionRun.id,
        30,
        {
          httpFetch: mockTransportFetch,
          createLiaraAdapter: (cfg) => new LiaraOperationalAdapter({ ...cfg, fetchFn: mockTransportFetch }),
          sleep: async () => {},
          encryptionMasterKey: testMasterKeyBase64,
        }
      );

      // Must be an idempotent no-op terminal return
      expect(repeatedExecution.phase).toBe('terminal_noop');
      expect(uploadSourceCount).toBe(1); // No additional upload
      expect(createReleaseCount).toBe(1); // No additional release

      // Verify execution events recorded in DB
      const execEvents = await getRunEvents(pool, { workspaceId: workspace.id }, actionRun.id);
      const execEventTypes = execEvents.map((e) => e.type);
      expect(execEventTypes).toContain('run_started');
      expect(execEventTypes).toContain('step_progress');
      expect(execEventTypes).toContain('run_succeeded');
    }
  );

  it.skipIf(!testDbUrl)(
    'handles uncertain write failure variant safely without retry or release mutation',
    async () => {
      // Provision workspace
      const failGithubId = generateNumericGithubId();
      const { user: ownerUser, workspace } = await getOrCreateOwnerWorkspace(pool, {
        user: { id: `usr_${crypto.randomUUID().replace(/-/g, '')}`, name: 'Failure Variant Owner' },
        githubUserId: failGithubId,
        workspaceName: 'Failure Variant Workspace',
      });
      trackedWorkspaceIds.add(workspace.id);
      trackedUserIds.add(ownerUser.id);

      // Setup Liara connection with status 'configured_unverified'
      const liaraConn = await createConnection(pool, { workspaceId: workspace.id }, {
        name: 'Liara Conn Failure Variant',
        provider: 'liara',
      });
      await pool.query(
        `UPDATE app.connections SET status = 'configured_unverified' WHERE id = $1`,
        [liaraConn.id]
      );
      const encLiara = encryptCredential('test-token-failure', testMasterKey, {
        workspaceId: workspace.id,
        connectionId: liaraConn.id,
        version: '1',
        keyVersion: 1,
      });
      await addCredentialVersion(pool, { workspaceId: workspace.id }, liaraConn.id, encLiara);

      // Prepare proposal & simulate pre-approved action directly
      const commitSha = 'f'.repeat(40);
      const zipArchiveBytes = createZipBuffer([
        { name: `fail-app-${commitSha}/package.json`, content: '{"name":"fail-app"}' },
      ]);

      const deployProposal: DeployProposal = {
        kind: 'deploy',
        connectionId: liaraConn.id,
        credentialVersion: 1,
        appId: 'fail-app',
        platform: 'node',
        port: 8080,
        repository: {
          owner: 'testowner',
          repo: 'fail-app',
          commitSha,
        },
        bundleDigest: '', // will be set from source
      };

      // Compute actual bundle digest
      const sourceMod = await import('@laira/source');
      const fetchResult = await (sourceMod as any).fetchPublicGithubSource(
        { owner: 'testowner', repo: 'fail-app', ref: commitSha },
        async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes('/commits/')) return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
          if (urlStr.includes('/zip/')) return new Response(zipArchiveBytes, { status: 200 });
          throw new Error(`Unexpected url: ${urlStr}`);
        }
      );
      deployProposal.bundleDigest = fetchResult.bundle.bundleDigest;
      const proposalHash = hashDeploymentProposal(deployProposal);

      // Setup source run that succeeded with proposal
      const sourceRun = await createRun(pool, { workspaceId: workspace.id }, {
        type: 'agent_task',
        input: { task: 'Deploy' },
      });
      await pool.query(
        `UPDATE app.runs
         SET status = 'succeeded',
             output = $1::jsonb,
             finished_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ proposedAction: deployProposal, proposalHash }), sourceRun.id]
      );

      // Approve action
      const actionRun = await approveAgentAction(
        pool,
        { workspaceId: workspace.id },
        {
          sourceRunId: sourceRun.id,
          proposalHash,
          ownerId: ownerUser.id,
        }
      );

      let uploadAttempts = 0;
      let releaseAttempts = 0;

      // Transport where upload returns a 500 server error after dispatch (uncertain write)
      const failingTransportFetch: typeof fetch = async (input, init) => {
        const urlStr = input.toString();
        const method = (init?.method || 'GET').toUpperCase();

        if (urlStr.includes('api.github.com')) {
          return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
        }
        if (urlStr.includes('codeload.github.com')) {
          return new Response(zipArchiveBytes, { status: 200 });
        }
        if (urlStr.includes('api.liara.ir') || urlStr.includes('api.iran.liara.ir')) {
          const authHeader = getHeader(init?.headers, 'authorization');
          expect(authHeader).toBe('Bearer test-token-failure');
          expect(authHeader).not.toContain('{');
          expect(authHeader).not.toContain('}');
        }
        if (urlStr.includes('/v1/projects/fail-app') && method === 'GET') {
          return new Response(
            JSON.stringify({
              project: { project_id: 'fail-app', type: 'node', status: 'created', port: 8080 },
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/v2/projects/fail-app/sources') && method === 'POST') {
          uploadAttempts++;
          // Provider returns 500 error after receiving payload -> uncertain outcome
          return new Response('Internal Server Error', { status: 500 });
        }
        if (urlStr.includes('/v2/projects/fail-app/releases') && method === 'POST') {
          releaseAttempts++;
          return new Response(JSON.stringify({ releaseID: 'rel_should_never_exist' }), { status: 200 });
        }

        throw new Error(`Unexpected network request: ${urlStr}`);
      };

      const failResult = await executeApprovedAgentActionRun(
        pool,
        'worker-fail-test',
        actionRun.id,
        30,
        {
          httpFetch: failingTransportFetch,
          createLiaraAdapter: (cfg) => new LiaraOperationalAdapter({ ...cfg, fetchFn: failingTransportFetch }),
          sleep: async () => {},
          encryptionMasterKey: testMasterKeyBase64,
        }
      );

      // Outcome must be unknown (upload_uncertain), with zero retries and zero release mutations
      expect(failResult.run.status).toBe('outcome_unknown');
      expect(failResult.phase).toBe('upload_uncertain');
      expect(uploadAttempts).toBe(1); // exactly one attempt
      expect(releaseAttempts).toBe(0); // release creation never attempted

      const dbCheck = await getRun(pool, { workspaceId: workspace.id }, actionRun.id);
      expect(dbCheck?.status).toBe('outcome_unknown');
    }
  );
});
