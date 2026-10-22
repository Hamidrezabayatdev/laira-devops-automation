import { z } from 'zod';

export const RunEventSchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  runId: z.string().min(1, 'runId is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  sequenceNumber: z.number().int().positive('sequenceNumber must be positive integer'),
  type: z.string().min(1, 'type is required'),
  safePayload: z.record(z.string(), z.unknown()),
  timestamp: z.string().datetime({ message: 'timestamp must be ISO 8601 UTC' }),
}).strict();

export type RunEvent = z.infer<typeof RunEventSchema>;
