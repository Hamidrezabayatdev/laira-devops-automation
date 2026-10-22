import { describe, it, expect } from 'vitest';
import {
  createApproval,
  validateApprovalForDispatch,
  DEFAULT_APPROVAL_EXPIRY_MINUTES,
} from '../src/approval.js';
import { computeActionPlanHash } from '../src/canonical.js';
import type { ActionPlan } from '../src/plan.js';
import { createSecretRef } from '@laira/security';

function createValidPlan(): ActionPlan {
  const secretRef = createSecretRef({
    secretId: 'sec_api_key',
    name: 'LIARA_API_TOKEN',
    version: 1,
    workspaceId: 'ws_prod_01',
    createdAt: '2026-10-22T08:00:00.000Z',
  });

  const base: Omit<ActionPlan, 'canonicalHash'> = {
    id: 'plan_scale_01',
    version: 1,
    workspaceId: 'ws_prod_01',
    projectId: 'payment-svc',
    sourceRef: {
      sourceType: 'git',
      repository: 'starcoach/payment-svc',
      commitSha: '1111222233334444555566667777888899990000',
    },
    steps: [
      {
        stepId: 'step_resize_app',
        type: 'liara.app.resize',
        title: 'Scale payment service',
        description: 'Upgrade plan from standard to performance',
        targetResource: {
          workspaceId: 'ws_prod_01',
          connectionId: 'conn_prod_liara',
          type: 'app',
          slug: 'payment-svc',
        },
        dependsOn: [],
        disruption: 'low',
        parameters: {
          targetPlan: 'performance',
        },
      },
    ],
    resourceBindings: [],
    secretRefs: [secretRef],
    preconditions: [
      {
        id: 'prec_online',
        description: 'App must be running',
        targetResource: {
          workspaceId: 'ws_prod_01',
          connectionId: 'conn_prod_liara',
          type: 'app',
          slug: 'payment-svc',
        },
        expectedState: { status: 'running' },
      },
    ],
    estimatedCost: {
      estimatedModelTokens: 800,
      estimatedCatalogUsd: 0.02,
      providerCostEstimate: 200,
      providerCurrency: 'IRR',
      unknowns: [],
    },
    disruption: {
      level: 'low',
      description: 'Brief rolling restart',
      downtimeExpected: false,
    },
    verification: {
      probes: [
        {
          probeId: 'probe_health',
          type: 'http_health_check',
          targetUrl: 'https://payment-svc.liara.run/healthz',
          expectedStatus: 200,
          timeoutSeconds: 30,
        },
      ],
      maxWaitSeconds: 120,
    },
    proposedRecovery: null,
    createdAt: '2026-10-22T08:15:00.000Z',
  };

  const hash = computeActionPlanHash(base);
  return { ...base, canonicalHash: hash };
}

