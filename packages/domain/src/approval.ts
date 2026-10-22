import crypto from 'node:crypto';
import { z } from 'zod';
import { ActionPlanSchema, type ActionPlan } from './plan.js';
import { computeActionPlanHash, assertDescriptorSafe } from './canonical.js';
import { getSourceImmutableDigest } from './source.js';
import type { SecretRef } from '@laira/security';

export const ApprovalDecisionSchema = z.enum(['approved', 'rejected']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const DEFAULT_APPROVAL_EXPIRY_MINUTES = 30; // 30-min maximum dispatch expiry per spec
export const MAX_APPROVAL_EXPIRY_MS = 30 * 60 * 1000; // Exact 30 minutes

export const ApprovalSchema = z.object({
  id: z.string().min(1, 'Approval id is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  planId: z.string().min(1, 'planId is required'),
  planVersion: z.number().int().positive('planVersion must be positive integer'),
  planCanonicalHash: z.string().regex(/^[0-9a-f]{64}$/, 'planCanonicalHash must be 64-hex SHA-256'),
  ownerId: z.string().min(1, 'ownerId is required'),
  decision: ApprovalDecisionSchema,
  decidedAt: z.string().datetime({ message: 'decidedAt must be ISO 8601 UTC' }),
  expiresAt: z.string().datetime({ message: 'expiresAt must be ISO 8601 UTC' }),
  reason: z.string().nullable().optional(),
}).strict();

export type Approval = z.infer<typeof ApprovalSchema>;

export interface CreateApprovalParams {
  id?: string;
  plan: ActionPlan;
  ownerId: string;
  decision: ApprovalDecision;
  reason?: string;
  now?: Date;
  expiryMinutes?: number;
}

/**
 * Creates an Approval record that strictly binds the full plan canonical hash,
 * plan version, workspace, and owner identity.
 *
 * Enforces:
 * - Prevalidates raw plan descriptor-safety BEFORE any Zod parsing (0 getter calls).
 * - Recomputes and verifies the strict plan canonical hash (does not blindly trust embedded hash).
 * - Enforces maximum 30-minute dispatch expiry window.
 * - Strict schema parsing of plan at trust boundary.
 * - Validates timestamp sanity (rejects invalid Date / NaN).
 * - Uses crypto.randomUUID for default IDs.
 */
export function createApproval(params: CreateApprovalParams): Approval {
  // Pre-validate descriptor safety on raw plan before any Zod parse (0 getter calls)
  assertDescriptorSafe(params.plan);

  // Validate timestamp sanity
  const now = params.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Invalid now timestamp: Date must be valid');
  }

  // Parse plan schema at trust boundary
  const parsedPlan = ActionPlanSchema.parse(params.plan);

  // Enforce maximum 30 minutes window even if a custom expiry is passed
  if (params.expiryMinutes !== undefined && params.expiryMinutes > DEFAULT_APPROVAL_EXPIRY_MINUTES) {
    throw new Error(
      `Approval expiry duration (${params.expiryMinutes}m) exceeds the maximum allowed 30-minute dispatch window`
    );
  }

  const requestedMinutes = params.expiryMinutes ?? DEFAULT_APPROVAL_EXPIRY_MINUTES;
  if (requestedMinutes <= 0) {
    throw new Error('Approval expiry duration must be a positive number of minutes');
  }

  const expiryMinutes = Math.min(requestedMinutes, DEFAULT_APPROVAL_EXPIRY_MINUTES);
  const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);

  // Recompute plan hash to verify integrity rather than trusting embedded value
  const computedHash = computeActionPlanHash(parsedPlan);
  if (parsedPlan.canonicalHash && parsedPlan.canonicalHash !== computedHash) {
    throw new Error(
      `Plan embedded canonicalHash (${parsedPlan.canonicalHash}) does not match freshly computed hash (${computedHash})`
    );
  }

  const id = params.id ?? `appr_${crypto.randomUUID()}`;

  const approvalData = {
    id,
    workspaceId: parsedPlan.workspaceId,
    planId: parsedPlan.id,
    planVersion: parsedPlan.version,
    planCanonicalHash: computedHash,
    ownerId: params.ownerId,
    decision: params.decision,
    decidedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reason: params.reason ?? null,
  };

  assertDescriptorSafe(approvalData);
  return ApprovalSchema.parse(approvalData);
}

