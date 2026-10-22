import { describe, it, expect } from 'vitest';
import {
  canonicalJsonStringify,
  computeActionPlanHash,
  verifyActionPlanHash,
  normalizeActionPlan,
  CanonicalizationError,
} from '../src/canonical.js';
import type { ActionPlan } from '../src/plan.js';
import { createSecretRef } from '@laira/security';

function createSamplePlan(): ActionPlan {
  const secretRef = createSecretRef({
    secretId: 'sec_db_pass',
    name: 'DATABASE_PASSWORD',
    version: 1,
    workspaceId: 'ws_demo_1',
    createdAt: '2026-10-22T10:00:00.000Z',
  });

  const planBase: Omit<ActionPlan, 'canonicalHash'> = {
    id: 'plan_deploy_01',
    version: 1,
    workspaceId: 'ws_demo_1',
    projectId: 'my-app',
    sourceRef: {
      sourceType: 'git',
      repository: 'owner/repo',
      commitSha: 'a1b2c3d4e5f678901234567890abcdef12345678',
    },
    steps: [
      {
        stepId: 'step_create_app',
        type: 'liara.app.create',
        title: 'Create Liara App',
        description: 'Provision NodeJS app on Liara',
        targetResource: {
          workspaceId: 'ws_demo_1',
          connectionId: 'conn_1',
          type: 'app',
          slug: 'my-app',
        },
        dependsOn: [],
        disruption: 'none',
        parameters: {
          platform: 'node',
          plan: 'standard',
          zone: 'iran',
          port: 3000,
        },
      },
      {
        stepId: 'step_deploy_code',
        type: 'liara.app.deploy',
        title: 'Deploy Release',
        description: 'Deploy approved source commit',
        targetResource: {
          workspaceId: 'ws_demo_1',
          connectionId: 'conn_1',
          type: 'app',
          slug: 'my-app',
        },
        dependsOn: ['step_create_app'],
        disruption: 'low',
        parameters: {
          sourceDigest: 'a1b2c3d4e5f678901234567890abcdef12345678',
          releaseNote: 'Initial automated deploy',
        },
      },
    ],
    resourceBindings: [
      {
        logicalResourceId: 'res_logical_app',
        logicalRef: {
          workspaceId: 'ws_demo_1',
          connectionId: 'conn_1',
          type: 'app',
          slug: 'my-app',
        },
        boundProviderId: null,
        boundAt: null,
      },
    ],
    secretRefs: [secretRef],
    preconditions: [
      {
        id: 'prec_clean_state',
        description: 'Verify no conflicting app exists',
        targetResource: {
          workspaceId: 'ws_demo_1',
          connectionId: 'conn_1',
          type: 'app',
          slug: 'my-app',
        },
        expectedState: {
          status: 'non_existent',
        },
      },
    ],
    estimatedCost: {
      estimatedModelTokens: 1200,
      estimatedCatalogUsd: 0.05,
      providerCostEstimate: 500,
      providerCurrency: 'IRR',
      unknowns: ['Build network egress cost'],
    },
    disruption: {
      level: 'low',
      description: 'First deploy requires initial provisioning',
      downtimeExpected: false,
    },
    verification: {
      probes: [
        {
          probeId: 'probe_health',
          type: 'http_health_check',
          targetUrl: 'https://my-app.liara.run/health',
          expectedStatus: 200,
          timeoutSeconds: 30,
        },
      ],
      maxWaitSeconds: 180,
    },
    proposedRecovery: 'Rollback by deploying prior immutable release',
    createdAt: '2026-10-22T10:05:00.000Z',
  };

  const hash = computeActionPlanHash(planBase);
  return {
    ...planBase,
    canonicalHash: hash,
  };
}

