import { z } from 'zod';

export const ResourceTypeSchema = z.enum([
  'app',
  'database',
  'disk',
  'bucket',
  'domain',
]);

export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const ResourceRefSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  connectionId: z.string().min(1, 'connectionId is required'),
  type: ResourceTypeSchema,
  providerResourceId: z.string().nullable().optional(),
  slug: z.string().min(1, 'slug is required').regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  displayName: z.string().min(1).optional(),
}).strict();

export type ResourceRef = z.infer<typeof ResourceRefSchema>;
