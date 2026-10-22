import { z } from 'zod';

export const EvidenceScopeSchema = z.enum([
  'run',
  'project',
  'incident',
  'workspace',
]);

export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1, 'evidenceId is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  scope: EvidenceScopeSchema,
  source: z.string().min(1, 'source is required'),
  capturedAt: z.string().datetime({ message: 'capturedAt must be ISO 8601 UTC' }),
  expiresAt: z.string().datetime({ message: 'expiresAt must be ISO 8601 UTC' }),
  integrityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'integrityDigest must be sha256:<64-hex>'),
  storagePath: z.string().optional(),
  contentType: z.string().min(1, 'contentType is required'),
  sizeBytes: z.number().int().nonnegative('sizeBytes must be non-negative'),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
