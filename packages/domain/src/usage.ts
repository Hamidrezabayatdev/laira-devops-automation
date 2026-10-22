import { z } from 'zod';

export const UsageRecordSchema = z.object({
  id: z.string().min(1, 'UsageRecord id is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  runId: z.string().min(1, 'runId is required'),
  model: z.string().min(1, 'model is required'),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().nullable().optional(),
  providerCost: z.number().nonnegative().nullable().optional(),
  providerCostUnit: z.string().nullable().optional(),
  catalogEstimateUsd: z.number().nonnegative(),
  source: z.enum(['boxapi', 'synthetic']),
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 UTC' }),
}).strict();

export type UsageRecord = z.infer<typeof UsageRecordSchema>;
