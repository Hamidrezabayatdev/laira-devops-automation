import { z } from 'zod';
import { PreconditionSchema } from './plan.js';

export const WorkflowStepSchema = z.object({
  stepId: z.string().min(1),
  name: z.string().min(1),
  tool: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().default(30000),
}).strict();

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowOutputLimitsSchema = z.object({
  maxOutputTokens: z.number().int().positive().optional(),
  maxExecutionTimeMs: z.number().int().positive().optional(),
}).strict();

export type WorkflowOutputLimits = z.infer<typeof WorkflowOutputLimitsSchema>;

export const WorkflowVersionSchema = z.object({
  workflowId: z.string().min(1, 'workflowId is required'),
  version: z.number().int().positive('version must be a positive integer'),
  name: z.string().min(1, 'name is required'),
  description: z.string().min(1, 'description is required'),
  provenance: z.string().min(1, 'provenance is required (e.g. curated, owner_confirmed)'),
  allowedTools: z.array(z.string().min(1)).min(1, 'At least one allowed tool must be specified'),
  preconditions: z.array(PreconditionSchema).default([]),
  steps: z.array(WorkflowStepSchema).min(1, 'Workflow must have at least one step'),
  outputLimits: WorkflowOutputLimitsSchema.default({}),
  validationRules: z.array(z.string()).default([]),
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 UTC' }),
}).strict();

export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;
