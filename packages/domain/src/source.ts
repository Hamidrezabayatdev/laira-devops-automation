import { z } from 'zod';

export const MAX_SOURCE_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50 MiB limit from spec

export const GitSourceRefSchema = z.object({
  sourceType: z.literal('git'),
  repository: z.string().min(1, 'repository is required for git source'),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/i, 'commitSha must be 40 to 64 character hex sha'),
  artifactStoragePath: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
}).strict();

export const ArchiveSourceRefSchema = z.object({
  sourceType: z.literal('archive'),
  archiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'archiveDigest must be sha256:<64-hex>'),
  artifactStoragePath: z.string().min(1, 'artifactStoragePath is required for archive'),
  byteSize: z.number().int().positive().max(MAX_SOURCE_ARCHIVE_BYTES, 'archive exceeds 50 MiB limit'),
  fileName: z.string().min(1).optional(),
}).strict();

export const SourceRefSchema = z.discriminatedUnion('sourceType', [
  GitSourceRefSchema,
  ArchiveSourceRefSchema,
]);

export type GitSourceRef = z.infer<typeof GitSourceRefSchema>;
export type ArchiveSourceRef = z.infer<typeof ArchiveSourceRefSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;

export function getSourceImmutableDigest(source: SourceRef): string {
  return source.sourceType === 'git'
    ? source.commitSha.toLowerCase()
    : source.archiveDigest.toLowerCase();
}