describe('Approval & Dispatch Validation (Zero Drift & Expiry)', () => {
  const ownerId = 'github_user_hamidreza';
  const expectedWorkspace = 'ws_prod_01';

  it('validates a fresh matching approval successfully', () => {
    const plan = createValidPlan();
    const decidedAt = new Date('2026-10-22T08:20:00.000Z');

    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      now: decidedAt,
    });

    const result = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:25:00.000Z'), // 5 minutes after decision
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('fails dispatch validation when approval exceeds 30-min expiry window', () => {
    const plan = createValidPlan();
    const decidedAt = new Date('2026-10-22T08:20:00.000Z');

    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      now: decidedAt,
    });

    // 29 minutes later: still valid
    const validResult = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:49:00.000Z'),
    });
    expect(validResult.valid).toBe(true);

    // 31 minutes later: expired!
    const expiredResult = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:51:00.000Z'),
    });
    expect(expiredResult.valid).toBe(false);
    expect(expiredResult.issues.some((i) => i.code === 'APPROVAL_EXPIRED')).toBe(true);
  });

  it('fails dispatch validation on owner mismatch', () => {
    const plan = createValidPlan();
    const approval = createApproval({
      plan,
      ownerId: 'github_user_hamidreza',
      decision: 'approved',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: 'github_user_attacker',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'OWNER_MISMATCH')).toBe(true);
  });

  it('fails dispatch validation on workspace mismatch', () => {
    const plan = createValidPlan();
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: 'ws_different_tenant',
      expectedOwnerId: ownerId,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'WORKSPACE_MISMATCH')).toBe(true);
  });

  it('fails dispatch validation when approval was rejected', () => {
    const plan = createValidPlan();
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'rejected',
      reason: 'Plan is too expensive',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'APPROVAL_REJECTED')).toBe(true);
  });

  it('detects approval drift when plan is modified after approval was signed', () => {
    const plan = createValidPlan();
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
    });

    // Subtly mutate plan parameters after approval
    const driftedPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          parameters: { targetPlan: 'ultra_large_expensive' },
        },
      ],
      // Recalculate embedded plan hash to simulate someone updating the plan row
      canonicalHash: '',
    };
    driftedPlan.canonicalHash = computeActionPlanHash(driftedPlan);

    const result = validateApprovalForDispatch({
      approval,
      plan: driftedPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'APPROVAL_DRIFT_DETECTED')).toBe(true);
  });

  it('rejects approval at exact expiry boundary (now >= expiresAt)', () => {
    const plan = createValidPlan();
    const decidedAt = new Date('2026-10-22T08:00:00.000Z');
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      now: decidedAt,
      expiryMinutes: 10,
    });

    // Exactly at expiry (08:10:00.000Z)
    const exactExpiryResult = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:10:00.000Z'),
    });
    expect(exactExpiryResult.valid).toBe(false);
    expect(exactExpiryResult.issues.some((i) => i.code === 'APPROVAL_EXPIRED')).toBe(true);

    // 1 millisecond before expiry (08:09:59.999Z) is still valid
    const justBeforeExpiryResult = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:09:59.999Z'),
    });
    expect(justBeforeExpiryResult.valid).toBe(true);
  });

  it('rejects future approval (now < decidedAt)', () => {
    const plan = createValidPlan();
    const decidedAt = new Date('2026-10-22T08:30:00.000Z');
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      now: decidedAt,
    });

    const futureResult = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:29:59.000Z'), // 1 second before decision
    });
    expect(futureResult.valid).toBe(false);
    expect(futureResult.issues.some((i) => i.code === 'APPROVAL_IN_FUTURE')).toBe(true);
  });

  it('enforces maximum 30-minute window for custom expiry duration in createApproval', () => {
    const plan = createValidPlan();

    // Custom expiry > 30 min is rejected
    expect(() =>
      createApproval({
        plan,
        ownerId,
        decision: 'approved',
        expiryMinutes: 45,
      })
    ).toThrow(/exceeds the maximum allowed 30-minute dispatch window/);

    // Custom expiry <= 0 is rejected
    expect(() =>
      createApproval({
        plan,
        ownerId,
        decision: 'approved',
        expiryMinutes: 0,
      })
    ).toThrow(/positive number of minutes/);

    // Custom expiry within 30 min is accepted
    const customApproval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      expiryMinutes: 15,
      now: new Date('2026-10-22T08:00:00.000Z'),
    });
    expect(customApproval.expiresAt).toBe('2026-10-22T08:15:00.000Z');
  });

  it('detects validity window exceeding 30 minutes in validateApprovalForDispatch', () => {
    const plan = createValidPlan();
    const approval = createApproval({
      plan,
      ownerId,
      decision: 'approved',
      now: new Date('2026-10-22T08:00:00.000Z'),
    });

    // Manually crafted approval with >30 min window
    const forgedWindowApproval = {
      ...approval,
      expiresAt: '2026-10-22T08:45:00.000Z', // 45 minutes
    };

    const result = validateApprovalForDispatch({
      approval: forgedWindowApproval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date('2026-10-22T08:05:00.000Z'),
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'APPROVAL_EXPIRY_WINDOW_EXCEEDED')).toBe(true);
  });

  it('createApproval recomputes and verifies embedded hash without blindly trusting it', () => {
    const plan = createValidPlan();
    const tamperedPlan = {
      ...plan,
      canonicalHash: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() =>
      createApproval({
        plan: tamperedPlan,
        ownerId,
        decision: 'approved',
      })
    ).toThrow(/does not match freshly computed hash/);
  });

  it('rejects cross-workspace step targetResource', () => {
    const plan = createValidPlan();
    const badStepPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          targetResource: {
            ...plan.steps[0]!.targetResource,
            workspaceId: 'ws_other_tenant',
          },
        },
      ],
    };
    badStepPlan.canonicalHash = computeActionPlanHash(badStepPlan);

    const approval = createApproval({
      plan: badStepPlan,
      ownerId,
      decision: 'approved',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan: badStepPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'WORKSPACE_MISMATCH')).toBe(true);
  });

  it('rejects cross-workspace secretRefs and preconditions', () => {
    const plan = createValidPlan();
    const crossSecretRef = createSecretRef({
      secretId: 'sec_other',
      name: 'OTHER_SECRET',
      version: 1,
      workspaceId: 'ws_other_tenant',
      createdAt: '2026-10-22T08:00:00.000Z',
    });

    const badSecretPlan: ActionPlan = {
      ...plan,
      secretRefs: [crossSecretRef],
    };
    badSecretPlan.canonicalHash = computeActionPlanHash(badSecretPlan);

    const approval = createApproval({
      plan: badSecretPlan,
      ownerId,
      decision: 'approved',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan: badSecretPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'WORKSPACE_MISMATCH')).toBe(true);
  });

  it('rejects duplicate step IDs and cyclical / forward step dependencies', () => {
    const plan = createValidPlan();

    // 1. Duplicate step IDs
    const dupStepPlan: ActionPlan = {
      ...plan,
      steps: [plan.steps[0]!, plan.steps[0]!],
    };
    dupStepPlan.canonicalHash = computeActionPlanHash(dupStepPlan);

    const dupApproval = createApproval({ plan: dupStepPlan, ownerId, decision: 'approved' });
    const dupResult = validateApprovalForDispatch({
      approval: dupApproval,
      plan: dupStepPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(dupResult.valid).toBe(false);
    expect(dupResult.issues.some((i) => i.code === 'DUPLICATE_STEP_ID')).toBe(true);

    // 2. Self-dependency
    const selfDepPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          dependsOn: [plan.steps[0]!.stepId],
        },
      ],
    };
    selfDepPlan.canonicalHash = computeActionPlanHash(selfDepPlan);
    const selfApproval = createApproval({ plan: selfDepPlan, ownerId, decision: 'approved' });
    const selfResult = validateApprovalForDispatch({
      approval: selfApproval,
      plan: selfDepPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(selfResult.valid).toBe(false);
    expect(selfResult.issues.some((i) => i.code === 'DEPENDENCY_CYCLE')).toBe(true);

    // 3. Non-existent dependency
    const missingDepPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          dependsOn: ['step_does_not_exist'],
        },
      ],
    };
    missingDepPlan.canonicalHash = computeActionPlanHash(missingDepPlan);
    const missingApproval = createApproval({ plan: missingDepPlan, ownerId, decision: 'approved' });
    const missingResult = validateApprovalForDispatch({
      approval: missingApproval,
      plan: missingDepPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(missingResult.valid).toBe(false);
    expect(missingResult.issues.some((i) => i.code === 'INVALID_STEP_DEPENDENCY')).toBe(true);
  });

  it('rejects invalid Date (NaN) timestamp in createApproval and validateApprovalForDispatch', () => {
    const plan = createValidPlan();

    // 1. Invalid now in createApproval
    expect(() =>
      createApproval({
        plan,
        ownerId,
        decision: 'approved',
        now: new Date(NaN),
      })
    ).toThrow(/Invalid now timestamp/);

    // 2. Invalid now in validateApprovalForDispatch
    const validApproval = createApproval({ plan, ownerId, decision: 'approved' });
    const invalidNowResult = validateApprovalForDispatch({
      approval: validApproval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
      now: new Date(NaN),
    });
    expect(invalidNowResult.valid).toBe(false);
    expect(invalidNowResult.issues.some((i) => i.code === 'INVALID_TIMESTAMP')).toBe(true);
  });

  it('rejects deploy step when sourceDigest differs from plan.sourceRef immutable digest', () => {
    const plan = createValidPlan();
    const commitSha = (plan.sourceRef as { commitSha: string }).commitSha;

    // Reproduces verifier finding: source commitSha is '1111...' but deploy sourceDigest is 'bbbb...'
    const mismatchedDeployPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          stepId: 'step_deploy_app',
          type: 'liara.app.deploy',
          title: 'Deploy payment service',
          description: 'Deploy code to Liara',
          targetResource: {
            workspaceId: 'ws_prod_01',
            connectionId: 'conn_prod_liara',
            type: 'app',
            slug: 'payment-svc',
          },
          dependsOn: [],
          disruption: 'low',
          parameters: {
            sourceDigest: 'b'.repeat(40), // Intentionally different from plan.sourceRef.commitSha!
          },
        },
      ],
    };
    mismatchedDeployPlan.canonicalHash = computeActionPlanHash(mismatchedDeployPlan);

    const approval = createApproval({
      plan: mismatchedDeployPlan,
      ownerId,
      decision: 'approved',
    });

    const result = validateApprovalForDispatch({
      approval,
      plan: mismatchedDeployPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'SOURCE_DIGEST_MISMATCH')).toBe(true);

    // When sourceDigest exactly matches commitSha, dispatch validation passes
    const matchingDeployPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          stepId: 'step_deploy_app',
          type: 'liara.app.deploy',
          title: 'Deploy payment service',
          description: 'Deploy code to Liara',
          targetResource: {
            workspaceId: 'ws_prod_01',
            connectionId: 'conn_prod_liara',
            type: 'app',
            slug: 'payment-svc',
          },
          dependsOn: [],
          disruption: 'low',
          parameters: {
            sourceDigest: commitSha,
          },
        },
      ],
    };
    matchingDeployPlan.canonicalHash = computeActionPlanHash(matchingDeployPlan);
    const matchingApproval = createApproval({
      plan: matchingDeployPlan,
      ownerId,
      decision: 'approved',
    });
    const matchResult = validateApprovalForDispatch({
      approval: matchingApproval,
      plan: matchingDeployPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(matchResult.valid).toBe(true);
  });

  it('validates env_set variables against plan.secretRefs: rejects dangling or ambiguous duplicate refs', () => {
    const plan = createValidPlan();

    // 1. Dangling secretRefId (not present in plan.secretRefs)
    const danglingEnvPlan: ActionPlan = {
      ...plan,
      steps: [
        {
          stepId: 'step_env_set',
          type: 'liara.app.env_set',
          title: 'Set environment variables',
          description: 'Set database connection token',
          targetResource: {
            workspaceId: 'ws_prod_01',
            connectionId: 'conn_prod_liara',
            type: 'app',
            slug: 'payment-svc',
          },
          dependsOn: [],
          disruption: 'low',
          parameters: {
            variables: [
              {
                key: 'API_TOKEN',
                secretRefId: 'sec_dangling_unknown',
              },
            ],
          },
        },
      ],
    };
    danglingEnvPlan.canonicalHash = computeActionPlanHash(danglingEnvPlan);

    const danglingApproval = createApproval({
      plan: danglingEnvPlan,
      ownerId,
      decision: 'approved',
    });

    const danglingResult = validateApprovalForDispatch({
      approval: danglingApproval,
      plan: danglingEnvPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(danglingResult.valid).toBe(false);
    expect(danglingResult.issues.some((i) => i.code === 'DANGLING_SECRET_REF')).toBe(true);

    // 2. Ambiguous duplicate secretId in plan.secretRefs
    const dupSecretRef1 = createSecretRef({
      secretId: 'sec_duplicate',
      name: 'TOKEN_1',
      version: 1,
      workspaceId: 'ws_prod_01',
    });
    const dupSecretRef2 = createSecretRef({
      secretId: 'sec_duplicate',
      name: 'TOKEN_2',
      version: 2,
      workspaceId: 'ws_prod_01',
    });

    const ambiguousEnvPlan: ActionPlan = {
      ...plan,
      secretRefs: [dupSecretRef1, dupSecretRef2],
      steps: [
        {
          stepId: 'step_env_set',
          type: 'liara.app.env_set',
          title: 'Set environment variables',
          description: 'Set database connection token',
          targetResource: {
            workspaceId: 'ws_prod_01',
            connectionId: 'conn_prod_liara',
            type: 'app',
            slug: 'payment-svc',
          },
          dependsOn: [],
          disruption: 'low',
          parameters: {
            variables: [
              {
                key: 'API_TOKEN',
                secretRefId: 'sec_duplicate',
              },
            ],
          },
        },
      ],
    };
    ambiguousEnvPlan.canonicalHash = computeActionPlanHash(ambiguousEnvPlan);

    const ambiguousApproval = createApproval({
      plan: ambiguousEnvPlan,
      ownerId,
      decision: 'approved',
    });

    const ambiguousResult = validateApprovalForDispatch({
      approval: ambiguousApproval,
      plan: ambiguousEnvPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(ambiguousResult.valid).toBe(false);
    expect(ambiguousResult.issues.some((i) => i.code === 'AMBIGUOUS_SECRET_REF')).toBe(true);

    // 3. Exactly one staticValue or secretRefId in EnvVariableEntrySchema
    const validBoundPlan: ActionPlan = {
      ...plan,
      secretRefs: [
        createSecretRef({
          secretId: 'sec_valid',
          name: 'VALID_TOKEN',
          version: 1,
          workspaceId: 'ws_prod_01',
        }),
      ],
      steps: [
        {
          stepId: 'step_env_set',
          type: 'liara.app.env_set',
          title: 'Set environment variables',
          description: 'Set static and secret variables',
          targetResource: {
            workspaceId: 'ws_prod_01',
            connectionId: 'conn_prod_liara',
            type: 'app',
            slug: 'payment-svc',
          },
          dependsOn: [],
          disruption: 'low',
          parameters: {
            variables: [
              {
                key: 'NODE_ENV',
                staticValue: 'production',
              },
              {
                key: 'SECRET_KEY',
                secretRefId: 'sec_valid',
              },
            ],
          },
        },
      ],
    };
    validBoundPlan.canonicalHash = computeActionPlanHash(validBoundPlan);

    const validBoundApproval = createApproval({
      plan: validBoundPlan,
      ownerId,
      decision: 'approved',
    });

    const validBoundResult = validateApprovalForDispatch({
      approval: validBoundApproval,
      plan: validBoundPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(validBoundResult.valid).toBe(true);
    expect(validBoundResult.issues).toHaveLength(0);
  });

  it('clarifies that precondition verification is structural only', () => {
    const plan = createValidPlan();
    const approval = createApproval({ plan, ownerId, decision: 'approved' });
    const result = validateApprovalForDispatch({
      approval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(result.preconditionVerification).toBe('structural_only');
  });

  it('createApproval pre-validates descriptors and rejects root or nested getters with 0 calls', () => {
    const plan = createValidPlan();

    // 1. Root getter on plan
    let rootGetterCalls = 0;
    const planWithRootGetter = { ...plan };
    Object.defineProperty(planWithRootGetter, 'exploitRoot', {
      get() {
        rootGetterCalls++;
        return 'bad';
      },
      enumerable: true,
      configurable: true,
    });

    expect(() =>
      createApproval({
        plan: planWithRootGetter as unknown as ActionPlan,
        ownerId,
        decision: 'approved',
      })
    ).toThrow();
    expect(rootGetterCalls).toBe(0);

    // 2. Nested getter on step
    let nestedGetterCalls = 0;
    const planWithNestedGetter = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
        },
      ],
    };
    Object.defineProperty(planWithNestedGetter.steps[0]!, 'exploitStep', {
      get() {
        nestedGetterCalls++;
        return 'bad';
      },
      enumerable: true,
      configurable: true,
    });

    expect(() =>
      createApproval({
        plan: planWithNestedGetter as unknown as ActionPlan,
        ownerId,
        decision: 'approved',
      })
    ).toThrow();
    expect(nestedGetterCalls).toBe(0);

    // 3. Non-enumerable property on plan
    const planWithNonEnum = { ...plan };
    Object.defineProperty(planWithNonEnum, 'hiddenProp', {
      value: 'hidden',
      enumerable: false,
    });
    expect(() =>
      createApproval({
        plan: planWithNonEnum as unknown as ActionPlan,
        ownerId,
        decision: 'approved',
      })
    ).toThrow();
  });

  it('validateApprovalForDispatch pre-validates descriptors on both approval and plan with 0 calls', () => {
    const plan = createValidPlan();
    const validApproval = createApproval({ plan, ownerId, decision: 'approved' });

    // 1. Getter on approval object
    let approvalGetterCalls = 0;
    const approvalWithGetter = { ...validApproval };
    Object.defineProperty(approvalWithGetter, 'injectedProp', {
      get() {
        approvalGetterCalls++;
        return 'evil';
      },
      enumerable: true,
      configurable: true,
    });

    const approvalResult = validateApprovalForDispatch({
      approval: approvalWithGetter as unknown as typeof validApproval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(approvalResult.valid).toBe(false);
    expect(approvalResult.issues.some((i) => i.code === 'SCHEMA_PARSE_FAILED')).toBe(true);
    expect(approvalGetterCalls).toBe(0);

    // 2. Non-enumerable property on approval
    const approvalWithNonEnum = { ...validApproval };
    Object.defineProperty(approvalWithNonEnum, 'secretAudit', {
      value: 'untracked',
      enumerable: false,
    });
    const nonEnumApprovalResult = validateApprovalForDispatch({
      approval: approvalWithNonEnum as unknown as typeof validApproval,
      plan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(nonEnumApprovalResult.valid).toBe(false);
    expect(nonEnumApprovalResult.issues.some((i) => i.code === 'SCHEMA_PARSE_FAILED')).toBe(true);

    // 3. Getter on plan during dispatch validation
    let planGetterCalls = 0;
    const planWithGetter = { ...plan };
    Object.defineProperty(planWithGetter, 'dynamicDispatchProp', {
      get() {
        planGetterCalls++;
        return 'injected';
      },
      enumerable: true,
      configurable: true,
    });

    const planResult = validateApprovalForDispatch({
      approval: validApproval,
      plan: planWithGetter as unknown as ActionPlan,
      expectedWorkspaceId: expectedWorkspace,
      expectedOwnerId: ownerId,
    });
    expect(planResult.valid).toBe(false);
    expect(planResult.issues.some((i) => i.code === 'SCHEMA_PARSE_FAILED')).toBe(true);
    expect(planGetterCalls).toBe(0);
  });
});
