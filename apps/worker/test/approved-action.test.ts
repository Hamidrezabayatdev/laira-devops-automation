import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  executeApprovedAgentActionRun,
  probeLiaraAppHttp,
  setFencedRunStatus,
  persistReleaseIdInOutput,
  activeRunsInProcess,
  type ApprovedActionDependencies,
} from '../src/handlers/approved-action.js';
import {
  hashDeploymentProposal,
  type DeployProposal,
  type RestartProposal,
} from '@laira/domain';
import { encryptCredential } from '@laira/security';

const MASTER_KEY = 'a'.repeat(64); // 32-byte hex key

const mockDeployProposal: DeployProposal = {
  kind: 'deploy',
  connectionId: 'conn_test_1',
  credentialVersion: 1,
  appId: 'my-test-app',
  platform: 'node',
  port: 3000,
  repository: {
    owner: 'testowner',
    repo: 'testrepo',
    commitSha: 'a'.repeat(40),
  },
  bundleDigest: '', // will be populated
};

const mockRestartProposal: RestartProposal = {
  kind: 'restart',
  connectionId: 'conn_test_1',
  credentialVersion: 1,
  appId: 'my-test-app',
};

function createEncryptedEnvelope(workspaceId: string, connectionId: string, version: number) {
  return encryptCredential('valid-liara-api-key', MASTER_KEY, {
    workspaceId,
    connectionId,
    version: String(version),
    keyVersion: 1,
  });
}

