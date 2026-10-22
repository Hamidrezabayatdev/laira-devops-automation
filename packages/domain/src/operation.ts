import { z } from 'zod';

export const OperationStatusSchema = z.enum([
  'pending',
  'dispatched',
  'reconciling',
  'succeeded',
  'failed',
  'outcome_unknown',
]);

export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationSchema = z.object({
  operationId: z.string().min(1, 'operationId is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  planId: z.string().min(1, 'planId is required'),
  stepId: z.string().min(1, 'stepId is required'),
  correlationId: z.string().min(1, 'correlationId is required'),
  status: OperationStatusSchema,
  resourceReservations: z.array(z.string()).default([]),
  providerOperationId: z.string().nullable().optional(),
  dispatchClaimedAt: z.string().datetime({ message: 'dispatchClaimedAt must be ISO 8601 UTC' }),
  dispatchedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  error: z.string().nullable().optional(),
  reconciliationNotes: z.string().nullable().optional(),
}).strict();

export type Operation = z.infer<typeof OperationSchema>;
