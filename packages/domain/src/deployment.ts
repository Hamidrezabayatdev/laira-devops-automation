import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalJsonStringify, assertDescriptorSafe } from './canonical.js';

export const LIARA_PLATFORMS = [
  'node',
  'next',
  'python',
  'django',
  'flask',
  'php',
  'laravel',
  'docker',
  'go',
  'dotnet',
] as const;

export const LiaraPlatformSchema = z.enum(LIARA_PLATFORMS);
export type LiaraPlatform = z.infer<typeof LiaraPlatformSchema>;

export const DeploymentRepositorySchema = z
  .object({
    owner: z
      .string()
      .min(1, 'owner is required')
      .max(100, 'owner exceeds maximum length')
      .regex(/^[a-zA-Z0-9_-]+$/, 'owner must be a valid GitHub identifier'),
    repo: z
      .string()
      .min(1, 'repo is required')
      .max(100, 'repo exceeds maximum length')
      .regex(/^[a-zA-Z0-9_.-]+$/, 'repo must be a valid GitHub repository identifier'),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'commitSha must be 40 lowercase hexadecimal characters'),
  })
  .strict();

export type DeploymentRepository = z.infer<typeof DeploymentRepositorySchema>;

export const RuntimeEnvironmentReferenceSchema = z
  .object({
    connectionId: z
      .string()
      .min(1, 'connectionId is required')
      .max(128, 'connectionId exceeds maximum length'),
    credentialVersion: z
      .number()
      .int('credentialVersion must be an integer')
      .positive('credentialVersion must be a positive integer'),
  })
  .strict();

export type RuntimeEnvironmentReference = z.infer<typeof RuntimeEnvironmentReferenceSchema>;

export const DeployProposalSchema = z
  .object({
    kind: z.literal('deploy'),
    connectionId: z
      .string()
      .min(1, 'connectionId is required')
      .max(128, 'connectionId exceeds maximum length'),
    credentialVersion: z
      .number()
      .int('credentialVersion must be an integer')
      .positive('credentialVersion must be a positive integer'),
    appId: z
      .string()
      .min(3, 'appId must be at least 3 characters')
      .max(63, 'appId cannot exceed 63 characters')
      .regex(/^[a-z0-9-]+$/, 'appId must be lowercase alphanumeric with hyphens'),
    platform: LiaraPlatformSchema,
    port: z
      .number()
      .int('port must be an integer')
      .min(1, 'port must be at least 1')
      .max(65535, 'port cannot exceed 65535'),
    repository: DeploymentRepositorySchema,
    bundleDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, 'bundleDigest must be sha256:<64 lowercase hex characters>'),
    runtimeEnvironment: RuntimeEnvironmentReferenceSchema.optional(),
  })
  .strict();

export type DeployProposal = z.infer<typeof DeployProposalSchema>;

export const RestartProposalSchema = z
  .object({
    kind: z.literal('restart'),
    connectionId: z
      .string()
      .min(1, 'connectionId is required')
      .max(128, 'connectionId exceeds maximum length'),
    credentialVersion: z
      .number()
      .int('credentialVersion must be an integer')
      .positive('credentialVersion must be a positive integer'),
    appId: z
      .string()
      .min(3, 'appId must be at least 3 characters')
      .max(63, 'appId cannot exceed 63 characters')
      .regex(/^[a-z0-9-]+$/, 'appId must be lowercase alphanumeric with hyphens'),
  })
  .strict();

export type RestartProposal = z.infer<typeof RestartProposalSchema>;

export const AppCostSchema = z
  .object({
    currency: z.literal('IRR'),
    hourly: z.number().positive('hourly cost must be positive'),
    monthly: z.number().positive('monthly cost must be positive'),
    sourceUrl: z.enum(['https://liara.ir/pricing/', 'https://api.liara.ir/v1/me']),
    checkedAt: z.string().datetime({ message: 'checkedAt must be an ISO 8601 datetime string' }),
  })
  .strict();

export type AppCost = z.infer<typeof AppCostSchema>;

export const CreateAppProposalSchema = z
  .object({
    kind: z.literal('create_app'),
    connectionId: z
      .string()
      .min(1, 'connectionId is required')
      .max(128, 'connectionId exceeds maximum length'),
    credentialVersion: z
      .number()
      .int('credentialVersion must be an integer')
      .positive('credentialVersion must be a positive integer'),
    appId: z
      .string()
      .min(3, 'appId must be at least 3 characters')
      .max(63, 'appId cannot exceed 63 characters')
      .regex(/^[a-z0-9-]+$/, 'appId must be lowercase alphanumeric with hyphens'),
    platform: LiaraPlatformSchema,
    planId: z
      .string()
      .min(1, 'planId is required')
      .max(64, 'planId exceeds maximum length')
      .regex(/^[a-z0-9_-]+$/, 'planId must be alphanumeric with hyphens or underscores'),
    bundlePlanId: z
      .string()
      .min(1, 'bundlePlanId is required')
      .max(64, 'bundlePlanId exceeds maximum length')
      .regex(/^[a-z0-9_-]+$/, 'bundlePlanId must be alphanumeric with hyphens or underscores'),
    networkId: z
      .string()
      .regex(/^[0-9a-f]{24}$/, 'networkId must be a 24-character lowercase hex string'),
    cost: AppCostSchema,
  })
  .strict();

export type CreateAppProposal = z.infer<typeof CreateAppProposalSchema>;

export const ApprovedAppPlanSchema = z
  .object({
    planId: z
      .string()
      .min(1, 'planId is required')
      .max(64, 'planId exceeds maximum length')
      .regex(/^[a-z0-9_-]+$/, 'planId must be alphanumeric with hyphens or underscores'),
    bundlePlanId: z
      .string()
      .min(1, 'bundlePlanId is required')
      .max(64, 'bundlePlanId exceeds maximum length')
      .regex(/^[a-z0-9_-]+$/, 'bundlePlanId must be alphanumeric with hyphens or underscores'),
    networkId: z
      .string()
      .regex(/^[0-9a-f]{24}$/, 'networkId must be a 24-character lowercase hex string'),
    platform: LiaraPlatformSchema.optional(),
    cost: AppCostSchema,
  })
  .strict();

export type ApprovedAppPlan = z.infer<typeof ApprovedAppPlanSchema>;

export const DeploymentProposalSchema = z.discriminatedUnion('kind', [
  DeployProposalSchema,
  RestartProposalSchema,
  CreateAppProposalSchema,
]);

export type DeploymentProposal = z.infer<typeof DeploymentProposalSchema>;

/**
 * Computes deterministic canonical SHA-256 hash of a deployment proposal.
 *
 * Guarantees:
 * - Pre-validates descriptor safety on raw input before Zod.
 * - Parses and strictly validates against DeploymentProposalSchema.
 * - Formats deterministic canonical JSON with lexicographically sorted keys.
 * - Strictly rejects undefined anywhere.
 * - Computes standard SHA-256 hex digest.
 */
export function hashDeploymentProposal(proposal: unknown): string {
  assertDescriptorSafe(proposal);
  const parsed = DeploymentProposalSchema.parse(proposal);
  assertDescriptorSafe(parsed);
  const canonicalJson = canonicalJsonStringify(parsed);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