describe('Approved Action Execution Handler', () => {
  let mockPool: pg.Pool;
  let mockDeps: ApprovedActionDependencies;
  let sampleBundleBytes: Uint8Array;
  let sampleBundleDigest: string;
  let defaultEncrypted: ReturnType<typeof createEncryptedEnvelope>;

  beforeEach(() => {
    vi.restoreAllMocks();
    activeRunsInProcess.clear();

    sampleBundleBytes = new Uint8Array([1, 2, 3, 4, 5]);
    sampleBundleDigest = `sha256:${crypto.createHash('sha256').update(sampleBundleBytes).digest('hex')}`;
    mockDeployProposal.bundleDigest = sampleBundleDigest;

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'run_1' }] }),
    } as unknown as pg.Pool;

    defaultEncrypted = createEncryptedEnvelope('ws_1', 'conn_test_1', 1);

    mockDeps = {
      encryptionMasterKey: MASTER_KEY,
      resolveRun: vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        run: {
          id: 'run_1',
          workspaceId: 'ws_1',
          type: 'agent_action',
          status: 'queued',
          input: { approvalId: 'appr_1' },
          output: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      claimRun: vi.fn().mockResolvedValue({
        id: 'run_1',
        workspaceId: 'ws_1',
        type: 'agent_action',
        status: 'running',
        claimedBy: 'worker_1',
      }),
      getApprovedAction: vi.fn().mockResolvedValue({
        approvalId: 'appr_1',
        workspaceId: 'ws_1',
        sourceRunId: 'src_run_1',
        executionRunId: 'run_1',
        proposal: mockDeployProposal,
        proposalHash: hashDeploymentProposal(mockDeployProposal),
        ownerId: 'owner_1',
        approvedAt: new Date(Date.now() - 5000),
        expiresAt: new Date(Date.now() + 60000),
        dispatchedAt: null,
        credentialVersion: 1,
        connectionId: 'conn_test_1',
        sourceRun: { id: 'src_run_1', type: 'agent_task', status: 'succeeded', finishedAt: new Date() },
      }),
      claimDispatch: vi.fn().mockResolvedValue(true),
      getActiveCredential: vi.fn().mockResolvedValue({
        id: 'cred_1',
        workspaceId: 'ws_1',
        connectionId: 'conn_test_1',
        version: 1,
        algorithm: 'aes-256-gcm',
        ciphertext: defaultEncrypted.ciphertext,
        iv: defaultEncrypted.iv,
        tag: defaultEncrypted.tag,
        keyVersion: 1,
        createdAt: new Date(),
      }),
      getConnection: vi.fn().mockResolvedValue({
        id: 'conn_test_1',
        workspaceId: 'ws_1',
        name: 'Liara',
        provider: 'liara',
        status: 'active',
        activeVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      appendEvent: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }),
      completeRun: vi.fn().mockImplementation(async (_pool, _workerId, _runId, output) => ({
        id: 'run_1',
        status: 'succeeded',
        output,
      })),
      failRun: vi.fn().mockImplementation(async (_pool, _workerId, _runId, error) => ({
        id: 'run_1',
        status: 'failed',
        error,
      })),
      heartbeat: vi.fn().mockResolvedValue(undefined),
      fetchGithubSource: vi.fn().mockResolvedValue({
        commit: 'a'.repeat(40),
        bundle: {
          bytes: sampleBundleBytes,
          bundleDigest: sampleBundleDigest,
        },
        repo: { owner: 'testowner', repo: 'testrepo', ref: 'a'.repeat(40) },
      }),
      createLiaraAdapter: vi.fn().mockReturnValue({
        getAppDetail: vi.fn().mockResolvedValue({
          projectId: 'my-test-app',
          type: 'node',
          status: 'running',
        }),
        uploadSource: vi.fn().mockResolvedValue({
          status: 'accepted',
          data: { sourceId: 'src_xyz123' },
          correlationId: 'corr_1',
        }),
        createRelease: vi.fn().mockResolvedValue({
          status: 'accepted',
          data: { releaseId: 'rel_xyz456' },
          correlationId: 'corr_2',
        }),
        getReleaseDetail: vi.fn().mockResolvedValue({
          id: 'rel_xyz456',
          state: 'READY',
          status: 'READY',
        }),
        restartApp: vi.fn().mockResolvedValue({
          status: 'accepted',
          data: { restartRequested: true },
          correlationId: 'corr_3',
        }),
      }),
      httpFetch: vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(new Date()),
      heartbeatIntervalMs: 100_000, // keep high during test so timer doesn't run asynchronously
    };
  });

  describe('1. Idempotency & Terminal Handling', () => {
    it('returns terminal_noop early if run is already succeeded', async () => {
      mockDeps.resolveRun = vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        run: { id: 'run_1', status: 'succeeded', output: { done: true } },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('terminal_noop');
      expect(mockDeps.claimRun).not.toHaveBeenCalled();
      expect(mockDeps.createLiaraAdapter).not.toHaveBeenCalled();
    });

    it('returns terminal_noop early if run is in waiting_external status', async () => {
      mockDeps.resolveRun = vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        run: { id: 'run_1', status: 'waiting_external', output: { pending: true } },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('terminal_noop');
      expect(mockDeps.claimRun).not.toHaveBeenCalled();
      expect(mockDeps.createLiaraAdapter).not.toHaveBeenCalled();
    });

    it('throws FencingError if run cannot be claimed due to active lease', async () => {
      mockDeps.claimRun = vi.fn().mockResolvedValue(null);

      await expect(
        executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps)
      ).rejects.toThrow(/active lease held by another worker/);
    });
  });

  describe('2. Redelivery Protection', () => {
    it('blocks redelivery and transitions to outcome_unknown if dispatchedAt is non-null', async () => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue({
        approvalId: 'appr_1',
        proposal: mockDeployProposal,
        proposalHash: hashDeploymentProposal(mockDeployProposal),
        dispatchedAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() + 60000),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('dispatched_redelivery_blocked');
      expect(mockDeps.claimDispatch).not.toHaveBeenCalled();
      expect(mockDeps.createLiaraAdapter).not.toHaveBeenCalled();
    });
  });

  describe('3. Pre-write Validations (Read-only Verification)', () => {
    it('fails run if approval is missing', async () => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue(null);

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_approval_missing');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' })
      );
    });

    it('fails run if approval has expired', async () => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue({
        approvalId: 'appr_1',
        proposal: mockDeployProposal,
        proposalHash: hashDeploymentProposal(mockDeployProposal),
        dispatchedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_expired');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'EXPIRED' })
      );
    });

    it('fails run if proposal hash drifts', async () => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue({
        approvalId: 'appr_1',
        proposal: mockDeployProposal,
        proposalHash: 'wronghash'.padEnd(64, '0'),
        dispatchedAt: null,
        expiresAt: new Date(Date.now() + 60000),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_hash_mismatch');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'APPROVAL_DRIFT' })
      );
    });

    it('fails run if credential version does not match', async () => {
      mockDeps.getActiveCredential = vi.fn().mockResolvedValue({
        version: 2, // proposal has 1
        algorithm: 'aes-256-gcm',
        keyVersion: 1,
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_credential_drift');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'CREDENTIAL_VERSION_MISMATCH' })
      );
    });

    it('fails run if target app is not found on Liara', async () => {
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue({
        getAppDetail: vi.fn().mockRejectedValue(new Error('App not found')),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_app_not_found');
      expect(mockDeps.claimDispatch).not.toHaveBeenCalled();
    });

    it('fails run if app slug does not match requested proposal appId', async () => {
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue({
        getAppDetail: vi.fn().mockResolvedValue({
          projectId: 'different-app-name',
          type: 'node',
        }),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_slug_mismatch');
      expect(mockDeps.claimDispatch).not.toHaveBeenCalled();
    });

    it('fails run if GitHub commit SHA does not match', async () => {
      mockDeps.fetchGithubSource = vi.fn().mockResolvedValue({
        commit: 'b'.repeat(40), // mismatch
        bundle: { bytes: sampleBundleBytes, bundleDigest: sampleBundleDigest },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_commit_mismatch');
      expect(mockDeps.claimDispatch).not.toHaveBeenCalled();
    });

    it('fails run if recomputed bundle digest from actual bytes does not match', async () => {
      const tamperedBytes = new Uint8Array([9, 9, 9]);
      mockDeps.fetchGithubSource = vi.fn().mockResolvedValue({
        commit: 'a'.repeat(40),
        bundle: {
          bytes: tamperedBytes,
          bundleDigest: sampleBundleDigest, // helper claims digest matches, but raw bytes don't!
        },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_bundle_mismatch');
      expect(mockDeps.claimDispatch).not.toHaveBeenCalled();
    });
  });

  describe('4. Write-Ahead Claiming & Mutating Operations', () => {
    it('aborts mutation if write-ahead claimDispatch fails', async () => {
      mockDeps.claimDispatch = vi.fn().mockResolvedValue(false);

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_claim_dispatch');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'DISPATCH_CLAIM_FAILED' })
      );
    });

    it('sets outcome_unknown and does not retry if uploadSource returns status unknown', async () => {
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockResolvedValue({
          status: 'unknown',
          code: 'TIMEOUT_AFTER_DISPATCH',
          safeMessage: 'Write timed out after dispatch',
          correlationId: 'corr_timeout',
        }),
        createRelease: vi.fn(),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('upload_uncertain');
      expect(adapterMock.createRelease).not.toHaveBeenCalled();
      expect(mockDeps.failRun).not.toHaveBeenCalled();
    });

    it('fails run statically if uploadSource returns status rejected', async () => {
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockResolvedValue({
          status: 'rejected',
          code: 'BAD_REQUEST',
          safeMessage: 'Invalid archive format',
        }),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_upload');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'BAD_REQUEST' })
      );
    });

    it('CRITICAL: Never executes second mutation (createRelease) if lease is lost after upload', async () => {
      let uploadCalled = false;
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockImplementation(async () => {
          uploadCalled = true;
          return { status: 'accepted', data: { sourceId: 'src_1' } };
        }),
        createRelease: vi.fn(),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      // Heartbeat throws FencingError after upload has finished
      mockDeps.heartbeat = vi.fn().mockImplementation(async () => {
        if (uploadCalled) {
          const fencingErr = new Error('Claim lost');
          fencingErr.name = 'FencingError';
          throw fencingErr;
        }
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(adapterMock.uploadSource).toHaveBeenCalled();
      expect(adapterMock.createRelease).not.toHaveBeenCalled();
      expect(result.phase).toBe('post_dispatch_error_uncertain');
    });

    it('CRITICAL: Rechecks approval expiry at boundary and aborts createRelease if expired after upload', async () => {
      let uploadFinished = false;
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockImplementation(async () => {
          uploadFinished = true;
          return { status: 'accepted', data: { sourceId: 'src_1' } };
        }),
        createRelease: vi.fn(),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      // Return expired approval on second call after upload
      let getApprovedActionCalls = 0;
      mockDeps.getApprovedAction = vi.fn().mockImplementation(async () => {
        getApprovedActionCalls++;
        return {
          approvalId: 'appr_1',
          workspaceId: 'ws_1',
          proposal: mockDeployProposal,
          proposalHash: hashDeploymentProposal(mockDeployProposal),
          ownerId: 'owner_1',
          approvedAt: new Date(Date.now() - 5000),
          // First call: valid; second call after upload: expired
          expiresAt: uploadFinished ? new Date(Date.now() - 1000) : new Date(Date.now() + 60000),
          dispatchedAt: uploadFinished ? new Date() : null,
          credentialVersion: 1,
          connectionId: 'conn_test_1',
          sourceRun: { id: 'src_run_1', type: 'agent_task', status: 'succeeded', finishedAt: new Date() },
        };
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(adapterMock.uploadSource).toHaveBeenCalled();
      expect(adapterMock.createRelease).not.toHaveBeenCalled();
      expect(result.phase).toBe('approval_expired_after_upload');
    });

    it('CRITICAL: Rechecks credential version at boundary and aborts createRelease if rotated/changed after upload', async () => {
      let uploadFinished = false;
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockImplementation(async () => {
          uploadFinished = true;
          return { status: 'accepted', data: { sourceId: 'src_1' } };
        }),
        createRelease: vi.fn(),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      // Return rotated credential on second call after upload
      mockDeps.getActiveCredential = vi.fn().mockImplementation(async () => {
        return {
          id: 'cred_1',
          workspaceId: 'ws_1',
          connectionId: 'conn_test_1',
          version: uploadFinished ? 2 : 1, // rotated to version 2 after upload!
          algorithm: 'aes-256-gcm',
          ciphertext: defaultEncrypted.ciphertext,
          iv: defaultEncrypted.iv,
          tag: defaultEncrypted.tag,
          keyVersion: 1,
        };
      });

      mockDeps.getConnection = vi.fn().mockImplementation(async () => {
        return {
          id: 'conn_test_1',
          workspaceId: 'ws_1',
          name: 'Liara',
          provider: 'liara',
          status: 'active',
          activeVersion: uploadFinished ? 2 : 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(adapterMock.uploadSource).toHaveBeenCalled();
      expect(adapterMock.createRelease).not.toHaveBeenCalled();
      expect(result.phase).toBe('credential_changed_after_upload');
    });
  });

  describe('5. Polling & HTTP Verification Flow', () => {
    it('completes run as succeeded and verified when release is READY and HTTP probe returns 200 OK', async () => {
      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('verified');
      expect(mockDeps.completeRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({
          phase: 'verified',
          verification: expect.objectContaining({
            releaseId: 'rel_xyz456',
            providerState: 'READY',
            httpStatus: 200,
          }),
        })
      );
    });

    it('fails run if HTTP probe returns 404 Not Found after READY release', async () => {
      mockDeps.httpFetch = vi.fn().mockResolvedValue({
        status: 404,
        ok: false,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('http_404_failure');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'HTTP_404_NOT_FOUND' })
      );
    });

    it('sets outcome_unknown if HTTP probe returns a redirect (3xx is not accepted as healthy)', async () => {
      mockDeps.httpFetch = vi.fn().mockResolvedValue({
        status: 302,
        ok: false,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('http_uncertain');
      expect(result.output?.verification).toMatchObject({
        providerState: 'READY',
        httpStatus: 302,
        probeKind: 'redirect_rejected',
      });
    });

    it('fails run statically if release build state is reported as FAILED', async () => {
      const adapterMock = {
        getAppDetail: vi.fn().mockResolvedValue({ projectId: 'my-test-app', type: 'node' }),
        uploadSource: vi.fn().mockResolvedValue({ status: 'accepted', data: { sourceId: 'src_1' } }),
        createRelease: vi.fn().mockResolvedValue({ status: 'accepted', data: { releaseId: 'rel_1' } }),
        getReleaseDetail: vi.fn().mockResolvedValue({ id: 'rel_1', state: 'FAILED' }),
      };
      mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapterMock);

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('release_build_failed');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'RELEASE_BUILD_FAILED' })
      );
    });
  });

  describe('6. Restart Execution & Verification', () => {
    beforeEach(() => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue({
        approvalId: 'appr_restart_1',
        workspaceId: 'ws_1',
        sourceRunId: 'src_run_2',
        executionRunId: 'run_1',
        proposal: mockRestartProposal,
        proposalHash: hashDeploymentProposal(mockRestartProposal),
        ownerId: 'owner_1',
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        dispatchedAt: null,
        credentialVersion: 1,
        connectionId: 'conn_test_1',
        sourceRun: { id: 'src_run_2', type: 'agent_task', status: 'succeeded', finishedAt: new Date() },
      });
    });

    it('sets waiting_external with accepted_observed_healthy when restart acknowledged and HTTP is 200', async () => {
      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('accepted_observed_healthy');
      expect(result.output?.message).toContain('container restart timestamp baseline cannot be proven');
      expect(mockDeps.completeRun).not.toHaveBeenCalled(); // Does NOT claim full verification!
    });

    it('sets outcome_unknown when restart acknowledged but HTTP is unhealthy', async () => {
      mockDeps.httpFetch = vi.fn().mockResolvedValue({
        status: 503,
        ok: false,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('restart_probe_uncertain');
    });
  });

  describe('7. HTTP Probe Isolated Tests', () => {
    it('cancels body and returns healthy_2xx for 200 response', async () => {
      const cancelMock = vi.fn().mockResolvedValue(undefined);
      const fakeFetch = vi.fn().mockResolvedValue({
        status: 200,
        body: { cancel: cancelMock },
      } as unknown as Response);

      const probe = await probeLiaraAppHttp('my-app', fakeFetch as typeof fetch);
      expect(probe.ok).toBe(true);
      expect(probe.kind).toBe('healthy_2xx');
      expect(cancelMock).toHaveBeenCalled();
    });

    it('rejects 301 redirects and cancels body', async () => {
      const cancelMock = vi.fn().mockResolvedValue(undefined);
      const fakeFetch = vi.fn().mockResolvedValue({
        status: 301,
        body: { cancel: cancelMock },
      } as unknown as Response);

      const probe = await probeLiaraAppHttp('my-app', fakeFetch as typeof fetch);
      expect(probe.ok).toBe(false);
      expect(probe.kind).toBe('redirect_rejected');
      expect(cancelMock).toHaveBeenCalled();
    });
  });

  describe('8. Heartbeat Serialization & Interval Background Execution', () => {
    it('maintains serialized periodic interval heartbeats across slow async fetch without losing lease', async () => {
      mockDeps.heartbeatIntervalMs = 15;

      let fetchStarted = false;
      let fetchFinished = false;
      let intervalHeartbeatsDuringFetch = 0;

      mockDeps.heartbeat = vi.fn().mockImplementation(async () => {
        if (fetchStarted && !fetchFinished) {
          intervalHeartbeatsDuringFetch++;
        }
      });

      mockDeps.fetchGithubSource = vi.fn().mockImplementation(async () => {
        fetchStarted = true;
        // Spans at least 2 interval heartbeat ticks (2 * 15ms = ~30ms) before returning
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (intervalHeartbeatsDuringFetch >= 2) {
              clearInterval(poll);
              resolve();
            }
          }, 5);
        });
        fetchFinished = true;
        return {
          commit: 'a'.repeat(40),
          bundle: { bytes: sampleBundleBytes, bundleDigest: sampleBundleDigest },
          repo: { owner: 'testowner', repo: 'testrepo', ref: 'a'.repeat(40) },
        };
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);

      expect(intervalHeartbeatsDuringFetch).toBeGreaterThanOrEqual(2);
      expect(result.phase).toBe('verified');
      expect(mockDeps.completeRun).toHaveBeenCalled();
    });
  });

  describe('9. Connection Status Eligibility & Boundary Rechecks', () => {
    it('successfully completes deployment with unchanged configured_unverified connection status', async () => {
      mockDeps.getConnection = vi.fn().mockResolvedValue({
        id: 'conn_test_1',
        workspaceId: 'ws_1',
        name: 'Liara',
        provider: 'liara',
        status: 'configured_unverified',
        activeVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('verified');
      expect(mockDeps.completeRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ phase: 'verified' })
      );
    });

    it('rejects execution if connection status is disabled or revoked', async () => {
      mockDeps.getConnection = vi.fn().mockResolvedValue({
        id: 'conn_test_1',
        workspaceId: 'ws_1',
        name: 'Liara',
        provider: 'liara',
        status: 'revoked',
        activeVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('rejected_connection_ineligible');
      expect(mockDeps.failRun).toHaveBeenCalledWith(
        mockPool,
        'worker_1',
        'run_1',
        expect.objectContaining({ code: 'CONNECTION_INELIGIBLE' })
      );
    });
  });

  describe('10. Concurrent Same-Worker & Durable Lease Isolation', () => {
    it('rejects concurrent duplicate execution with FencingError while first restart is paused, first finishes safely without duplicated mutation', async () => {
      mockDeps.getApprovedAction = vi.fn().mockResolvedValue({
        approvalId: 'appr_restart_1',
        workspaceId: 'ws_1',
        sourceRunId: 'src_run_2',
        executionRunId: 'run_1',
        proposal: mockRestartProposal,
        proposalHash: hashDeploymentProposal(mockRestartProposal),
        ownerId: 'owner_1',
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        dispatchedAt: null,
        credentialVersion: 1,
        connectionId: 'conn_test_1',
        sourceRun: { id: 'src_run_2', type: 'agent_task', status: 'succeeded', finishedAt: new Date() },
      });

      let unpauseRestart: (() => void) | null = null;
      let restartCallCount = 0;
      const restartStartedPromise = new Promise<void>((resolve) => {
        const adapter = mockDeps.createLiaraAdapter!({ apiKey: 'test' });
        adapter.restartApp = vi.fn().mockImplementation(async () => {
          restartCallCount++;
          resolve();
          await new Promise<void>((r) => {
            unpauseRestart = r;
          });
          return { status: 'accepted', data: { restartRequested: true } };
        });
        mockDeps.createLiaraAdapter = vi.fn().mockReturnValue(adapter);
      });

      // Launch execution 1
      const exec1Promise = executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);

      // Wait until execution 1 reaches provider restart mutation
      await restartStartedPromise;

      // Now launch execution 2 for same run_1 and same worker_1 concurrently
      await expect(
        executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps)
      ).rejects.toThrow(/FencingError/);

      // Resume execution 1
      unpauseRestart!();

      // Execution 1 finishes with waiting_external / accepted_observed_healthy
      const exec1Result = await exec1Promise;
      expect(exec1Result.phase).toBe('accepted_observed_healthy');
      expect(exec1Result.output?.verification).toMatchObject({ providerAccepted: true });

      // Provider restartApp was called strictly once across both executions
      expect(restartCallCount).toBe(1);
    });

    it('rejects claim with FencingError when run has status running and active fresh lease in DB', async () => {
      mockDeps.resolveRun = vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        run: {
          id: 'run_1',
          workspaceId: 'ws_1',
          type: 'agent_action',
          status: 'running',
          claimedBy: 'worker_1',
          claimedAt: new Date(),
          heartbeatAt: new Date(), // fresh lease!
          input: { approvalId: 'appr_1' },
          output: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await expect(
        executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps)
      ).rejects.toThrow(/FencingError/);

      expect(mockDeps.claimRun).not.toHaveBeenCalled();
    });

    it('allows stale recovery takeover when run has status running but expired lease in DB', async () => {
      mockDeps.resolveRun = vi.fn().mockResolvedValue({
        workspaceId: 'ws_1',
        run: {
          id: 'run_1',
          workspaceId: 'ws_1',
          type: 'agent_action',
          status: 'running',
          claimedBy: 'worker_dead',
          claimedAt: new Date(Date.now() - 100_000),
          heartbeatAt: new Date(Date.now() - 60_000), // expired (>30s) lease!
          input: { approvalId: 'appr_1' },
          output: null,
          createdAt: new Date(Date.now() - 100_000),
          updatedAt: new Date(Date.now() - 60_000),
        },
      });

      const result = await executeApprovedAgentActionRun(mockPool, 'worker_1', 'run_1', 30, mockDeps);
      expect(result.phase).toBe('verified');
      expect(mockDeps.claimRun).toHaveBeenCalledWith(mockPool, 'worker_1', 'run_1', 30);
    });
  });
});
