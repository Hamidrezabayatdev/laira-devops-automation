import { z } from 'zod';

export const FindingCategorySchema = z.enum([
  'observation',
  'hypothesis',
  'verified_cause',
  'remediation',
]);

export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingSchema = z.object({
  id: z.string().min(1, 'Finding id is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  statement: z.string().min(1, 'statement is required'),
  evidenceIds: z.array(z.string().min(1)).min(1, 'Finding must cite at least one evidence'),
  confidence: z.number().min(0).max(1, 'confidence must be between 0 and 1'),
  limitations: z.array(z.string()).default([]),
  category: FindingCategorySchema,
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 UTC' }),
}).strict();

export type Finding = z.infer<typeof FindingSchema>;
