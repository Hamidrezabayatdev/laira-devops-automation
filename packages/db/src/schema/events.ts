import { z } from 'zod';

/**
 * Strictly typed safe minimal event payloads.
 * No arbitrary payloads or secrets are permitted in persisted run events.
 */
export const RunStartedPayloadSchema = z.object({
  step: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const StepProgressPayloadSchema = z.object({
  step: z.string().min(1),
  progress: z.number().min(0).max(100),
  message: z.string(),
}).strict();

export const StepCompletedPayloadSchema = z.object({
  step: z.string().min(1),
  outcome: z.enum(['ok', 'skipped', 'warning']),
  summary: z.string(),
}).strict();

export const RunSucceededPayloadSchema = z.object({
  resultSummary: z.string(),
  completedAt: z.string(),
}).strict();

export const RunFailedPayloadSchema = z.object({
  errorCode: z.string(),
  errorMessage: z.string(),
}).strict();

export const RunCancelledPayloadSchema = z.object({
  reason: z.string(),
  cancelledAt: z.string(),
}).strict();

export const FixtureInspectionPayloadSchema = z.object({
  resourceCount: z.number().int().nonnegative(),
  verified: z.boolean(),
  summary: z.string(),
}).strict();

export const FixtureHeartbeatPayloadSchema = z.object({
  step: z.string(),
  timestamp: z.string(),
}).strict();

export const TypedEventPayloadSchemaMap = {
  run_started: RunStartedPayloadSchema,
  step_progress: StepProgressPayloadSchema,
  step_completed: StepCompletedPayloadSchema,
  run_succeeded: RunSucceededPayloadSchema,
  run_failed: RunFailedPayloadSchema,
  run_cancelled: RunCancelledPayloadSchema,
  fixture_inspection: FixtureInspectionPayloadSchema,
  fixture_heartbeat: FixtureHeartbeatPayloadSchema,
} as const;

export type SupportedEventType = keyof typeof TypedEventPayloadSchemaMap;

export function validateSafeEventPayload(
  type: string,
  payload: unknown
): Record<string, unknown> {
  const schema = (TypedEventPayloadSchemaMap as Record<string, z.ZodTypeAny>)[type];
  if (!schema) {
    throw new Error(`Unsupported event type: "${type}". Arbitrary event types/payloads are rejected.`);
  }
  return schema.parse(payload) as Record<string, unknown>;
}
