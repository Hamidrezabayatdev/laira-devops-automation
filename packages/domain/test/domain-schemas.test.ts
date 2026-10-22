import { describe, it, expect } from 'vitest';
import { ResourceRefSchema } from '../src/resource.js';
import { SourceRefSchema, MAX_SOURCE_ARCHIVE_BYTES } from '../src/source.js';
import { EvidenceRefSchema } from '../src/evidence.js';
import { FindingSchema } from '../src/finding.js';
import { ActionPlanSchema, EnvVariableEntrySchema, LiaraAppEnvSetStepSchema } from '../src/plan.js';
import { OperationSchema } from '../src/operation.js';
import { RunEventSchema } from '../src/event.js';
import { CapabilitySchema } from '../src/capability.js';
import { UsageRecordSchema } from '../src/usage.js';
import { WorkflowVersionSchema } from '../src/workflow.js';
import {
  RunStateSchema,
  isTerminalRunState,
  isWaitingRunState,
} from '../src/run-state.js';

describe('Domain Schemas & Validation', () => {
  describe('ResourceRefSchema', () => {
    it('validates a correct ResourceRef', () => {
      const valid = {
        workspaceId: 'ws_1',
        connectionId: 'conn_1',
        type: 'app',
        slug: 'my-service',
        displayName: 'My Service App',
      };
      expect(ResourceRefSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects invalid slugs (uppercase, spaces, special symbols)', () => {
      const invalid = {
        workspaceId: 'ws_1',
        connectionId: 'conn_1',
        type: 'app',
        slug: 'My Service_Invalid!',
      };
      expect(ResourceRefSchema.safeParse(invalid).success).toBe(false);
    });
  });

  describe('SourceRefSchema', () => {
    it('validates valid Git source with 40-char commit SHA', () => {
      const gitSource = {
        sourceType: 'git',
        repository: 'org/repo',
        commitSha: 'a'.repeat(40),
      };
      expect(SourceRefSchema.safeParse(gitSource).success).toBe(true);
    });

    it('rejects invalid commit SHA format', () => {
      const gitSource = {
        sourceType: 'git',
        repository: 'org/repo',
        commitSha: 'not-a-valid-sha',
      };
      expect(SourceRefSchema.safeParse(gitSource).success).toBe(false);
    });

    it('validates archive source with sha256 digest', () => {
      const archiveSource = {
        sourceType: 'archive',
        archiveDigest: `sha256:${'b'.repeat(64)}`,
        artifactStoragePath: 's3://artifacts/source.tar.gz',
        byteSize: 1024 * 1024,
      };
      expect(SourceRefSchema.safeParse(archiveSource).success).toBe(true);
    });

    it('rejects archive exceeding 50 MiB upload limit', () => {
      const hugeArchive = {
        sourceType: 'archive',
        archiveDigest: `sha256:${'c'.repeat(64)}`,
        artifactStoragePath: 's3://artifacts/huge.zip',
        byteSize: MAX_SOURCE_ARCHIVE_BYTES + 1,
      };
      expect(SourceRefSchema.safeParse(hugeArchive).success).toBe(false);
    });
  });

  describe('EvidenceRefSchema', () => {
    it('validates a complete EvidenceRef with ISO 8601 timestamps', () => {
      const evidence = {
        evidenceId: 'ev_123',
        workspaceId: 'ws_1',
        scope: 'incident',
        source: 'health_check',
        capturedAt: '2026-10-22T10:00:00.000Z',
        expiresAt: '2026-10-29T10:00:00.000Z',
        integrityDigest: `sha256:${'d'.repeat(64)}`,
        contentType: 'application/json',
        sizeBytes: 512,
      };
      expect(EvidenceRefSchema.safeParse(evidence).success).toBe(true);
    });

    it('rejects malformed integrity digest', () => {
      const evidence = {
        evidenceId: 'ev_123',
        workspaceId: 'ws_1',
        scope: 'incident',
        source: 'health_check',
        capturedAt: '2026-10-22T10:00:00.000Z',
        expiresAt: '2026-10-29T10:00:00.000Z',
        integrityDigest: 'md5:bad',
        contentType: 'application/json',
        sizeBytes: 512,
      };
      expect(EvidenceRefSchema.safeParse(evidence).success).toBe(false);
    });
  });

  describe('FindingSchema', () => {
    it('validates a Finding citing evidence and limitations', () => {
      const finding = {
        id: 'find_1',
        workspaceId: 'ws_1',
        statement: 'Application container crashed due to OOMKilled state',
        evidenceIds: ['ev_log_1', 'ev_metric_2'],
        confidence: 0.95,
        limitations: ['Network ingress metrics were unavailable during crash'],
        category: 'verified_cause',
        createdAt: '2026-10-22T10:02:00.000Z',
      };
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });

    it('rejects a Finding with empty evidenceIds', () => {
      const finding = {
        id: 'find_1',
        workspaceId: 'ws_1',
        statement: 'Guess without evidence',
        evidenceIds: [],
        confidence: 0.5,
        limitations: [],
        category: 'hypothesis',
        createdAt: '2026-10-22T10:02:00.000Z',
      };
      expect(FindingSchema.safeParse(finding).success).toBe(false);
    });
  });

  describe('ActionPlan Bounded Typed Steps (No Arbitrary Shell)', () => {
    it('rejects ActionPlan containing arbitrary shell steps', () => {
      const planWithShellStep = {
        id: 'plan_malicious',
        version: 1,
        workspaceId: 'ws_1',
        projectId: 'app_1',
        sourceRef: {
          sourceType: 'git',
          repository: 'org/repo',
          commitSha: 'a'.repeat(40),
        },
        steps: [
          {
            stepId: 'step_shell',
            type: 'shell.exec', // Arbitrary shell execution!
            title: 'Run curl script',
            description: 'Execute bash command',
            targetResource: {
              workspaceId: 'ws_1',
              connectionId: 'conn_1',
              type: 'app',
              slug: 'app-1',
            },
            parameters: {
              command: 'rm -rf /',
            },
          },
        ],
        resourceBindings: [],
        secretRefs: [],
        preconditions: [],
        estimatedCost: {
          estimatedModelTokens: 100,
          estimatedCatalogUsd: 0.01,
          providerCostEstimate: null,
          providerCurrency: null,
          unknowns: [],
        },
        disruption: {
          level: 'none',
          description: 'none',
          downtimeExpected: false,
        },
        verification: {
          probes: [
            {
              probeId: 'probe_1',
              type: 'http_health_check',
              timeoutSeconds: 30,
            },
          ],
          maxWaitSeconds: 60,
        },
        canonicalHash: 'e'.repeat(64),
        createdAt: '2026-10-22T10:00:00.000Z',
      };

      const result = ActionPlanSchema.safeParse(planWithShellStep);
      expect(result.success).toBe(false);
    });

    it('EnvVariableEntrySchema enforces exactly one of staticValue or non-empty secretRefId', () => {
      // 1. Both provided -> invalid
      expect(
        EnvVariableEntrySchema.safeParse({
          key: 'DATABASE_URL',
          staticValue: 'postgres://localhost:5432/db',
          secretRefId: 'sec_db_url',
        }).success
      ).toBe(false);

      // 2. Neither provided -> invalid
      expect(
        EnvVariableEntrySchema.safeParse({
          key: 'DATABASE_URL',
        }).success
      ).toBe(false);

      // 3. Only secretRefId -> valid
      expect(
        EnvVariableEntrySchema.safeParse({
          key: 'DATABASE_URL',
          secretRefId: 'sec_db_url',
        }).success
      ).toBe(true);

      // 4. Only staticValue -> valid
      expect(
        EnvVariableEntrySchema.safeParse({
          key: 'NODE_ENV',
          staticValue: 'production',
        }).success
      ).toBe(true);
    });
  });

  describe('OperationSchema', () => {
    it('validates Operation with stable ID and reservations', () => {
      const op = {
        operationId: 'op_deploy_99',
        workspaceId: 'ws_1',
        planId: 'plan_1',
        stepId: 'step_1',
        correlationId: 'corr_xyz',
        status: 'pending',
        resourceReservations: ['res_app_slug'],
        dispatchClaimedAt: '2026-10-22T10:00:00.000Z',
      };
      expect(OperationSchema.safeParse(op).success).toBe(true);
    });
  });

  describe('RunEventSchema', () => {
    it('validates RunEvent with monotonic sequence number', () => {
      const event = {
        eventId: 'evt_1',
        runId: 'run_123',
        workspaceId: 'ws_1',
        sequenceNumber: 1,
        type: 'step.dispatched',
        safePayload: { stepId: 'step_1', status: 'dispatched' },
        timestamp: '2026-10-22T10:01:00.000Z',
      };
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    });

    it('rejects negative or zero sequence number', () => {
      const event = {
        eventId: 'evt_1',
        runId: 'run_123',
        workspaceId: 'ws_1',
        sequenceNumber: 0,
        type: 'step.dispatched',
        safePayload: {},
        timestamp: '2026-10-22T10:01:00.000Z',
      };
      expect(RunEventSchema.safeParse(event).success).toBe(false);
    });
  });

  describe('CapabilitySchema', () => {
    it('validates Capability record', () => {
      const cap = {
        workspaceId: 'ws_1',
        connectionId: 'conn_1',
        feature: 'app.deploy',
        status: 'supported',
        evidence: 'Account verified via release creation smoke test',
        lastVerifiedAt: '2026-10-22T09:00:00.000Z',
      };
      expect(CapabilitySchema.safeParse(cap).success).toBe(true);
    });
  });

  describe('UsageRecordSchema', () => {
    it('validates UsageRecord separating catalog estimate from provider cost', () => {
      const usage = {
        id: 'usage_1',
        workspaceId: 'ws_1',
        runId: 'run_1',
        model: 'qwen/qwen3.7-flash',
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        cachedTokens: 200,
        providerCost: null, // BoxAPI doesn't return account billing guarantee
        providerCostUnit: null,
        catalogEstimateUsd: 0.00008,
        source: 'boxapi',
        createdAt: '2026-10-22T10:05:00.000Z',
      };
      expect(UsageRecordSchema.safeParse(usage).success).toBe(true);
    });
  });

  describe('WorkflowVersionSchema', () => {
    it('validates bounded WorkflowVersion', () => {
      const wf = {
        workflowId: 'wf_health_diag',
        version: 1,
        name: 'Health Check Diagnosis',
        description: 'Diagnose failing HTTP probes',
        provenance: 'curated',
        allowedTools: ['liara.get_app_logs', 'probe.http_get'],
        preconditions: [],
        steps: [
          {
            stepId: 'wf_step_1',
            name: 'Fetch Recent Logs',
            tool: 'liara.get_app_logs',
            parameters: { tailLines: 100 },
            timeoutMs: 15000,
          },
        ],
        outputLimits: {
          maxOutputTokens: 1200,
          maxExecutionTimeMs: 60000,
        },
        validationRules: ['Zero model mutation authority'],
        createdAt: '2026-10-22T08:00:00.000Z',
      };
      expect(WorkflowVersionSchema.safeParse(wf).success).toBe(true);
    });
  });

  describe('RunStateSchema & Predicates', () => {
    it('validates all 10 explicit run states', () => {
      const states = [
        'queued',
        'running',
        'waiting_input',
        'waiting_approval',
        'waiting_external',
        'verifying',
        'succeeded',
        'failed',
        'cancelled',
        'outcome_unknown',
      ] as const;

      for (const s of states) {
        expect(RunStateSchema.safeParse(s).success).toBe(true);
      }
    });

    it('correctly categorizes terminal and waiting run states', () => {
      expect(isTerminalRunState('succeeded')).toBe(true);
      expect(isTerminalRunState('failed')).toBe(true);
      expect(isTerminalRunState('cancelled')).toBe(true);
      expect(isTerminalRunState('outcome_unknown')).toBe(true);
      expect(isTerminalRunState('running')).toBe(false);

      expect(isWaitingRunState('waiting_approval')).toBe(true);
      expect(isWaitingRunState('waiting_input')).toBe(true);
      expect(isWaitingRunState('waiting_external')).toBe(true);
      expect(isWaitingRunState('running')).toBe(false);
    });
  });
});