describe('Canonical Plan Hashing & Determinism', () => {
  it('produces identical canonical hash across varying object key orderings', () => {
    const planA = createSamplePlan();

    // Create planB with jumbled keys at every level
    const planB: ActionPlan = {
      createdAt: planA.createdAt,
      canonicalHash: planA.canonicalHash,
      verification: {
        maxWaitSeconds: planA.verification.maxWaitSeconds,
        probes: [
          {
            timeoutSeconds: planA.verification.probes[0]!.timeoutSeconds,
            expectedStatus: planA.verification.probes[0]!.expectedStatus,
            targetUrl: planA.verification.probes[0]!.targetUrl,
            type: planA.verification.probes[0]!.type,
            probeId: planA.verification.probes[0]!.probeId,
          },
        ],
      },
      disruption: {
        downtimeExpected: planA.disruption.downtimeExpected,
        description: planA.disruption.description,
        level: planA.disruption.level,
      },
      estimatedCost: {
        unknowns: planA.estimatedCost.unknowns,
        providerCurrency: planA.estimatedCost.providerCurrency,
        providerCostEstimate: planA.estimatedCost.providerCostEstimate,
        estimatedCatalogUsd: planA.estimatedCost.estimatedCatalogUsd,
        estimatedModelTokens: planA.estimatedCost.estimatedModelTokens,
      },
      preconditions: planA.preconditions,
      secretRefs: planA.secretRefs,
      resourceBindings: planA.resourceBindings,
      steps: [
        {
          disruption: planA.steps[0]!.disruption,
          dependsOn: planA.steps[0]!.dependsOn,
          parameters: {
            port: 3000,
            zone: 'iran',
            plan: 'standard',
            platform: 'node',
          },
          targetResource: {
            slug: 'my-app',
            type: 'app',
            connectionId: 'conn_1',
            workspaceId: 'ws_demo_1',
          },
          description: planA.steps[0]!.description,
          title: planA.steps[0]!.title,
          type: planA.steps[0]!.type,
          stepId: planA.steps[0]!.stepId,
        },
        planA.steps[1]!,
      ],
      sourceRef: {
        commitSha: (planA.sourceRef as { commitSha: string }).commitSha,
        repository: (planA.sourceRef as { repository: string }).repository,
        sourceType: 'git',
      },
      projectId: planA.projectId,
      workspaceId: planA.workspaceId,
      version: planA.version,
      id: planA.id,
      proposedRecovery: planA.proposedRecovery,
    };

    const hashA = computeActionPlanHash(planA);
    const hashB = computeActionPlanHash(planB);

    expect(hashA).toBe(hashB);
    expect(verifyActionPlanHash(planA)).toBe(true);
    expect(verifyActionPlanHash(planB)).toBe(true);
  });

  it('produces different hash when source changes (commit sha)', () => {
    const basePlan = createSamplePlan();
    const mutatedPlan: ActionPlan = {
      ...basePlan,
      sourceRef: {
        sourceType: 'git',
        repository: 'owner/repo',
        commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
      },
    };

    expect(computeActionPlanHash(mutatedPlan)).not.toBe(basePlan.canonicalHash);
  });

  it('produces different hash when workspace or account changes', () => {
    const basePlan = createSamplePlan();
    const mutatedPlan: ActionPlan = {
      ...basePlan,
      workspaceId: 'ws_other_account',
    };

    expect(computeActionPlanHash(mutatedPlan)).not.toBe(basePlan.canonicalHash);
  });

  it('produces different hash when secretRef version changes', () => {
    const basePlan = createSamplePlan();
    const mutatedSecretRef = createSecretRef({
      secretId: 'sec_db_pass',
      name: 'DATABASE_PASSWORD',
      version: 2, // version incremented
      workspaceId: 'ws_demo_1',
      createdAt: '2026-10-22T10:00:00.000Z',
    });

    const mutatedPlan: ActionPlan = {
      ...basePlan,
      secretRefs: [mutatedSecretRef],
    };

    expect(computeActionPlanHash(mutatedPlan)).not.toBe(basePlan.canonicalHash);
  });

  it('produces different hash when estimated cost changes', () => {
    const basePlan = createSamplePlan();
    const mutatedPlan: ActionPlan = {
      ...basePlan,
      estimatedCost: {
        ...basePlan.estimatedCost,
        estimatedCatalogUsd: 1.50,
      },
    };

    expect(computeActionPlanHash(mutatedPlan)).not.toBe(basePlan.canonicalHash);
  });

  it('produces different hash when steps or step parameters change', () => {
    const basePlan = createSamplePlan();
    const mutatedStepPlan: ActionPlan = {
      ...basePlan,
      steps: [basePlan.steps[1]!, basePlan.steps[0]!], // reordered steps
    };

    expect(computeActionPlanHash(mutatedStepPlan)).not.toBe(basePlan.canonicalHash);
  });

  it('strictly rejects non-JSON unsafe values during canonical serialization', () => {
    expect(() => canonicalJsonStringify({ fn: () => {} })).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify({ val: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify({ val: Infinity })).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify(undefined)).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify([undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify({ sym: Symbol('sym') })).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify({ big: 12345678901234567890n })).toThrow(CanonicalizationError);

    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;
    expect(() => canonicalJsonStringify(circular)).toThrow(CanonicalizationError);

    // Strictly rejects undefined in object properties (preventing silent drop hash collision)
    expect(() => canonicalJsonStringify({ a: 1, b: undefined })).toThrow(CanonicalizationError);

    // Strictly rejects sparse arrays
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    expect(() => canonicalJsonStringify(sparse)).toThrow(CanonicalizationError);

    // Strictly rejects objects with symbol keys
    const symKeyObj = { [Symbol('test')]: 'value', normal: 1 };
    expect(() => canonicalJsonStringify(symKeyObj)).toThrow(CanonicalizationError);

    // Strictly rejects non-plain objects: Date, Map, Set, custom classes
    expect(() => canonicalJsonStringify(new Date())).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify(new Map())).toThrow(CanonicalizationError);
    expect(() => canonicalJsonStringify(new Set())).toThrow(CanonicalizationError);
    class CustomClass {
      val = 42;
    }
    expect(() => canonicalJsonStringify(new CustomClass())).toThrow(CanonicalizationError);

    // Strictly rejects getters without executing them
    let getterExecuted = false;
    const getterObj = {
      get dynamicProp() {
        getterExecuted = true;
        return 'injected';
      },
    };
    expect(() => canonicalJsonStringify(getterObj)).toThrow(CanonicalizationError);
    expect(getterExecuted).toBe(false);

    // Preserves -0 as JSON '0'
    expect(canonicalJsonStringify(-0)).toBe('0');
    expect(canonicalJsonStringify(0)).toBe('0');
  });

  it('prevents hash collision scenarios by strictly rejecting undefined and non-plain structures', () => {
    // Scenario 1: Object with undefined property vs object without it
    // In loose canonicalizers, { a: 1, b: undefined } serializes to {"a":1}, creating a hash collision.
    // In our strict canonicalizer, the unvetted object with undefined is rejected.
    const cleanObj = { a: 1 };
    const collisionAttempt = { a: 1, b: undefined };

    expect(canonicalJsonStringify(cleanObj)).toBe('{"a":1}');
    expect(() => canonicalJsonStringify(collisionAttempt)).toThrow(CanonicalizationError);

    // Scenario 2: Array with holes vs dense array
    const dense = [1, null, 3];
    const holey = [1, undefined, 3];
    expect(canonicalJsonStringify(dense)).toBe('[1,null,3]');
    expect(() => canonicalJsonStringify(holey)).toThrow(CanonicalizationError);
  });

  it('strictly rejects array custom string/symbol properties and array getters without executing them', () => {
    // 1. Array with getter property: zero getters must execute
    let arrayGetterCount = 0;
    const arrWithGetter: unknown[] = [1, 2];
    Object.defineProperty(arrWithGetter, 1, {
      get() {
        arrayGetterCount++;
        return 'injected_val';
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => canonicalJsonStringify(arrWithGetter)).toThrow(CanonicalizationError);
    expect(arrayGetterCount).toBe(0);

    // 2. Array with custom string property
    const arrWithCustomProp: unknown[] = [1, 2];
    (arrWithCustomProp as unknown as { customProp: string }).customProp = 'evil';
    expect(() => canonicalJsonStringify(arrWithCustomProp)).toThrow(CanonicalizationError);

    // 3. Array with symbol property
    const arrWithSymbol: unknown[] = [1, 2];
    (arrWithSymbol as unknown as Record<symbol, string>)[Symbol('sym')] = 'evil';
    expect(() => canonicalJsonStringify(arrWithSymbol)).toThrow(CanonicalizationError);

    // 4. Array with non-enumerable element
    const arrWithNonEnum: unknown[] = [1, 2];
    Object.defineProperty(arrWithNonEnum, 0, {
      value: 1,
      enumerable: false,
    });
    expect(() => canonicalJsonStringify(arrWithNonEnum)).toThrow(CanonicalizationError);
  });

  it('strictly rejects non-enumerable properties on plain objects', () => {
    const objWithNonEnum = { a: 1 };
    Object.defineProperty(objWithNonEnum, 'hidden', {
      value: 'secret',
      enumerable: false,
    });
    expect(() => canonicalJsonStringify(objWithNonEnum)).toThrow(CanonicalizationError);
  });

  it('computeActionPlanHash validates descriptors, executes 0 getters, and rejects nonenumerable extras', () => {
    const basePlan = createSamplePlan();

    // 1. Root accessor on plan: getter count must be 0
    let rootGetterExecuted = 0;
    const planWithGetter = { ...basePlan };
    Object.defineProperty(planWithGetter, 'dynamicField', {
      get() {
        rootGetterExecuted++;
        return 'getter_value';
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => computeActionPlanHash(planWithGetter as unknown as ActionPlan)).toThrow(
      CanonicalizationError
    );
    expect(rootGetterExecuted).toBe(0);

    // 2. Root non-enumerable property on plan: must be rejected, not silently ignored
    const planWithNonEnum = { ...basePlan };
    Object.defineProperty(planWithNonEnum, 'hiddenAudit', {
      value: 'audit_data',
      enumerable: false,
    });
    expect(() => computeActionPlanHash(planWithNonEnum as unknown as ActionPlan)).toThrow(
      CanonicalizationError
    );

    // 3. Root symbol property on plan: must be rejected
    const planWithSymbol = { ...basePlan, [Symbol('meta')]: 'val' };
    expect(() => computeActionPlanHash(planWithSymbol as unknown as ActionPlan)).toThrow(
      CanonicalizationError
    );

    // 4. Standard plan hashes deterministically and strips canonicalHash safely
    const hash = computeActionPlanHash(basePlan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(basePlan.canonicalHash);

    // 5. Strictly rejects root or nested undefined without dropping it
    const planWithRootUndefined = { ...basePlan, extraField: undefined };
    expect(() => computeActionPlanHash(planWithRootUndefined as unknown as ActionPlan)).toThrow(
      CanonicalizationError
    );

    const planWithNestedUndefined = {
      ...basePlan,
      steps: [
        {
          ...basePlan.steps[0]!,
          parameters: {
            ...basePlan.steps[0]!.parameters,
            extraUndefined: undefined,
          },
        },
      ],
    };
    expect(() => computeActionPlanHash(planWithNestedUndefined as unknown as ActionPlan)).toThrow(
      CanonicalizationError
    );
  });

  it('strictly rejects __proto__ property at trust boundary', () => {
    // When an object has an own __proto__ property, canonical serialization must reject it
    const objWithProto = Object.create(null);
    Object.defineProperty(objWithProto, '__proto__', {
      value: { evil: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    expect(() => canonicalJsonStringify(objWithProto)).toThrow(CanonicalizationError);
  });

  it('verifyActionPlanHash safely rejects getter on canonicalHash without invoking it (calls: 0)', () => {
    const basePlan = createSamplePlan();
    let getterCalled = 0;
    const planWithGetter = { ...basePlan };
    Object.defineProperty(planWithGetter, 'canonicalHash', {
      get() {
        getterCalled++;
        return basePlan.canonicalHash;
      },
      enumerable: true,
      configurable: true,
    });

    const result = verifyActionPlanHash(planWithGetter as unknown as ActionPlan);
    expect(result).toBe(false);
    expect(getterCalled).toBe(0);
  });

  it('normalizeActionPlan roundtrip applies schema defaults once and establishes canonicalHash', () => {
    const basePlan = createSamplePlan();

    // Raw input where optional defaults are omitted (e.g. resourceBindings, preconditions default to [])
    const rawInputPlan = {
      id: 'plan_raw_01',
      version: 1,
      workspaceId: 'ws_demo_1',
      projectId: 'my-service',
      sourceRef: basePlan.sourceRef,
      steps: [
        {
          stepId: 'step_1',
          type: 'liara.app.restart',
          title: 'Restart app',
          description: 'Graceful restart',
          targetResource: basePlan.steps[0]!.targetResource,
          // dependsOn omitted -> should default to []
          // disruption omitted -> should default to 'none'
          parameters: {
            force: false,
          },
        },
      ],
      // resourceBindings omitted -> defaults to []
      // secretRefs omitted -> defaults to []
      // preconditions omitted -> defaults to []
      estimatedCost: basePlan.estimatedCost,
      disruption: basePlan.disruption,
      verification: basePlan.verification,
      createdAt: '2026-10-22T08:00:00.000Z',
    };

    // 1. Normalizing raw plan applies schema defaults and computes strict canonicalHash
    const normalized = normalizeActionPlan(rawInputPlan);
    expect(normalized.canonicalHash).toBeDefined();
    expect(normalized.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.steps[0]!.dependsOn).toEqual([]);
    expect(normalized.steps[0]!.disruption).toBe('none');
    expect(normalized.resourceBindings).toEqual([]);

    // 2. Verified roundtrip: verifyActionPlanHash on normalized plan succeeds
    expect(verifyActionPlanHash(normalized)).toBe(true);

    // 3. Raw plan with undefined property is rejected before Zod
    const rawWithUndefined = { ...rawInputPlan, invalidUndefined: undefined };
    expect(() => normalizeActionPlan(rawWithUndefined)).toThrow(CanonicalizationError);
  });
});
