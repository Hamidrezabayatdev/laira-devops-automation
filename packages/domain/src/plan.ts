import { z } from 'zod';
import { SecretRefSchema } from '@laira/security';
import { ResourceRefSchema } from './resource.js';
import { SourceRefSchema } from './source.js';

// -------------------------------------------------------------
// Bounded Typed Steps (Strictly infrastructure operations, no shell)
// -------------------------------------------------------------

export const StepDisruptionSchema = z.enum(['none', 'low', 'high']);
export type StepDisruption = z.infer<typeof StepDisruptionSchema>;

const BaseStepFields = {
  stepId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  targetResource: ResourceRefSchema,
  dependsOn: z.array(z.string()).default([]),
  disruption: StepDisruptionSchema.default('none'),
};

export const LiaraAppCreateStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.create'),
  parameters: z.object({
    platform: z.string().min(1),
    plan: z.string().min(1),
    zone: z.string().default('iran'),
    port: z.number().int().positive().optional(),
  }).strict(),
}).strict();

export const LiaraAppDeployStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.deploy'),
  parameters: z.object({
    sourceDigest: z.string().min(1),
    bundlePlan: z.string().optional(),
    releaseNote: z.string().optional(),
  }).strict(),
}).strict();

export const LiaraAppRestartStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.restart'),
  parameters: z.object({
    force: z.boolean().default(false),
  }).strict(),
}).strict();

export const LiaraAppPowerStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.power'),
  parameters: z.object({
    action: z.enum(['start', 'stop']),
  }).strict(),
}).strict();

export const LiaraAppResizeStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.resize'),
  parameters: z.object({
    targetPlan: z.string().min(1),
  }).strict(),
}).strict();

export const EnvVariableEntrySchema = z.object({
  key: z.string().min(1, 'Environment variable key must be non-empty'),
  secretRefId: z.string().min(1, 'secretRefId must be non-empty if specified').optional(),
  staticValue: z.string().optional(),
}).strict().superRefine((val, ctx) => {
  const hasSecret = val.secretRefId !== undefined && val.secretRefId.trim() !== '';
  const hasStatic = val.staticValue !== undefined;
  if (!hasSecret && !hasStatic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Environment variable "${val.key}" must provide exactly one value source: either "staticValue" or non-empty "secretRefId" (neither provided)`,
      path: ['secretRefId'],
    });
  } else if (hasSecret && hasStatic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Environment variable "${val.key}" must provide exactly one value source: provided both "staticValue" and "secretRefId"`,
      path: ['staticValue'],
    });
  }
});

export type EnvVariableEntry = z.infer<typeof EnvVariableEntrySchema>;

export const LiaraAppEnvSetStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.app.env_set'),
  parameters: z.object({
    variables: z.array(EnvVariableEntrySchema).min(1),
  }).strict(),
}).strict();

export const LiaraDatabaseCreateStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.database.create'),
  parameters: z.object({
    databaseType: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongodb']),
    plan: z.string().min(1),
    version: z.string().optional(),
  }).strict(),
}).strict();

export const LiaraDatabaseResizeStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.database.resize'),
  parameters: z.object({
    targetPlan: z.string().min(1),
  }).strict(),
}).strict();

export const LiaraDatabaseBackupStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.database.backup'),
  parameters: z.object({
    action: z.literal('create'),
  }).strict(),
}).strict();

export const LiaraDiskCreateStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.disk.create'),
  parameters: z.object({
    name: z.string().min(1),
    sizeGb: z.number().int().positive(),
  }).strict(),
}).strict();

export const LiaraDiskAttachStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.disk.attach'),
  parameters: z.object({
    diskName: z.string().min(1),
    mountPath: z.string().min(1),
  }).strict(),
}).strict();

export const LiaraDomainAddStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.domain.add'),
  parameters: z.object({
    domain: z.string().min(1),
  }).strict(),
}).strict();

export const LiaraDomainVerifyStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.domain.verify'),
  parameters: z.object({
    domain: z.string().min(1),
  }).strict(),
}).strict();

export const LiaraBucketCreateStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal('liara.bucket.create'),
  parameters: z.object({
    bucketName: z.string().min(1),
    plan: z.string().min(1),
  }).strict(),
}).strict();