export interface ValidationIssue {
  code:
    | 'SCHEMA_PARSE_FAILED'
    | 'INVALID_TIMESTAMP'
    | 'APPROVAL_REJECTED'
    | 'APPROVAL_EXPIRED'
    | 'APPROVAL_IN_FUTURE'
    | 'APPROVAL_EXPIRY_WINDOW_EXCEEDED'
    | 'WORKSPACE_MISMATCH'
    | 'OWNER_MISMATCH'
    | 'PLAN_VERSION_MISMATCH'
    | 'APPROVAL_DRIFT_DETECTED'
    | 'INVALID_PLAN_HASH'
    | 'DUPLICATE_STEP_ID'
    | 'INVALID_STEP_DEPENDENCY'
    | 'DEPENDENCY_CYCLE'
    | 'INVALID_RESOURCE_BINDING'
    | 'INVALID_PRECONDITION'
    | 'AMBIGUOUS_SECRET_REF'
    | 'DANGLING_SECRET_REF'
    | 'SOURCE_DIGEST_MISMATCH';
  message: string;
}

export interface ApprovalValidationResult {
  valid: boolean;
  /**
   * Clarifies that precondition checks in this phase are structural only.
   * Live observed state verification against provider APIs is deferred to the execution broker at dispatch.
   */
  preconditionVerification: 'structural_only';
  issues: ValidationIssue[];
}

export interface ValidateApprovalForDispatchParams {
  approval: Approval;
  plan: ActionPlan;
  expectedWorkspaceId: string;
  expectedOwnerId: string;
  now?: Date;
}

/**
 * Validates an approval before dispatching operations.
 *
 * Enforces:
 * - Pre-validates raw approval AND plan descriptor safety BEFORE any Zod parsing (0 getter calls).
 * - Strict schema validation at trust boundary.
 * - Timestamp sanity checks (rejects invalid Date / NaN).
 * - Exact expiry check (now >= expiresAt is rejected).
 * - Future approval check (now < decidedAt is rejected).
 * - Maximum 30-minute approval duration check.
 * - Workspace and Owner match across all plan elements.
 * - Full canonical hash equality (zero approval drift).
 * - Scoped resource refs, secret refs, and preconditions strictly belong to plan workspace.
 * - Unique step IDs and valid topological dependency order without cycles.
 * - Logical resource binding uniqueness.
 * - Resolves all variable secretRefIds to exactly one plan.secretRefs entry (no dangling/ambiguous refs).
 * - Enforces deploy sourceDigest equals sourceRef immutable digest.
 *
 * Precondition verification note:
 * Structural well-formedness and workspace scoping of preconditions are verified here.
 * Live observed state verification of preconditions is deferred to execution broker at dispatch.
 */
