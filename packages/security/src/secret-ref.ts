import { z } from 'zod';

const FORBIDDEN_SECRET_KEYS = [
  'value',
  'plaintext',
  'secret',
  'token',
  'password',
  'key',
  'apiKey',
  'credential',
  'rawSecret',
] as const;

export const SecretRefSchema = z.object({
  secretId: z.string().min(1, 'secretId is required'),
  name: z.string().min(1, 'name is required'),
  version: z.number().int().positive('version must be a positive integer'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  connectionId: z.string().optional(),
  createdAt: z.string().datetime({ message: 'createdAt must be an ISO 8601 UTC timestamp' }),
  isConcealed: z.literal(true),
}).strict().superRefine((data, ctx) => {
  // Extra runtime check to ensure forbidden secret keys were not somehow attached
  const record = data as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_SECRET_KEYS) {
    if (forbidden in record && record[forbidden] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forbidden field "${forbidden}" detected in SecretRef: raw secret values must never be placed in SecretRef models`,
        path: [forbidden],
      });
    }
  }
});

export type SecretRef = z.infer<typeof SecretRefSchema>;

export interface CreateSecretRefParams {
  secretId: string;
  name: string;
  version: number;
  workspaceId: string;
  connectionId?: string;
  createdAt?: string;
}

/**
 * Creates a validated, opaque SecretRef model.
 * Models and ActionPlans MUST only receive SecretRef, never raw plaintext values.
 */
export function createSecretRef(params: CreateSecretRefParams): SecretRef {
  const ref: Record<string, unknown> = {
    secretId: params.secretId,
    name: params.name,
    version: params.version,
    workspaceId: params.workspaceId,
    createdAt: params.createdAt ?? new Date().toISOString(),
    isConcealed: true as const,
  };

  if (params.connectionId !== undefined) {
    ref.connectionId = params.connectionId;
  }

  return SecretRefSchema.parse(ref);
}

export const CANARY_DETECTED_ERROR_MESSAGE =
  'Security verification failed: sensitive credential or canary token detected in payload';

/**
 * Validates that an object or data structure does not contain any canary strings or known secret values.
 * Useful in test suites and before serialization to logs, checkpoints, or LLM payloads.
 * Strictly throws a static safe error message without echoing any canary value or payload contents.
 */
export function assertNoCanaryOrSecret(
  target: unknown,
  canaries: readonly string[]
): void {
  if (canaries.length === 0) return;

  const serialized = typeof target === 'string' ? target : JSON.stringify(target);
  if (!serialized) return;

  for (const canary of canaries) {
    if (canary && canary.length > 0 && serialized.includes(canary)) {
      throw new Error(CANARY_DETECTED_ERROR_MESSAGE);
    }
  }
}