export const PlanStepSchema = z.discriminatedUnion('type', [
  LiaraAppCreateStepSchema,
  LiaraAppDeployStepSchema,
  LiaraAppRestartStepSchema,
  LiaraAppPowerStepSchema,
  LiaraAppResizeStepSchema,
  LiaraAppEnvSetStepSchema,
  LiaraDatabaseCreateStepSchema,
  LiaraDatabaseResizeStepSchema,
  LiaraDatabaseBackupStepSchema,
  LiaraDiskCreateStepSchema,
  LiaraDiskAttachStepSchema,
  LiaraDomainAddStepSchema,
  LiaraDomainVerifyStepSchema,
  LiaraBucketCreateStepSchema,
]);

export type PlanStep = z.infer<typeof PlanStepSchema>;

// -------------------------------------------------------------
// Preconditions, Bindings, Cost, Disruption & Verification
// -------------------------------------------------------------

export const PreconditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  targetResource: ResourceRefSchema,
  expectedState: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ),
}).strict();

export type Precondition = z.infer<typeof PreconditionSchema>;

export const ResourceBindingSchema = z.object({
  logicalResourceId: z.string().min(1),
  logicalRef: ResourceRefSchema,
  boundProviderId: z.string().nullable(),
  boundAt: z.string().datetime().nullable(),
}).strict();

export type ResourceBinding = z.infer<typeof ResourceBindingSchema>;

export const PlanCostEstimateSchema = z.object({
  estimatedModelTokens: z.number().int().nonnegative(),
  estimatedCatalogUsd: z.number().nonnegative(),
  providerCostEstimate: z.number().nonnegative().nullable(),
  providerCurrency: z.string().nullable(),
  unknowns: z.array(z.string()).default([]),
}).strict();

export type PlanCostEstimate = z.infer<typeof PlanCostEstimateSchema>;

export const PlanDisruptionSchema = z.object({
  level: StepDisruptionSchema,
  description: z.string().min(1),
  downtimeExpected: z.boolean(),
}).strict();

export type PlanDisruption = z.infer<typeof PlanDisruptionSchema>;

export const PlanVerificationProbeSchema = z.object({
  probeId: z.string().min(1),
  type: z.enum([
    'http_health_check',
    'provider_status_check',
    'database_connection_check',
  ]),
  targetUrl: z.string().url().optional(),
  expectedStatus: z.number().int().optional(),
  timeoutSeconds: z.number().int().positive().default(30),
}).strict();

export type PlanVerificationProbe = z.infer<typeof PlanVerificationProbeSchema>;

export const PlanVerificationSchema = z.object({
  probes: z.array(PlanVerificationProbeSchema).min(
    1,
    'ActionPlan must include at least one verification probe'
  ),
  maxWaitSeconds: z.number().int().positive().default(300),
}).strict();

export type PlanVerification = z.infer<typeof PlanVerificationSchema>;

// -------------------------------------------------------------
// ActionPlan Schema
// -------------------------------------------------------------

export const ActionPlanSchema = z.object({
  id: z.string().min(1, 'ActionPlan id is required'),
  version: z.number().int().positive('version must be a positive integer'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  projectId: z.string().min(1, 'projectId is required'),
  sourceRef: SourceRefSchema,
  steps: z.array(PlanStepSchema).min(1, 'ActionPlan must include at least one step'),
  resourceBindings: z.array(ResourceBindingSchema).default([]),
  secretRefs: z.array(SecretRefSchema).default([]),
  preconditions: z.array(PreconditionSchema).default([]),
  estimatedCost: PlanCostEstimateSchema,
  disruption: PlanDisruptionSchema,
  verification: PlanVerificationSchema,
  proposedRecovery: z.string().nullable().optional(),
  canonicalHash: z.string().regex(/^[0-9a-f]{64}$/, 'canonicalHash must be 64-hex SHA-256'),
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 UTC' }),
}).strict();

export type ActionPlan = z.infer<typeof ActionPlanSchema>;

export const ActionPlanInputSchema = ActionPlanSchema.extend({
  canonicalHash: z.string().regex(/^[0-9a-f]{64}$/, 'canonicalHash must be 64-hex SHA-256').optional(),
});

export type ActionPlanInput = z.infer<typeof ActionPlanInputSchema>;