export function validateApprovalForDispatch(
  params: ValidateApprovalForDispatchParams
): ApprovalValidationResult {
  const issues: ValidationIssue[] = [];

  // Pre-validate descriptor safety of raw approval AND raw plan BEFORE any Zod parsing
  // Guarantees zero getters are executed and non-enumerable extras are rejected immediately
  try {
    assertDescriptorSafe(params.approval);
  } catch (err) {
    issues.push({
      code: 'SCHEMA_PARSE_FAILED',
      message: `Approval descriptor safety failed: ${err instanceof Error ? err.message : 'Invalid descriptor'}`,
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }

  try {
    assertDescriptorSafe(params.plan);
  } catch (err) {
    issues.push({
      code: 'SCHEMA_PARSE_FAILED',
      message: `Plan descriptor safety failed: ${err instanceof Error ? err.message : 'Invalid descriptor'}`,
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }

  // Validate timestamp sanity
  const now = params.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    issues.push({
      code: 'INVALID_TIMESTAMP',
      message: 'Invalid current timestamp: now must be a valid Date',
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }

  // 1. Trust boundary: parse schemas with Zod
  const parsedApprovalResult = ApprovalSchema.safeParse(params.approval);
  if (!parsedApprovalResult.success) {
    issues.push({
      code: 'SCHEMA_PARSE_FAILED',
      message: `Invalid approval object: ${parsedApprovalResult.error.message}`,
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }
  const approval = parsedApprovalResult.data;

  const parsedPlanResult = ActionPlanSchema.safeParse(params.plan);
  if (!parsedPlanResult.success) {
    issues.push({
      code: 'SCHEMA_PARSE_FAILED',
      message: `Invalid action plan object: ${parsedPlanResult.error.message}`,
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }
  const plan = parsedPlanResult.data;

  // 2. Decision check
  if (approval.decision !== 'approved') {
    issues.push({
      code: 'APPROVAL_REJECTED',
      message: `Cannot dispatch plan: approval status is "${approval.decision}"`,
    });
  }

  // 3. Timing checks
  const decidedAtTime = new Date(approval.decidedAt).getTime();
  const expiresAtTime = new Date(approval.expiresAt).getTime();
  const nowTime = now.getTime();

  if (Number.isNaN(decidedAtTime) || Number.isNaN(expiresAtTime)) {
    issues.push({
      code: 'INVALID_TIMESTAMP',
      message: 'Approval decidedAt or expiresAt is an unparseable timestamp',
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }

  // 3a. Future approval check
  if (nowTime < decidedAtTime) {
    issues.push({
      code: 'APPROVAL_IN_FUTURE',
      message: `Approval decidedAt (${approval.decidedAt}) is in the future compared to current time (${now.toISOString()})`,
    });
  }

  // 3b. Exact expiry check (now >= expiresAt is invalid)
  if (nowTime >= expiresAtTime) {
    issues.push({
      code: 'APPROVAL_EXPIRED',
      message: `Approval expired at ${approval.expiresAt}. 30-minute dispatch window has elapsed.`,
    });
  }

  // 3c. Maximum 30 minutes duration check
  if (expiresAtTime - decidedAtTime > MAX_APPROVAL_EXPIRY_MS) {
    issues.push({
      code: 'APPROVAL_EXPIRY_WINDOW_EXCEEDED',
      message: `Approval validity duration exceeds maximum allowed 30 minutes (${(expiresAtTime - decidedAtTime) / 60000}m)`,
    });
  }

  // 4. Workspace binding checks
  if (approval.workspaceId !== params.expectedWorkspaceId) {
    issues.push({
      code: 'WORKSPACE_MISMATCH',
      message: `Approval workspace (${approval.workspaceId}) does not match expected workspace (${params.expectedWorkspaceId})`,
    });
  }
  if (plan.workspaceId !== params.expectedWorkspaceId) {
    issues.push({
      code: 'WORKSPACE_MISMATCH',
      message: `Plan workspace (${plan.workspaceId}) does not match expected workspace (${params.expectedWorkspaceId})`,
    });
  }

  // 5. Owner identity check
  if (approval.ownerId !== params.expectedOwnerId) {
    issues.push({
      code: 'OWNER_MISMATCH',
      message: `Approval owner (${approval.ownerId}) does not match expected dispatch owner (${params.expectedOwnerId})`,
    });
  }

  // 6. Plan ID and Version binding check
  if (approval.planId !== plan.id) {
    issues.push({
      code: 'PLAN_VERSION_MISMATCH',
      message: `Approval planId (${approval.planId}) does not match current plan id (${plan.id})`,
    });
  }
  if (approval.planVersion !== plan.version) {
    issues.push({
      code: 'PLAN_VERSION_MISMATCH',
      message: `Approval planVersion (${approval.planVersion}) does not match current plan version (${plan.version})`,
    });
  }

  // 7. Zero Approval Drift check via strict canonical hash
  let currentComputedHash: string;
  try {
    currentComputedHash = computeActionPlanHash(plan);
  } catch (err) {
    issues.push({
      code: 'INVALID_PLAN_HASH',
      message: `Failed to compute plan hash: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, preconditionVerification: 'structural_only', issues };
  }

  if (plan.canonicalHash !== currentComputedHash) {
    issues.push({
      code: 'INVALID_PLAN_HASH',
      message: `Plan embedded canonicalHash (${plan.canonicalHash}) does not match computed hash (${currentComputedHash})`,
    });
  }

  if (approval.planCanonicalHash !== currentComputedHash) {
    issues.push({
      code: 'APPROVAL_DRIFT_DETECTED',
      message: `Approval drift detected: approval canonical hash (${approval.planCanonicalHash}) differs from current plan hash (${currentComputedHash})`,
    });
  }

  // 8. Scope checks across all nested references (resource refs, secret refs, preconditions)
  const targetWorkspace = plan.workspaceId;

  for (const step of plan.steps) {
    if (step.targetResource.workspaceId !== targetWorkspace) {
      issues.push({
        code: 'WORKSPACE_MISMATCH',
        message: `Step "${step.stepId}" targetResource belongs to workspace "${step.targetResource.workspaceId}" instead of plan workspace "${targetWorkspace}"`,
      });
    }
  }

  // Check secretRefs for duplicates / ambiguity
  const secretRefMap = new Map<string, SecretRef>();
  const duplicateSecretIds = new Set<string>();

  for (const secretRef of plan.secretRefs) {
    if (secretRef.workspaceId !== targetWorkspace) {
      issues.push({
        code: 'WORKSPACE_MISMATCH',
        message: `SecretRef "${secretRef.secretId}" belongs to workspace "${secretRef.workspaceId}" instead of plan workspace "${targetWorkspace}"`,
      });
    }

    if (secretRefMap.has(secretRef.secretId)) {
      duplicateSecretIds.add(secretRef.secretId);
    } else {
      secretRefMap.set(secretRef.secretId, secretRef);
    }
  }

  for (const dupId of duplicateSecretIds) {
    issues.push({
      code: 'AMBIGUOUS_SECRET_REF',
      message: `Duplicate secretId "${dupId}" detected in plan.secretRefs: references must map to exactly one secretRef`,
    });
  }

  for (const prec of plan.preconditions) {
    if (prec.targetResource.workspaceId !== targetWorkspace) {
      issues.push({
        code: 'WORKSPACE_MISMATCH',
        message: `Precondition "${prec.id}" targetResource belongs to workspace "${prec.targetResource.workspaceId}" instead of plan workspace "${targetWorkspace}"`,
      });
    }
  }

  // 9. Step ID uniqueness and DAG dependency ordering (no forward refs, no cycles)
  const seenStepIds = new Set<string>();
  const stepIndexMap = new Map<string, number>();

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    if (seenStepIds.has(step.stepId)) {
      issues.push({
        code: 'DUPLICATE_STEP_ID',
        message: `Duplicate stepId detected in plan: "${step.stepId}"`,
      });
    }
    seenStepIds.add(step.stepId);
    stepIndexMap.set(step.stepId, i);
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;

    // Validate deploy step sourceDigest vs plan.sourceRef
    if (step.type === 'liara.app.deploy') {
      const expectedDigest = getSourceImmutableDigest(plan.sourceRef);
      if (step.parameters.sourceDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
        issues.push({
          code: 'SOURCE_DIGEST_MISMATCH',
          message: `Deploy step "${step.stepId}" sourceDigest "${step.parameters.sourceDigest}" does not match plan sourceRef immutable digest "${expectedDigest}"`,
        });
      }
    }

    // Validate env_set step variables mapping to secretRefs
    if (step.type === 'liara.app.env_set') {
      for (const variable of step.parameters.variables) {
        if (variable.secretRefId) {
          if (duplicateSecretIds.has(variable.secretRefId)) {
            issues.push({
              code: 'AMBIGUOUS_SECRET_REF',
              message: `Step "${step.stepId}" variable "${variable.key}" references ambiguous duplicate secretRefId "${variable.secretRefId}"`,
            });
          } else {
            const boundSecret = secretRefMap.get(variable.secretRefId);
            if (!boundSecret) {
              issues.push({
                code: 'DANGLING_SECRET_REF',
                message: `Step "${step.stepId}" variable "${variable.key}" references dangling secretRefId "${variable.secretRefId}" not found in plan.secretRefs`,
              });
            } else if (boundSecret.workspaceId !== targetWorkspace) {
              issues.push({
                code: 'WORKSPACE_MISMATCH',
                message: `Step "${step.stepId}" variable "${variable.key}" references secret "${variable.secretRefId}" from workspace "${boundSecret.workspaceId}" instead of plan workspace "${targetWorkspace}"`,
              });
            }
          }
        }
      }
    }

    for (const depId of step.dependsOn) {
      if (depId === step.stepId) {
        issues.push({
          code: 'DEPENDENCY_CYCLE',
          message: `Step "${step.stepId}" cannot depend on itself`,
        });
        continue;
      }

      const depIndex = stepIndexMap.get(depId);
      if (depIndex === undefined) {
        issues.push({
          code: 'INVALID_STEP_DEPENDENCY',
          message: `Step "${step.stepId}" depends on non-existent step "${depId}"`,
        });
      } else if (depIndex >= i) {
        // Forward reference or cycle in ordered execution list
        issues.push({
          code: 'INVALID_STEP_DEPENDENCY',
          message: `Step "${step.stepId}" depends on step "${depId}" which is placed later in the execution plan`,
        });
      }
    }
  }

  // 10. Logical resource bindings uniqueness
  const logicalResourceIds = new Set<string>();
  const boundProviderIds = new Set<string>();

  for (const binding of plan.resourceBindings) {
    if (logicalResourceIds.has(binding.logicalResourceId)) {
      issues.push({
        code: 'INVALID_RESOURCE_BINDING',
        message: `Duplicate logicalResourceId in bindings: "${binding.logicalResourceId}"`,
      });
    }
    logicalResourceIds.add(binding.logicalResourceId);

    if (binding.logicalRef.workspaceId !== targetWorkspace) {
      issues.push({
        code: 'WORKSPACE_MISMATCH',
        message: `Resource binding logicalRef belongs to workspace "${binding.logicalRef.workspaceId}" instead of "${targetWorkspace}"`,
      });
    }

    if (binding.boundProviderId) {
      if (boundProviderIds.has(binding.boundProviderId)) {
        issues.push({
          code: 'INVALID_RESOURCE_BINDING',
          message: `Duplicate provider resource ID binding: "${binding.boundProviderId}"`,
        });
      }
      boundProviderIds.add(binding.boundProviderId);
    }
  }

  return {
    valid: issues.length === 0,
    preconditionVerification: 'structural_only',
    issues,
  };
}
