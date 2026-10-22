import { z } from 'zod';

export const CapabilityStatusSchema = z.enum([
  'supported',
  'unsupported',
  'unverified',
]);

export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilitySchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  connectionId: z.string().min(1, 'connectionId is required'),
  feature: z.string().min(1, 'feature name is required'),
  status: CapabilityStatusSchema,
  evidence: z.string().nullable().optional(),
  lastVerifiedAt: z.string().datetime({ message: 'lastVerifiedAt must be ISO 8601 UTC' }),
}).strict();

export type Capability = z.infer<typeof CapabilitySchema>;
